//! `.dreamer.md` import: resolve the target, plan what each card becomes, apply, undo, and the
//! watched drop folders. The parser is `crate::bundle`; the spec is docs/bundle-format.md.

use super::*;
use crate::bundle::{self, Bundle};
use crate::organize::{estimate_card_h, layout, CardBox, Rect, CARD_W};
use serde::Deserialize;
use serde_json::json;

#[derive(Serialize)]
pub struct VersionOpt {
    pub id: String,
    pub title: String,
}

#[derive(Serialize)]
pub struct ProjectOpt {
    pub slug: String,
    pub name: String,
    pub versions: Vec<VersionOpt>,
    pub open_version: Option<String>,
}

#[derive(Serialize)]
pub struct PlanCard {
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub title: String,
    pub stage: Stage,
    /// "new" | "update" | "replace" (a ghost from an earlier send of this bundle)
    pub action: &'static str,
    pub card_id: Option<String>,
    pub frame: Option<String>,
    pub has_build: bool,
}

#[derive(Serialize)]
pub struct ImportPlan {
    pub header: bundle::Header,
    pub project: String,
    pub version: Option<String>,
    pub frame: Option<String>,
    /// "project" / "version" when the bundle names one that doesn't exist (the pickers decide).
    pub unresolved: Vec<String>,
    pub projects: Vec<ProjectOpt>,
    /// Frame titles on the target version's canvas.
    pub frames: Vec<String>,
    pub cards: Vec<PlanCard>,
    pub warnings: Vec<String>,
}

/// What the dialog (or the caller) may override; None = the bundle's header, then the open one.
#[derive(Deserialize, Default, Debug)]
pub struct Target {
    pub project: Option<String>,
    pub version: Option<String>,
    /// Some("") = no default frame.
    pub frame: Option<String>,
    /// Drop / paste point in canvas coordinates (top-left of the first card).
    pub at: Option<(f64, f64)>,
    /// The project open in the UI.
    pub open_project: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct ImportResult {
    pub project: String,
    pub folder: Option<String>,
    pub created: Vec<String>,
    pub proposals: Vec<String>,
    /// Ghosts of an earlier send that were replaced (moved to Trash).
    pub replaced: Vec<String>,
    /// Frames created on the canvas.
    pub frames: Vec<String>,
    pub warnings: Vec<String>,
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

struct Resolved {
    slug: String,
    folder: Option<String>,
    frame: Option<String>,
    unresolved: Vec<String>,
}

impl Workspace {
    fn resolve_target(&self, b: &Bundle, t: &Target) -> Result<Resolved> {
        let projects = self.list_projects()?;
        let mut unresolved = Vec::new();
        let find = |key: &str| projects.iter().find(|p| p.slug == key || norm(&p.name) == norm(key) || p.slug == slugify(key)).map(|p| p.slug.clone());
        let open = t.open_project.clone().filter(|o| projects.iter().any(|p| &p.slug == o));
        let slug = if let Some(p) = t.project.as_deref().and_then(find) {
            p
        } else {
            let named = b.header.project.as_deref().and_then(find);
            if named.is_none() && b.header.project.is_some() {
                unresolved.push("project".to_string());
            }
            named.or(open).or_else(|| projects.iter().find(|p| !p.is_inbox).map(|p| p.slug.clone())).or_else(|| projects.first().map(|p| p.slug.clone())).ok_or_else(|| AppError::NotFound("a project".into()))?
        };
        let dir = self.existing_project_dir(&slug)?;
        let folders = Self::read_folders(&dir)?;
        let versions = versions_of(&folders);
        let by = |key: &str| versions.iter().find(|f| f.id == key || norm(&f.title) == norm(key)).map(|f| f.id.clone());
        let folder = if versions.is_empty() {
            None
        } else if let Some(v) = t.version.as_deref().and_then(by) {
            Some(v)
        } else {
            let named = b.header.version.as_deref().and_then(by);
            if named.is_none() && b.header.version.is_some() && !unresolved.contains(&"project".to_string()) {
                unresolved.push("version".into());
            }
            named.or_else(|| Self::open_version_in(&dir, &folders).map(|f| f.id))
        };
        let frame = match &t.frame {
            Some(f) => Some(f.trim().to_string()).filter(|f| !f.is_empty()),
            None => b.header.frame.clone(),
        };
        Ok(Resolved { slug, folder, frame, unresolved })
    }

    /// What importing `text` would do: the resolved target, and per card New / Update / Replace ghost.
    pub fn plan_bundle(&self, text: &str, t: &Target) -> Result<ImportPlan> {
        let b = bundle::parse(text).map_err(AppError::Invalid)?;
        let r = self.resolve_target(&b, t)?;
        let dir = self.existing_project_dir(&r.slug)?;
        let (cards, _) = Self::list_cards_in(&dir);
        let canvas = Self::read_canvas_at(&dir, r.folder.as_deref())?;
        let folders = Self::read_folders(&dir)?;
        let open = Self::open_version_in(&dir, &folders).map(|f| f.id);
        let projects = self
            .list_projects()?
            .into_iter()
            .map(|p| {
                let d = self.existing_project_dir(&p.slug).ok();
                let fs = d.as_ref().and_then(|d| Self::read_folders(d).ok()).unwrap_or_default();
                ProjectOpt {
                    open_version: d.as_ref().and_then(|d| Self::open_version_in(d, &fs)).map(|f| f.id),
                    versions: versions_of(&fs).into_iter().map(|f| VersionOpt { id: f.id.clone(), title: f.title.clone() }).collect(),
                    slug: p.slug,
                    name: p.name,
                }
            })
            .collect();
        let _ = open;
        let plan_cards = b
            .cards
            .iter()
            .map(|c| {
                let (action, card_id) = match self.match_card(&cards, &b, c) {
                    Some((id, true)) => ("replace", Some(id)),
                    Some((id, false)) => ("update", Some(id)),
                    None => ("new", None),
                };
                PlanCard {
                    r#ref: c.r#ref.clone(),
                    title: c.title.clone(),
                    stage: c.stage,
                    action,
                    card_id,
                    frame: c.frame.clone().or(r.frame.clone()),
                    has_build: c.build.is_some(),
                }
            })
            .collect();
        Ok(ImportPlan {
            project: r.slug,
            version: r.folder,
            frame: r.frame,
            unresolved: r.unresolved,
            projects,
            frames: canvas.frames.values().map(|f| f.title.clone()).filter(|t| !t.is_empty()).collect(),
            cards: plan_cards,
            warnings: b.warnings.clone(),
            header: b.header,
        })
    }

    /// The existing card a bundle card refers to: (id, is a ghost to replace).
    fn match_card(&self, cards: &[Card], b: &Bundle, c: &bundle::BCard) -> Option<(String, bool)> {
        if let Some(id) = &c.id {
            if cards.iter().any(|x| &x.meta.id == id) {
                return Some((id.clone(), false));
            }
        }
        cards
            .iter()
            .find(|x| x.meta.import.as_ref().is_some_and(|i| i.bundle_id == b.header.bundle_id && i.r#ref == c.r#ref))
            .map(|x| (x.meta.id.clone(), x.meta.ghost))
    }

    pub fn apply_bundle(&self, text: &str, t: &Target) -> Result<ImportResult> {
        let b = bundle::parse(text).map_err(AppError::Invalid)?;
        let r = self.resolve_target(&b, t)?;
        let slug = r.slug.clone();
        let dir = self.existing_project_dir(&slug)?;
        let (existing, _) = Self::list_cards_in(&dir);
        let mut res = ImportResult { project: slug.clone(), folder: r.folder.clone(), warnings: b.warnings.clone(), ..Default::default() };
        let mut canvas = Self::read_canvas_at(&dir, r.folder.as_deref())?;

        // 1. What each card becomes.
        enum Act {
            Update(String),
            New { replace: Option<String> },
        }
        let acts: Vec<Act> = b
            .cards
            .iter()
            .map(|c| match self.match_card(&existing, &b, c) {
                Some((id, false)) => Act::Update(id),
                Some((id, true)) => Act::New { replace: Some(id) },
                None => {
                    if let Some(id) = &c.id {
                        res.warnings.push(format!("{}: card id {id} was not found; imported as a new card.", c.r#ref));
                    }
                    Act::New { replace: None }
                }
            })
            .collect();

        // 2. Placement of the new cards: by frame, never on anything already there.
        let rect_of = |p: &Pos, id: &str| {
            let est = existing.iter().find(|c| c.meta.id == id).map_or(200.0, |c| estimate_card_h(c, CARD_W));
            Rect { x: p.x, y: p.y, w: p.w.unwrap_or(CARD_W), h: p.h.unwrap_or(est) }
        };
        let mut obstacles: Vec<Rect> = canvas.cards.iter().map(|(id, p)| rect_of(p, id)).collect();
        // A replaced ghost's place is free again (the ghost goes to Trash).
        for a in &acts {
            if let Act::New { replace: Some(id) } = a {
                if let Some(p) = canvas.cards.get(id) {
                    let old = rect_of(p, id);
                    obstacles.retain(|o| (o.x, o.y) != (old.x, old.y));
                }
            }
        }
        let frame_rects: Vec<Rect> = canvas.frames.values().map(|f| Rect { x: f.x, y: f.y, w: f.w, h: f.h }).collect();
        let content = obstacles.iter().chain(frame_rects.iter());
        let (right, top) = content.fold((f64::MIN, f64::MAX), |(r, t), o| (r.max(o.x + o.w), t.min(o.y)));
        let has_content = right > f64::MIN;
        let mut origin = t.at.unwrap_or(if has_content { (right + 120.0, top) } else { (0.0, 0.0) });
        let mut boxes: Vec<(usize, CardBox, Option<String>)> = Vec::new(); // card index, size, frame title
        for (i, (c, a)) in b.cards.iter().zip(&acts).enumerate() {
            if matches!(a, Act::New { .. }) {
                let tmp = Card { meta: Frontmatter { title: c.title.clone(), ..Default::default() }, body: c.body.clone() };
                let frame = c.frame.clone().or(r.frame.clone());
                boxes.push((i, CardBox { id: i.to_string(), w: CARD_W, h: estimate_card_h(&tmp, CARD_W) }, frame));
            }
        }
        let mut pos: BTreeMap<usize, (f64, f64)> = BTreeMap::new();
        let mut new_frames: Vec<String> = Vec::new();
        let mut order: Vec<String> = Vec::new(); // frame titles, first-seen order
        for (_, _, f) in &boxes {
            if let Some(f) = f.as_ref().filter(|f| !order.iter().any(|o| norm(o) == norm(f))) {
                order.push(f.clone());
            }
        }
        // 2a. Missing frames: new frames placed to the right of existing content.
        let missing: Vec<&String> = order.iter().filter(|f| !canvas.frames.values().any(|x| norm(&x.title) == norm(f))).collect();
        if !missing.is_empty() {
            let groups: Vec<Vec<CardBox>> = missing.iter().map(|f| boxes.iter().filter(|(_, _, bf)| bf.as_ref().is_some_and(|bf| norm(bf) == norm(f))).map(|(_, bx, _)| bx.clone()).collect()).collect();
            let all: Vec<Rect> = obstacles.iter().chain(frame_rects.iter()).copied().collect();
            let o = if t.at.is_some() { origin } else { (if has_content { right + 120.0 } else { 0.0 }, if has_content { top } else { 0.0 }) };
            let (rects, p) = layout(&groups, &[], &all, o);
            for (f, rect) in missing.iter().zip(&rects) {
                let id = ulid::Ulid::generate().to_string();
                let z = canvas.frames.values().map(|f| f.z).max().unwrap_or(0) + 1;
                canvas.frames.insert(id.clone(), Frame { x: rect.x, y: rect.y, w: rect.w, h: rect.h, title: (*f).clone(), color: None, z });
                new_frames.push(id);
                obstacles.push(*rect);
            }
            for (k, xy) in p {
                pos.insert(k.parse().unwrap(), xy);
            }
        }
        // 2b. Existing frames: inside the frame, around what is already in it. 2c. Loose: at the point.
        for f in order.iter().filter(|f| !missing.iter().any(|m| norm(m) == norm(f))) {
            let fr = canvas.frames.values().find(|x| norm(&x.title) == norm(f)).expect("frame exists").clone();
            let loose: Vec<CardBox> = boxes.iter().filter(|(_, _, bf)| bf.as_ref().is_some_and(|bf| norm(bf) == norm(f))).map(|(_, bx, _)| bx.clone()).collect();
            let (_, p) = layout(&[], &loose, &obstacles, (fr.x + 40.0, fr.y + 56.0));
            for bx in &loose {
                let xy = p[&bx.id];
                obstacles.push(Rect { x: xy.0, y: xy.1, w: bx.w, h: bx.h });
                pos.insert(bx.id.parse().unwrap(), xy);
            }
        }
        let loose: Vec<CardBox> = boxes.iter().filter(|(_, _, f)| f.is_none()).map(|(_, bx, _)| bx.clone()).collect();
        if !loose.is_empty() {
            if t.at.is_none() && !has_content {
                origin = (0.0, 0.0);
            }
            let (_, p) = layout(&[], &loose, &obstacles, origin);
            for bx in &loose {
                pos.insert(bx.id.parse().unwrap(), p[&bx.id]);
            }
        }
        if !new_frames.is_empty() {
            Self::write_canvas(&dir, r.folder.as_deref(), &canvas)?;
            res.frames = new_frames;
        }

        // 3. Write the cards, then the links (they need every id).
        let mut ids: Vec<Option<String>> = vec![None; b.cards.len()];
        let source = b.header.source.clone();
        let reason = format!("From bundle \"{}\" ({})", b.header.title, source);
        for (i, (c, a)) in b.cards.iter().zip(&acts).enumerate() {
            match a {
                Act::Update(id) => {
                    let mut p = json!({ "title": c.title, "body": c.body, "tags": c.tags, "stage": c.stage, "reason": reason, "created": now() });
                    if let Some(bd) = &c.build {
                        p["build"] = bd.clone();
                    }
                    self.write_proposal(&slug, id, &p)?;
                    res.proposals.push(id.clone());
                    ids[i] = Some(id.clone());
                }
                Act::New { replace } => {
                    let (x, y) = pos.get(&i).copied().unwrap_or((0.0, 0.0));
                    let (x, y) = match replace.as_ref().and_then(|id| canvas.cards.get(id)) {
                        Some(old) if !pos.contains_key(&i) => (old.x, old.y),
                        _ => (x, y),
                    };
                    if let Some(old) = replace {
                        self.trash_card(&slug, old, "replaced by a re-sent bundle")?;
                        res.replaced.push(old.clone());
                    }
                    let build = c.build.clone();
                    let card = self.create_card(
                        &slug,
                        NewCard {
                            title: Some(c.title.clone()),
                            body: Some(c.body.clone()),
                            stage: Some(c.stage),
                            tags: Some(c.tags.clone()),
                            fields: Some(c.fields.clone()),
                            source: Some(Source::Claude),
                            ghost: Some(true),
                            folder: r.folder.clone(),
                            x: Some(x),
                            y: Some(y),
                            import: Some(ImportRef { bundle_id: b.header.bundle_id.clone(), r#ref: c.r#ref.clone(), source: source.clone() }),
                            build,
                            ..Default::default()
                        },
                    )?;
                    res.created.push(card.meta.id.clone());
                    ids[i] = Some(card.meta.id);
                }
            }
        }
        let valid = |id: &str| Self::card_path(&dir, id).is_ok_and(|p| p.is_file());
        for (i, c) in b.cards.iter().enumerate() {
            let Some(id) = ids[i].as_ref().filter(|id| res.created.contains(id)) else { continue };
            let mut links = Vec::new();
            for l in &c.links {
                let to = b.cards.iter().position(|x| x.r#ref == l.to).and_then(|j| ids[j].clone()).or_else(|| Some(l.to.clone()).filter(|t| valid(t)));
                match to {
                    Some(to) => links.push(Link { to, label: l.label.clone() }),
                    None => res.warnings.push(format!("{}: link to \"{}\" dropped (no such card).", c.r#ref, l.to)),
                }
            }
            if !links.is_empty() {
                self.update_card(&slug, id, CardPatch { links: Some(links), ..Default::default() })?;
            }
        }
        Ok(res)
    }

    /// Undo of an import: new cards to Trash, new frames removed, proposals dropped, replaced ghosts back.
    pub fn undo_import(&self, res: &ImportResult) -> Result<()> {
        let dir = self.existing_project_dir(&res.project)?;
        for id in &res.created {
            let _ = self.trash_card(&res.project, id, "import undone");
        }
        for id in &res.proposals {
            self.delete_proposal(&res.project, id)?;
        }
        for id in &res.replaced {
            let _ = self.restore_card(&res.project, id);
        }
        if !res.frames.is_empty() {
            let mut c = Self::read_canvas_at(&dir, res.folder.as_deref())?;
            c.frames.retain(|id, _| !res.frames.contains(id));
            Self::write_canvas(&dir, res.folder.as_deref(), &c)?;
        }
        Ok(())
    }

    // ----- watched drop folders -----

    /// `<workspace>/import/` and each project's `<repo>/.dreamer/outbox/` (project slug for the latter).
    fn import_dirs(&self) -> Vec<(PathBuf, Option<String>)> {
        let mut v = vec![(self.root.join("import"), None)];
        for p in self.list_projects().unwrap_or_default() {
            if let Some(t) = self.project_meta(&p.slug).ok().and_then(|m| m.handoff_target).filter(|t| !t.trim().is_empty()) {
                v.push((PathBuf::from(t).join(".dreamer").join("outbox"), Some(p.slug)));
            }
        }
        v
    }

    /// New `*.dreamer.md` files waiting in the drop folders.
    pub fn scan_imports(&self) -> Vec<ImportOffer> {
        let mut out = Vec::new();
        for (dir, project) in self.import_dirs() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.filter_map(|e| e.ok()) {
                let path = e.path();
                if !path.is_file() || !path.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().ends_with(".dreamer.md")) {
                    continue;
                }
                let Some(b) = fs::read_to_string(&path).ok().and_then(|t| bundle::parse(&t).ok()) else { continue };
                out.push(ImportOffer { path: path.to_string_lossy().into_owned(), title: b.header.title, source: b.header.source, count: b.cards.len(), project: project.clone() });
            }
        }
        out
    }

    fn check_import_path(&self, path: &str) -> Result<PathBuf> {
        let p = PathBuf::from(path);
        let parent = p.parent().ok_or_else(|| AppError::Invalid("bad path".into()))?;
        if self.import_dirs().iter().any(|(d, _)| d == parent) { Ok(p) } else { Err(AppError::Invalid("not in an import folder".into())) }
    }

    pub fn read_import(&self, path: &str) -> Result<String> {
        let p = self.check_import_path(path)?;
        fs::read_to_string(&p).map_err(|e| AppError::io(format!("read {}", p.display()), e))
    }

    /// After an import or a dismissal: into `imported/` next to it, never deleted.
    pub fn archive_import(&self, path: &str) -> Result<()> {
        let p = self.check_import_path(path)?;
        let dest_dir = p.parent().unwrap().join("imported");
        fs::create_dir_all(&dest_dir).map_err(|e| AppError::io("create the imported folder", e))?;
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        let mut dest = dest_dir.join(&name);
        if dest.exists() {
            dest = dest_dir.join(format!("{}-{}", chrono::Local::now().format("%Y%m%d%H%M%S"), name));
        }
        fs::rename(&p, &dest).map_err(|e| AppError::io(format!("move {} to imported", p.display()), e))
    }
}

#[derive(Serialize)]
pub struct ImportOffer {
    pub path: String,
    pub title: String,
    pub source: String,
    pub count: usize,
    pub project: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const B: &str = "---\ndreamer_bundle: 1\nbundle_id: bb\ntitle: T\nsource: claude.ai\nframe: Ideas\n---\n<!-- card -->\n---\nref: a\ntitle: A\nlinks: [{to: b}]\n---\nbody a\n<!-- card -->\n---\nref: b\ntitle: B\nframe: Other\nbuild: {status: partial}\n---\nbody b\n";

    fn ws() -> (tempfile::TempDir, Workspace, String) {
        let d = tempfile::TempDir::new().unwrap();
        let ws = Workspace::open(d.path()).unwrap();
        let p = ws.create_project("Fish").unwrap();
        (d, ws, p.slug)
    }

    #[test]
    fn import_places_ghosts_in_frames_updates_on_resend_and_undoes() {
        let (_d, ws, slug) = ws();
        let t = Target { open_project: Some(slug.clone()), ..Default::default() };
        let plan = ws.plan_bundle(B, &t).unwrap();
        assert_eq!(plan.project, slug);
        assert!(plan.cards.iter().all(|c| c.action == "new"));
        let res = ws.apply_bundle(B, &t).unwrap();
        assert_eq!((res.created.len(), res.frames.len()), (2, 2));
        let a = ws.read_card(&slug, &res.created[0]).unwrap();
        assert!(a.meta.ghost && a.meta.source == Source::Claude);
        assert_eq!(a.meta.import.as_ref().unwrap().r#ref, "a");
        assert_eq!(a.meta.links[0].to, res.created[1]);
        assert!(ws.read_card(&slug, &res.created[1]).unwrap().meta.extra.contains_key("build"));
        // No two cards overlap, each sits inside its frame.
        let d = ws.load_project(&slug).unwrap();
        let cv = &d.canvases[res.folder.as_ref().unwrap()];
        let (pa, pb) = (&cv.cards[&res.created[0]], &cv.cards[&res.created[1]]);
        assert!(pa.x + CARD_W <= pb.x || pb.x + CARD_W <= pa.x || pa.y != pb.y);
        let fa = cv.frames.values().find(|f| f.title == "Ideas").unwrap();
        assert!(pa.x >= fa.x && pa.x + CARD_W <= fa.x + fa.w);
        // Re-sent while still a ghost: replaced. After keeping one: an update proposal.
        let again = ws.plan_bundle(B, &t).unwrap();
        assert!(again.cards.iter().all(|c| c.action == "replace"));
        ws.update_card(&slug, &res.created[0], CardPatch { ghost: Some(false), ..Default::default() }).unwrap();
        let again = ws.plan_bundle(B, &t).unwrap();
        assert_eq!((again.cards[0].action, again.cards[1].action), ("update", "replace"));
        let r2 = ws.apply_bundle(B, &t).unwrap();
        assert_eq!((r2.created.len(), r2.proposals.len(), r2.replaced.len(), r2.frames.len()), (1, 1, 1, 0));
        assert!(ws.read_proposal(&slug, &res.created[0]).unwrap()["build"].is_null());
        ws.undo_import(&r2).unwrap();
        assert!(ws.read_proposal(&slug, &res.created[0]).is_none());
        assert!(ws.read_card(&slug, &res.created[1]).is_ok());
    }

    #[test]
    fn unknown_project_is_reported_and_drop_folder_is_archived_not_deleted() {
        let (d, ws, slug) = ws();
        let text = B.replace("title: T", "title: T\nproject: Nowhere");
        let t = Target { open_project: Some(slug.clone()), ..Default::default() };
        assert_eq!(ws.plan_bundle(&text, &t).unwrap().unresolved, ["project"]);
        let inbox = d.path().join("import");
        fs::create_dir_all(&inbox).unwrap();
        let f = inbox.join("x.dreamer.md");
        fs::write(&f, B).unwrap();
        let offers = ws.scan_imports();
        assert_eq!((offers.len(), offers[0].count), (1, 2));
        assert!(ws.read_import("/elsewhere/x.dreamer.md").is_err());
        ws.archive_import(&offers[0].path).unwrap();
        assert!(!f.exists() && inbox.join("imported/x.dreamer.md").exists());
    }
}
