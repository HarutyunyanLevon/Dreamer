//! Trash: delete, restore, empty.
use super::*;

impl Workspace {

    pub(super) fn trash_dir(dir: &Path) -> PathBuf {
        dir.join("trash")
    }

    pub(super) fn read_trash(dir: &Path) -> Result<TrashIndex> {
        read_json_or_default(&Self::trash_dir(dir).join("trash.json"))
    }

    pub(super) fn write_trash(dir: &Path, idx: &TrashIndex) -> Result<()> {
        write_json(&Self::trash_dir(dir).join("trash.json"), idx)
    }

    /// Deleting never destroys: the card moves to the project's Trash, labeled "deleted".
    pub fn delete_card(&self, slug: &str, id: &str) -> Result<TrashItem> {
        self.trash_card(slug, id, "deleted")
    }

    pub fn trash_card(&self, slug: &str, id: &str, reason: &str) -> Result<TrashItem> {
        self.writable()?;
        let dir = self.existing_project_dir(slug)?;
        let src = Self::card_path(&dir, id)?;
        let card = Self::read_card_file(&src, id)?;
        let mut canvas = Self::read_canvas(&dir)?;
        let item = TrashItem {
            id: id.to_string(),
            title: card.meta.title.clone(),
            stage: card.meta.stage,
            reason: reason.to_string(),
            deleted_at: now(),
            pos: canvas.cards.get(id).copied(),
        };
        let tdir = Self::trash_dir(&dir);
        fs::create_dir_all(&tdir).map_err(|e| AppError::io("create trash", e))?;
        fs::rename(&src, tdir.join(format!("{id}.md"))).map_err(|e| AppError::io(format!("move card {id} to trash"), e))?;
        let variants = dir.join("cards").join(format!("{id}.variants"));
        if variants.is_dir() {
            fs::rename(&variants, tdir.join(format!("{id}.variants"))).map_err(|e| AppError::io("move variants to trash", e))?;
        }
        let _ = fs::remove_file(Self::proposal_path(&dir, id)?);
        let mut idx = Self::read_trash(&dir)?;
        idx.items.retain(|i| i.id != id);
        idx.items.push(item.clone());
        Self::write_trash(&dir, &idx)?;
        if canvas.cards.remove(id).is_some() {
            Self::write_canvas(&dir, &canvas)?;
        }
        Ok(item)
    }

    pub fn list_trash(&self, slug: &str) -> Result<Vec<TrashItem>> {
        let dir = self.existing_project_dir(slug)?;
        Ok(Self::read_trash(&dir)?.items)
    }

    /// Restores a trashed card; returns it.
    pub fn restore_item(&self, slug: &str, id: &str) -> Result<Value> {
        serde_json::to_value(self.restore_card(slug, id)?).map_err(|e| AppError::Parse { context: "card".into(), message: e.to_string() })
    }

    pub fn restore_card(&self, slug: &str, id: &str) -> Result<Card> {
        self.writable()?;
        let dir = self.existing_project_dir(slug)?;
        check_id(id)?;
        let mut idx = Self::read_trash(&dir)?;
        let Some(pos_in_idx) = idx.items.iter().position(|i| i.id == id) else {
            return Err(AppError::NotFound(format!("trash item {id}")));
        };
        let item = idx.items[pos_in_idx].clone();
        let tdir = Self::trash_dir(&dir);
        let dest = Self::card_path(&dir, id)?;
        if dest.exists() {
            return Err(AppError::Invalid(format!("card {id} already exists")));
        }
        fs::rename(tdir.join(format!("{id}.md")), &dest).map_err(|e| AppError::io(format!("restore card {id}"), e))?;
        let tv = tdir.join(format!("{id}.variants"));
        if tv.is_dir() {
            fs::rename(&tv, dir.join("cards").join(format!("{id}.variants"))).map_err(|e| AppError::io("restore variants", e))?;
        }
        let mut canvas = Self::read_canvas(&dir)?;
        let pos = item.pos.unwrap_or_else(|| Self::next_free_pos(&canvas));
        canvas.cards.insert(id.to_string(), pos);
        Self::write_canvas(&dir, &canvas)?;
        idx.items.remove(pos_in_idx);
        Self::write_trash(&dir, &idx)?;
        let mut card = Self::read_card_file(&dest, id)?;
        // A restored role card yields its role if another card took it meanwhile.
        if card.meta.role.as_deref().is_some_and(|r| Self::role_card(&dir, r, Some(id)).is_some()) {
            card.meta.role = None;
            Self::write_card_file(&dest, &card)?;
        }
        Ok(card)
    }

    /// Permanently remove everything in the Trash. Callers must have confirmed with the user.
    pub fn empty_trash(&self, slug: &str) -> Result<usize> {
        self.writable()?;
        let dir = self.existing_project_dir(slug)?;
        let tdir = Self::trash_dir(&dir);
        let mut n = 0;
        if let Ok(rd) = fs::read_dir(&tdir) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.file_name().is_some_and(|f| f == "trash.json") {
                    continue;
                }
                let res = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
                res.map_err(|e| AppError::io(format!("remove {}", p.display()), e))?;
                if p.extension().is_some_and(|x| x == "md") {
                    n += 1;
                }
            }
        }
        Self::write_trash(&dir, &TrashIndex::default())?;
        Self::sweep_media(&dir)?;
        // An artifact's files go with its card, once the card is gone for good.
        let cards = dir.join("cards");
        crate::artifacts::sweep(&dir, &|id| cards.join(format!("{id}.md")).is_file());
        // Snapshots of cards that are gone for good.
        if let Ok(rd) = fs::read_dir(&cards) {
            for e in rd.filter_map(|e| e.ok()) {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.strip_suffix(".built.md").is_some_and(|id| !cards.join(format!("{id}.md")).is_file()) {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
        Ok(n)
    }
}
