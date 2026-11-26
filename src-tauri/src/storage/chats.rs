//! Chat threads, one file per card.
use super::*;

impl Workspace {

    /// `thread` is a card id, or "project" for the project-level thread.
    pub(super) fn chat_path(&self, slug: &str, thread: &str) -> Result<PathBuf> {
        if thread != "project" {
            check_id(thread)?;
        }
        Ok(self.existing_project_dir(slug)?.join("chats").join(format!("{thread}.json")))
    }

    /// The saved thread, or an empty one. The shape is the UI's business; Rust stores it as-is.
    pub fn load_chat(&self, slug: &str, thread: &str) -> Result<Value> {
        let path = self.chat_path(slug, thread)?;
        match fs::read_to_string(&path) {
            Ok(t) => serde_json::from_str(&t).map_err(|e| AppError::Parse { context: path.display().to_string(), message: e.to_string() }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({ "version": 1, "messages": [] })),
            Err(e) => Err(AppError::io(format!("read {}", path.display()), e)),
        }
    }

    /// The UI saves `sessionId` and `messages`; the keys in `RUST_OWNED_CHAT_KEYS` (context snapshot,
    /// usage, summary) belong to Rust and survive a UI save untouched.
    pub fn save_chat(&self, slug: &str, thread: &str, data: &Value) -> Result<()> {
        let path = self.chat_path(slug, thread)?;
        let mut data = data.clone();
        if let (Some(out), Ok(old)) = (data.as_object_mut(), self.load_chat(slug, thread)) {
            for k in crate::ctx::RUST_OWNED_CHAT_KEYS {
                if let Some(v) = old.get(*k) {
                    out.insert((*k).into(), v.clone());
                }
            }
        }
        self.write_chat(&path, &data)
    }

    pub(super) fn write_chat(&self, path: &Path, data: &Value) -> Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| AppError::io("create chats folder", e))?;
        }
        write_json(path, data)
    }

    /// Read-modify-write of a thread file for Rust-owned fields (ctx, usage, summary).
    pub fn update_chat(&self, slug: &str, thread: &str, f: impl FnOnce(&mut serde_json::Map<String, Value>)) -> Result<()> {
        let path = self.chat_path(slug, thread)?;
        let mut data = self.load_chat(slug, thread)?;
        if !data.is_object() {
            data = serde_json::json!({ "version": 1, "messages": [] });
        }
        f(data.as_object_mut().expect("object"));
        self.write_chat(&path, &data)
    }

    /// The project's memory file (`memory.md`), trimmed; None when absent or blank.
    pub fn read_memory(&self, slug: &str) -> Option<String> {
        let t = fs::read_to_string(self.existing_project_dir(slug).ok()?.join("memory.md")).ok()?;
        let t = t.trim();
        (crate::memory::has_bullets(t)).then(|| t.to_string())
    }

    /// Card threads that have a file, most recently written first (the project thread excluded).
    pub fn list_chats(&self, slug: &str) -> Result<Vec<String>> {
        let dir = self.existing_project_dir(slug)?.join("chats");
        let Ok(rd) = fs::read_dir(&dir) else { return Ok(vec![]) };
        let mut out: Vec<(std::time::SystemTime, String)> = rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let id = name.strip_suffix(".json")?.to_string();
                if id == "project" || check_id(&id).is_err() {
                    return None;
                }
                let t = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                Some((t, id))
            })
            .collect();
        out.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(out.into_iter().map(|(_, id)| id).collect())
    }

    /// "Reset chat": clears one thread (and only that one). A user action with confirmation.
    pub fn reset_chat(&self, slug: &str, thread: &str) -> Result<()> {
        let path = self.chat_path(slug, thread)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::io(format!("reset {}", path.display()), e)),
        }
    }
}
