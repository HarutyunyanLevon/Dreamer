//! Card files, Claude edit proposals, frames, attachments.
use super::*;

impl Workspace {

    pub(super) fn card_path(dir: &Path, id: &str) -> Result<PathBuf> {
        check_id(id)?;
        Ok(dir.join("cards").join(format!("{id}.md")))
    }

    pub(super) fn read_card_file(path: &Path, id: &str) -> Result<Card> {
        let text = fs::read_to_string(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound(format!("card {id}"))
            } else {
                AppError::io(format!("read {}", path.display()), e)
            }
        })?;
        parse_card(&text, id)
    }

    pub(super) fn write_card_file(path: &Path, card: &Card) -> Result<()> {
        atomic_write(path, serialize_card(card)?.as_bytes())
    }

    pub(super) fn list_cards_in(dir: &Path) -> (Vec<Card>, Vec<String>) {
        let mut cards = Vec::new();
        let mut warnings = Vec::new();
        let Ok(rd) = fs::read_dir(dir.join("cards")) else { return (cards, warnings) };
        for entry in rd.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() || path.extension().is_none_or(|x| x != "md") {
                continue;
            }
            let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
            if stem.starts_with('.') || stem.ends_with(".built") {
                continue;
            }
            match check_id(&stem).and_then(|_| Self::read_card_file(&path, &stem)) {
                Ok(c) => cards.push(c),
                Err(e) => warnings.push(format!("{stem}.md: {e}")),
            }
        }
        cards.sort_by(|a, b| a.meta.created.cmp(&b.meta.created).then(a.meta.id.cmp(&b.meta.id)));
        (cards, warnings)
    }

    /// Load everything the canvas needs. Cards created outside the app get a position.
    pub fn load_project(&self, slug: &str) -> Result<ProjectData> {
        let dir = self.existing_project_dir(slug)?;
        let meta = read_json_or_default_meta(&dir.join("project.json"), slug)?;
        let mut canvas = Self::read_canvas(&dir)?;
        let (cards, warnings) = Self::list_cards_in(&dir);
        let before = canvas.clone();
        let live: std::collections::HashSet<&str> = cards.iter().map(|c| c.meta.id.as_str()).collect();
        canvas.cards.retain(|id, _| live.contains(id.as_str()));
        for c in &cards {
            if !canvas.cards.contains_key(&c.meta.id) {
                let p = Self::next_free_pos(&canvas);
                canvas.cards.insert(c.meta.id.clone(), p);
            }
        }
        if canvas != before && self.read_only().is_none() {
            Self::write_canvas(&dir, &canvas)?;
        }
        let proposals = Self::read_proposals(&dir, &live);
        Ok(ProjectData { slug: slug.into(), meta, canvas, cards, proposals, warnings })
    }

    // ----- Claude edit proposals (cards/<id>.proposal.json, never inside the card file) -----

    pub(super) fn proposal_path(dir: &Path, id: &str) -> Result<PathBuf> {
        check_id(id)?;
        Ok(dir.join("cards").join(format!("{id}.proposal.json")))
    }

    pub(super) fn read_proposals(dir: &Path, live: &std::collections::HashSet<&str>) -> BTreeMap<String, Value> {
        let mut out = BTreeMap::new();
        let Ok(rd) = fs::read_dir(dir.join("cards")) else { return out };
        for entry in rd.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".proposal.json") else { continue };
            if !live.contains(id) {
                continue;
            }
            if let Some(v) = fs::read_to_string(entry.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                out.insert(id.to_string(), v);
            }
        }
        out
    }

    /// One pending proposal per card: a new one replaces the old.
    pub fn write_proposal(&self, slug: &str, id: &str, proposal: &Value) -> Result<()> {
        let dir = self.existing_project_dir(slug)?;
        if !Self::card_path(&dir, id)?.is_file() {
            return Err(AppError::NotFound(format!("card {id}")));
        }
        write_json(&Self::proposal_path(&dir, id)?, proposal)
    }

    /// The card's pending proposal, if any.
    pub fn read_proposal(&self, slug: &str, id: &str) -> Option<Value> {
        let dir = self.existing_project_dir(slug).ok()?;
        serde_json::from_str(&fs::read_to_string(Self::proposal_path(&dir, id).ok()?).ok()?).ok()
    }

    /// Kept (after the UI applied it) or dismissed: either way the file goes. Missing is fine.
    pub fn delete_proposal(&self, slug: &str, id: &str) -> Result<()> {
        let dir = self.existing_project_dir(slug)?;
        match fs::remove_file(Self::proposal_path(&dir, id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::io(format!("remove the proposal for card {id}"), e)),
        }
    }

    /// The title of the frame each card is in (its centre inside the frame; topmost frame wins).
    /// Cards with no position or no frame are left out.
    pub fn card_frames(&self, slug: &str) -> Result<std::collections::HashMap<String, String>> {
        let canvas = Self::read_canvas(&self.existing_project_dir(slug)?)?;
        let mut out = std::collections::HashMap::new();
        let mut frames: Vec<&crate::model::Frame> = canvas.frames.values().collect();
        frames.sort_by(|a, b| b.z.cmp(&a.z));
        for (id, p) in &canvas.cards {
            // Defaults mirror CARD_W / CARD_H in src/components/cardGeometry.ts.
            let (cx, cy) = (p.x + p.w.unwrap_or(236.0) / 2.0, p.y + p.h.unwrap_or(150.0) / 2.0);
            if let Some(f) = frames.iter().find(|f| cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h) {
                let title = if f.title.trim().is_empty() { "Untitled frame".to_string() } else { f.title.trim().to_string() };
                out.insert(id.clone(), title);
            }
        }
        Ok(out)
    }

    /// `None`/empty = no role. Known roles are "tech" and "decisions"; only one live card per
    /// project may hold each.
    pub(super) fn check_role(dir: &Path, role: Option<String>, except: Option<&str>) -> Result<Option<String>> {
        let Some(role) = role.map(|r| r.trim().to_lowercase()).filter(|r| !r.is_empty()) else { return Ok(None) };
        if !ROLES.contains(&role.as_str()) {
            return Err(AppError::Invalid(format!("unknown card role {role:?}")));
        }
        if let Some(other) = Self::role_card(dir, &role, except) {
            let what = if role == ROLE_TECH { "a Tech & constraints card" } else if role == ROLE_DECISIONS { "a Project decisions card" } else { "a From Claude Code card" };
            return Err(AppError::Invalid(format!("this project already has {what} ({other})")));
        }
        Ok(Some(role))
    }

    /// The id of the live card holding `role`, other than `except`.
    pub(super) fn role_card(dir: &Path, role: &str, except: Option<&str>) -> Option<String> {
        Self::list_cards_in(dir).0.into_iter().find(|c| c.meta.role.as_deref() == Some(role) && Some(c.meta.id.as_str()) != except).map(|c| c.meta.id)
    }

    pub(super) fn check_attachments(list: Vec<Attachment>) -> Result<Vec<Attachment>> {
        for a in &list {
            a.validate().map_err(AppError::Invalid)?;
        }
        Ok(merge_attachments([list.as_slice()]))
    }

    /// Checklist items get an id when they lack one (or share one).
    pub(super) fn check_items(mut items: Vec<ChecklistItem>) -> Vec<ChecklistItem> {
        let mut seen = std::collections::HashSet::new();
        for it in &mut items {
            if it.id.trim().is_empty() || !seen.insert(it.id.clone()) {
                it.id = ulid::Ulid::generate().to_string();
                seen.insert(it.id.clone());
            }
        }
        items
    }

    pub fn create_card(&self, slug: &str, new: NewCard) -> Result<Card> {
        let dir = self.existing_project_dir(slug)?;
        let role = Self::check_role(&dir, new.role, None)?;
        let attachments = Self::check_attachments(new.attachments.unwrap_or_default())?;
        let id = ulid::Ulid::generate().to_string();
        let stamp = now();
        let title = new.title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled".into());
        let card = Card {
            meta: Frontmatter {
                id: id.clone(),
                title,
                kind: new.kind.unwrap_or_default(),
                role,
                items: Self::check_items(new.items.unwrap_or_default()),
                attachments,
                stage: new.stage.unwrap_or_default(),
                tags: new.tags.unwrap_or_default(),
                fields: new.fields.unwrap_or_default(),
                created: stamp.clone(),
                updated: stamp,
                source: new.source.unwrap_or_default(),
                // Claude's cards are always ghosts until accepted; the user's never are unless asked.
                ghost: new.ghost.unwrap_or(false),
                links: new.links.unwrap_or_default(),
                branch: new.branch,
                extra: new.merged_from.map(|ids| ("merged_from".to_string(), serde_json::json!(ids))).into_iter().collect(),
                import: new.import,
            },
            body: norm_body(&new.body.unwrap_or_default()),
        };
        Self::write_card_file(&Self::card_path(&dir, &id)?, &card)?;
        let mut canvas = Self::read_canvas(&dir)?;
        let mut pos = match (new.x, new.y) {
            (Some(x), Some(y)) => Pos::at(x, y),
            _ => Self::next_free_pos(&canvas),
        };
        // New cards (including Claude's ghosts) land on top of the stack.
        pos.z = Some(canvas.max_z() + 1);
        canvas.cards.insert(id, pos);
        Self::write_canvas(&dir, &canvas)?;
        Ok(card)
    }

    pub fn read_card(&self, slug: &str, id: &str) -> Result<Card> {
        let dir = self.existing_project_dir(slug)?;
        Self::read_card_file(&Self::card_path(&dir, id)?, id)
    }

    pub fn update_card(&self, slug: &str, id: &str, patch: CardPatch) -> Result<Card> {
        let dir = self.existing_project_dir(slug)?;
        let path = Self::card_path(&dir, id)?;
        let mut card = Self::read_card_file(&path, id)?;
        if let Some(t) = patch.title {
            let t = t.trim();
            card.meta.title = if t.is_empty() { "Untitled".into() } else { t.to_string() };
        }
        if let Some(b) = patch.body {
            card.body = norm_body(&b);
        }
        if let Some(s) = patch.stage {
            card.meta.stage = s;
        }
        if let Some(t) = patch.tags {
            card.meta.tags = t;
        }
        if let Some(f) = patch.fields {
            card.meta.fields = f;
        }
        if let Some(l) = patch.links {
            card.meta.links = l;
        }
        if let Some(g) = patch.ghost {
            card.meta.ghost = g;
        }
        if let Some(k) = patch.kind {
            card.meta.kind = k;
        }
        if let Some(r) = patch.role {
            card.meta.role = Self::check_role(&dir, Some(r), Some(id))?;
        }
        if let Some(i) = patch.items {
            card.meta.items = Self::check_items(i);
        }
        if let Some(a) = patch.attachments {
            card.meta.attachments = Self::check_attachments(a)?;
        }
        card.meta.updated = now();
        Self::write_card_file(&path, &card)?;
        Ok(card)
    }

    /// Read, change and write back one card (bumping `updated`).
    pub(super) fn edit_card(&self, slug: &str, id: &str, f: impl FnOnce(&mut Card) -> Result<()>) -> Result<Card> {
        let dir = self.existing_project_dir(slug)?;
        let path = Self::card_path(&dir, id)?;
        let mut card = Self::read_card_file(&path, id)?;
        f(&mut card)?;
        card.meta.updated = now();
        Self::write_card_file(&path, &card)?;
        Ok(card)
    }

    // ----- attachments -----

    /// Appends an attachment (a fresh id when it has none or a taken one). Returns the card.
    pub fn add_attachment(&self, slug: &str, id: &str, att: Attachment) -> Result<Card> {
        att.validate().map_err(AppError::Invalid)?;
        self.edit_card(slug, id, |c| {
            let mut att = att;
            if att.id().trim().is_empty() || c.meta.attachments.iter().any(|a| a.id() == att.id()) {
                att.set_id(ulid::Ulid::generate().to_string());
            }
            c.meta.attachments.push(att);
            Ok(())
        })
    }

    pub fn update_attachment(&self, slug: &str, id: &str, att_id: &str, patch: &Value) -> Result<Card> {
        self.edit_card(slug, id, |c| {
            let a = c.meta.attachments.iter_mut().find(|a| a.id() == att_id).ok_or_else(|| AppError::NotFound(format!("attachment {att_id}")))?;
            *a = patch_attachment(a, patch).map_err(AppError::Invalid)?;
            Ok(())
        })
    }

    /// Drops the record only; the media file stays (so undo works) until the Trash is emptied.
    pub fn remove_attachment(&self, slug: &str, id: &str, att_id: &str) -> Result<Card> {
        self.edit_card(slug, id, |c| {
            let before = c.meta.attachments.len();
            c.meta.attachments.retain(|a| a.id() != att_id);
            if c.meta.attachments.len() == before {
                return Err(AppError::NotFound(format!("attachment {att_id}")));
            }
            Ok(())
        })
    }

    /// Listed ids first, in that order; any attachment not listed keeps its relative order after them.
    pub fn reorder_attachments(&self, slug: &str, id: &str, ids: &[String]) -> Result<Card> {
        self.edit_card(slug, id, |c| {
            if let Some(bad) = ids.iter().find(|i| !c.meta.attachments.iter().any(|a| a.id() == i.as_str())) {
                return Err(AppError::NotFound(format!("attachment {bad}")));
            }
            let mut rest = std::mem::take(&mut c.meta.attachments);
            let mut out = Vec::with_capacity(rest.len());
            for i in ids {
                if let Some(p) = rest.iter().position(|a| a.id() == i.as_str()) {
                    out.push(rest.remove(p));
                }
            }
            out.append(&mut rest);
            c.meta.attachments = out;
            Ok(())
        })
    }
}
