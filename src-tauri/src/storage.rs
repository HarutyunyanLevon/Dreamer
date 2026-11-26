//! Plain-file storage: workspace, projects, cards, canvas, trash. One canvas per project.
//! Everything is human-readable and git-friendly; all writes are atomic (temp file + rename).

use crate::error::{AppError, Result};
use crate::model::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

mod import;
mod migrate;
pub use import::{ImportOffer, ImportPlan, ImportResult, Target};

/// Waits between retries of a file operation that hit "in use" (about 1.5s in total).
const RETRY_DELAYS_MS: [u64; 6] = [50, 100, 200, 300, 400, 500];

/// Errors that usually clear within moments on Windows when something briefly holds a file or
/// folder open (a file watcher, the search indexer, antivirus): access denied (5), sharing
/// violation (32), lock violation (33), and "directory not empty" (145) mid-delete.
fn is_transient(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33 | 145))
}

/// Runs `f`, retrying after short waits while it fails with a transient "in use" error.
fn retry_io<T>(mut f: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut delays = RETRY_DELAYS_MS.iter();
    loop {
        match f() {
            Err(e) if is_transient(&e) => match delays.next() {
                Some(ms) => std::thread::sleep(Duration::from_millis(*ms)),
                None => return Err(e),
            },
            r => return r,
        }
    }
}

/// Clears the read-only flag on everything under `dir` (best effort), so a permanent delete
/// doesn't stop at read-only files such as git objects.
fn clear_readonly(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.filter_map(|e| e.ok()) {
        let path = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.is_dir() {
                clear_readonly(&path);
            } else if meta.permissions().readonly() {
                let mut p = meta.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                p.set_readonly(false);
                let _ = fs::set_permissions(&path, p);
            }
        }
    }
}

/// Workspace roots that open read-only (a failed migration), with the banner text.
static READ_ONLY: std::sync::Mutex<Vec<(PathBuf, String)>> = std::sync::Mutex::new(Vec::new());

fn read_only_reason(path: &Path) -> Option<String> {
    READ_ONLY.lock().ok()?.iter().find(|(r, _)| path.starts_with(r)).map(|(_, m)| m.clone())
}

const GRID_DX: f64 = 264.0;
const GRID_DY: f64 = 196.0;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------- low-level helpers ----------

/// Write `bytes` to `path` atomically: temp file in the same directory, fsync, rename over the target.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    if let Some(why) = read_only_reason(path) {
        return Err(AppError::Invalid(format!("Dreamer is read-only right now. {why}")));
    }
    let dir = path.parent().ok_or_else(|| AppError::Invalid(format!("no parent dir for {}", path.display())))?;
    fs::create_dir_all(dir).map_err(|e| AppError::io(format!("create {}", dir.display()), e))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{}.{}.tmp", name, ulid::Ulid::generate()));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::io(format!("write {}", path.display()), e));
    }
    Ok(())
}

pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let mut s = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::Parse { context: path.display().to_string(), message: e.to_string() })?;
    s.push('\n');
    atomic_write(path, s.as_bytes())
}

/// Read JSON; a missing file gives the default. A corrupt file is copied to `<name>.bak` and the default is used,
/// so one bad hand-edit can never stop the app from starting (and the bad file is not silently lost).
fn read_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(e) => return Err(AppError::io(format!("read {}", path.display()), e)),
    };
    let text = text.trim_start_matches('\u{feff}');
    match serde_json::from_str::<T>(text) {
        Ok(v) => Ok(v),
        Err(_) => {
            let bak = path.with_extension("json.bak");
            let _ = fs::copy(path, &bak);
            Ok(T::default())
        }
    }
}

/// Only lowercase letters, digits, '-' and '_' (prevents path traversal through project slugs).
pub fn check_slug(slug: &str) -> Result<()> {
    let ok = !slug.is_empty()
        && slug.len() <= 80
        && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err(AppError::Invalid(format!("invalid project id: {slug:?}"))) }
}

pub fn check_id(id: &str) -> Result<()> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err(AppError::Invalid(format!("invalid card id: {id:?}"))) }
}

pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.chars().flat_map(|c| c.to_lowercase()) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "project".into() } else { out.chars().take(60).collect() }
}

// ---------- card file format ----------

/// Split `---` frontmatter from the body. Accepts CRLF (Windows editors, git autocrlf) and a BOM.
pub fn parse_card(text: &str, fallback_id: &str) -> Result<Card> {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut fm_src: Option<&str> = None;
    let mut body: &str = text.as_str();
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(after) = rest.strip_prefix("---\n") {
            fm_src = Some(""); // empty frontmatter
            body = after;
        } else if let Some(i) = rest.find("\n---\n") {
            fm_src = Some(&rest[..i]);
            body = &rest[i + 5..];
        } else if let Some(r) = rest.strip_suffix("\n---") {
            fm_src = Some(r); // closing delimiter at end of file, no body
            body = "";
        }
    }
    let mut meta: Frontmatter = match fm_src {
        Some(src) if !src.trim().is_empty() => serde_yaml::from_str(src).map_err(|e| AppError::Parse {
            context: format!("card {fallback_id}"),
            message: e.to_string(),
        })?,
        _ => Frontmatter::default(),
    };
    // The file name is the authority for the id (copying a file must not create duplicate ids).
    meta.id = fallback_id.to_string();
    meta.migrate_legacy_fields();
    if meta.title.trim().is_empty() {
        meta.title = body
            .lines()
            .find_map(|l| l.trim().strip_prefix("# ").map(|t| t.trim().to_string()))
            .unwrap_or_else(|| "Untitled".into());
    }
    Ok(Card { meta, body: norm_body(body) })
}

/// Leading/trailing blank lines are formatting, not content: bodies are stored with exactly one final newline on disk.
fn norm_body(b: &str) -> String {
    b.trim_start_matches('\n').trim_end_matches('\n').to_string()
}

pub fn serialize_card(card: &Card) -> Result<String> {
    let yaml = serde_yaml::to_string(&card.meta)
        .map_err(|e| AppError::Parse { context: format!("card {}", card.meta.id), message: e.to_string() })?;
    let mut out = String::from("---\n");
    out.push_str(&yaml);
    if !yaml.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("---\n\n");
    out.push_str(card.body.trim_end_matches('\n'));
    out.push('\n');
    Ok(out)
}

// ---------- workspace ----------

#[derive(Clone, Debug)]
pub struct Workspace {
    pub root: PathBuf,
}

impl Workspace {
    /// Open (and, if needed, create) a workspace folder. An older layout is migrated first; if that
    /// fails the workspace opens read-only (see `read_only`).
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let ws = Workspace { root: root.into() };
        for d in [ws.root.clone(), ws.root.join("projects")] {
            fs::create_dir_all(&d).map_err(|e| AppError::io(format!("create {}", d.display()), e))?;
        }
        if let Ok(mut ro) = READ_ONLY.lock() {
            ro.retain(|(r, _)| r != &ws.root);
        }
        // New = nothing from an older layout here (a lost workspace.json alone must still migrate).
        let no_projects = fs::read_dir(ws.root.join("projects")).map(|mut d| d.next().is_none()).unwrap_or(true);
        if !ws.root.join("workspace.json").exists() && !ws.root.join("inbox").exists() && no_projects {
            let mut s = Settings::default();
            s.extra.insert("layout".into(), Value::from(migrate::LAYOUT));
            write_json(&ws.root.join("workspace.json"), &s)?;
        } else if let Err(why) = migrate::run(&ws.root) {
            eprintln!("[dreamer] {why}");
            if let Ok(mut ro) = READ_ONLY.lock() {
                ro.push((ws.root.clone(), why));
            }
            return Ok(ws);
        }
        // A workspace always has a project to open.
        if ws.list_projects()?.is_empty() {
            ws.create_project("Ideas")?;
        }
        Ok(ws)
    }

    /// Why the workspace is read-only (a failed migration), or None.
    pub fn read_only(&self) -> Option<String> {
        read_only_reason(&self.root.join("workspace.json"))
    }

    fn writable(&self) -> Result<()> {
        match self.read_only() {
            Some(why) => Err(AppError::Invalid(format!("Dreamer is read-only right now. {why}"))),
            None => Ok(()),
        }
    }

    fn ensure_subdirs(dir: &Path) -> Result<()> {
        // (Older projects also have an unused `briefs/` folder from the removed brief export.)
        for sub in ["cards", "media", "trash"] {
            let d = dir.join(sub);
            fs::create_dir_all(&d).map_err(|e| AppError::io(format!("create {}", d.display()), e))?;
        }
        Ok(())
    }

    fn init_project_dir(&self, dir: &Path, name: &str) -> Result<()> {
        Self::ensure_subdirs(dir)?;
        write_json(&dir.join("project.json"), &ProjectMeta::named(name))?;
        let canvas = Canvas { viewport: Viewport { x: 300.0, y: 110.0, zoom: 1.0 }, ..Canvas::default() };
        write_json(&dir.join("canvas.json"), &canvas)?;
        write_json(&dir.join("trash").join("trash.json"), &TrashIndex::default())?;
        Ok(())
    }

    pub fn project_dir(&self, slug: &str) -> Result<PathBuf> {
        check_slug(slug)?;
        Ok(self.root.join("projects").join(slug))
    }

    pub(crate) fn existing_project_dir(&self, slug: &str) -> Result<PathBuf> {
        let dir = self.project_dir(slug)?;
        if dir.is_dir() { Ok(dir) } else { Err(AppError::NotFound(format!("project {slug}"))) }
    }

    // ----- settings -----

    pub fn get_settings(&self) -> Result<Settings> {
        read_json_or_default(&self.root.join("workspace.json"))
    }

    pub fn update_settings(&self, patch: SettingsPatch) -> Result<Settings> {
        let mut s = self.get_settings()?;
        if let Some(t) = patch.theme {
            if t.trim().is_empty() {
                return Err(AppError::Invalid("theme id cannot be empty".into()));
            }
            s.theme = t;
        }
        if let Some(p) = patch.last_project {
            s.last_project = if p.is_empty() { None } else { Some(p) };
        }
        if let Some(v) = patch.show_projects {
            s.show_projects = v;
        }
        if let Some(v) = patch.show_chat {
            s.show_chat = v;
        }
        if let Some(v) = patch.side_w {
            s.side_w = v.clamp(crate::model::SIDE_W.0, crate::model::SIDE_W.2);
        }
        if let Some(v) = patch.chat_w {
            s.chat_w = v.clamp(crate::model::CHAT_W.0, crate::model::CHAT_W.2);
        }
        let model = |m: String, default: &str| -> Result<String> {
            let m = m.trim();
            if m.len() > 100 || m.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(AppError::Invalid(format!("{m:?} is not a model name")));
            }
            Ok(if m.is_empty() { default.into() } else { m.into() })
        };
        if let Some(m) = patch.model_chat {
            s.model_chat = model(m, crate::model::DEFAULT_MODEL_CHAT)?;
        }
        if let Some(v) = patch.model_router {
            s.model_router = v;
        }
        if let Some(m) = patch.model_fast {
            s.model_fast = model(m, crate::model::DEFAULT_MODEL_FAST)?;
        }
        if let Some(m) = patch.model_deep {
            s.model_deep = model(m, crate::model::DEFAULT_MODEL_DEEP)?;
        }
        if let Some(m) = patch.model_export {
            s.model_export = model(m, crate::model::DEFAULT_MODEL_EXPORT)?;
        }
        if let Some(m) = patch.model_memory {
            s.model_memory = model(m, crate::model::DEFAULT_MODEL_MEMORY)?;
        }
        if let Some(n) = patch.compact_tokens {
            s.compact_tokens = if n == 0 { crate::model::DEFAULT_COMPACT_TOKENS } else { n };
        }
        if let Some(n) = patch.memory_cap {
            s.memory_cap = if n == 0 { crate::memory::DEFAULT_CAP } else { n };
        }
        if let Some(u) = patch.spritecook_url {
            let u = u.trim();
            if !u.is_empty() && (!u.starts_with("https://") || u.len() > 300 || u.chars().any(char::is_whitespace)) {
                return Err(AppError::Invalid(format!("{u:?} is not an https URL")));
            }
            s.spritecook_url = if u.is_empty() { crate::model::DEFAULT_SPRITECOOK_URL.into() } else { u.into() };
        }
        if let Some(n) = patch.credit_cap {
            s.credit_cap = if n == 0 { crate::model::DEFAULT_CREDIT_CAP } else { n.min(100) };
        }
        write_json(&self.root.join("workspace.json"), &s)?;
        Ok(s)
    }

    // ----- projects -----

    /// "Link repo…" confirmed: remember and confirm the folder the design pack is written into.
    pub fn link_repo(&self, slug: &str, path: &str) -> Result<ProjectSummary> {
        let path = path.trim();
        self.update_project(slug, ProjectPatch { handoff_target: Some(path.into()), ..Default::default() })?;
        self.update_project(slug, ProjectPatch { handoff_target_confirmed: Some(path.into()), ..Default::default() })
    }


    fn card_count(dir: &Path) -> usize {
        fs::read_dir(dir.join("cards"))
            .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().extension().is_some_and(|x| x == "md") && !e.file_name().to_string_lossy().ends_with(".built.md")).count())
            .unwrap_or(0)
    }

    fn summary(&self, slug: &str, dir: &Path) -> Result<(ProjectSummary, String)> {
        let meta: ProjectMeta = read_json_or_default_meta(&dir.join("project.json"), slug)?;
        let created = meta.created.clone();
        Ok((
            ProjectSummary {
                slug: slug.to_string(),
                name: meta.name,
                theme: meta.theme,
                card_count: Self::card_count(dir),
            },
            created,
        ))
    }

    /// Projects by creation time.
    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        let mut rest = Vec::new();
        let rd = fs::read_dir(self.root.join("projects"))
            .map_err(|e| AppError::io("list projects", e))?;
        for entry in rd.filter_map(|e| e.ok()) {
            let path = entry.path();
            let Some(slug) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
            if !path.is_dir() || check_slug(&slug).is_err() {
                continue;
            }
            rest.push(self.summary(&slug, &path)?);
        }
        rest.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.slug.cmp(&b.0.slug)));
        Ok(rest.into_iter().map(|(s, _)| s).collect())
    }

    pub fn create_project(&self, name: &str) -> Result<ProjectSummary> {
        self.writable()?;
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("project name cannot be empty".into()));
        }
        if name.chars().count() > 120 {
            return Err(AppError::Invalid("project name is too long".into()));
        }
        // One project per name (case-insensitive). A repeated create (a double-submitted form, a
        // retry) must not quietly make "Foo" and "Foo" with slugs foo and foo-2. The command layer
        // holds the workspace lock, so check-then-create can't race between two calls.
        let wanted = name.to_lowercase();
        if let Some(p) = self.list_projects()?.into_iter().find(|p| p.name.trim().to_lowercase() == wanted) {
            return Err(AppError::Invalid(format!("A project named “{}” already exists.", p.name)));
        }
        let base = slugify(name);
        for n in 1..1000 {
            let slug = match (n, base.as_str()) {
                (1, b) => b.to_string(),
                (n, b) => format!("{b}-{n}"),
            };
            let dir = self.root.join("projects").join(&slug);
            match fs::create_dir(&dir) {
                Ok(()) => {
                    self.init_project_dir(&dir, name)?;
                    return Ok(self.summary(&slug, &dir)?.0);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(AppError::io(format!("create {}", dir.display()), e)),
            }
        }
        Err(AppError::Invalid("could not find a free project id".into()))
    }

    /// Removes a project folder from disk (a user action: Claude has no tool for this). With
    /// `recycle`, the folder goes to the OS Recycle Bin / Trash; if that isn't possible it is
    /// deleted outright. The last project can't be deleted. Returns whether it was recycled.
    pub fn delete_project(&self, slug: &str, recycle: bool) -> Result<DeletedProject> {
        self.writable()?;
        let dir = self.existing_project_dir(slug)?;
        if self.list_projects()?.len() <= 1 {
            return Err(AppError::Invalid("This is the only project; a workspace keeps at least one.".into()));
        }
        // Belt and braces: never remove anything that isn't exactly <root>/projects/<slug>.
        if dir.parent() != Some(self.root.join("projects").as_path()) {
            return Err(AppError::Invalid(format!("refusing to delete {}", dir.display())));
        }
        let mut recycled = false;
        let mut recycle_err: Option<String> = None;
        if recycle {
            // Retried: right after the watcher is stopped, or while an indexer or antivirus has a
            // file open, the shell can refuse for a moment.
            for wait in std::iter::once(0).chain(RETRY_DELAYS_MS) {
                std::thread::sleep(Duration::from_millis(wait));
                match trash::delete(&dir) {
                    Ok(()) => {
                        recycled = true;
                        break;
                    }
                    Err(e) => recycle_err = Some(e.to_string()),
                }
            }
            if let (false, Some(e)) = (recycled, &recycle_err) {
                eprintln!("[dreamer] Recycle Bin failed for {} ({e}); deleting instead", dir.display());
            }
        }
        if !recycled && dir.exists() {
            // Claim the folder before deleting anything: Windows refuses to rename a folder while
            // something inside it is open, so a project that is in use is left whole (and keeps
            // working) instead of being half-deleted by remove_dir_all. The claimed name starts
            // with a dot, so the project list never shows it.
            let doomed = self.root.join("projects").join(format!(".{slug}.deleting-{}", ulid::Ulid::generate().to_string().to_lowercase()));
            retry_io(|| fs::rename(&dir, &doomed)).map_err(|e| {
                AppError::Invalid(format!(
                    "Couldn't delete “{slug}”: its folder is in use by another program ({e}). Nothing was deleted. Close anything that has it open (an Explorer window, an editor, a terminal) and try again.{}",
                    recycle_err.as_deref().map(|r| format!(" (Recycle Bin: {r})")).unwrap_or_default()
                ))
            })?;
            // remove_dir_all stops at read-only files on Windows (e.g. git objects).
            clear_readonly(&doomed);
            retry_io(|| fs::remove_dir_all(&doomed)).map_err(|e| AppError::io(format!("delete {}", doomed.display()), e))?;
        }
        let settings = self.get_settings()?;
        if settings.last_project.as_deref() == Some(slug) {
            self.update_settings(SettingsPatch { last_project: Some(String::new()), ..Default::default() })?;
        }
        Ok(DeletedProject { slug: slug.into(), path: dir.display().to_string(), recycled })
    }

    // ----- chat threads (plain JSON files in <project>/chats/) -----

    /// `thread` is a card id, or "project" for the project-level thread.
    fn chat_path(&self, slug: &str, thread: &str) -> Result<PathBuf> {
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

    fn write_chat(&self, path: &Path, data: &Value) -> Result<()> {
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

    pub fn update_project(&self, slug: &str, patch: ProjectPatch) -> Result<ProjectSummary> {
        let dir = self.existing_project_dir(slug)?;
        let mut meta = read_json_or_default_meta(&dir.join("project.json"), slug)?;
        if let Some(n) = patch.name {
            let n = n.trim();
            if n.is_empty() {
                return Err(AppError::Invalid("project name cannot be empty".into()));
            }
            meta.name = n.to_string();
        }
        if let Some(t) = patch.theme {
            meta.theme = if t.is_empty() { None } else { Some(t) };
        }
        if let Some(t) = patch.handoff_target {
            let t = t.trim();
            if t.is_empty() {
                meta.handoff_target = None;
                meta.handoff_target_confirmed = None;
            } else {
                let p = Path::new(t);
                if !p.is_absolute() || !p.is_dir() {
                    return Err(AppError::Invalid(format!("the handoff folder must be an existing folder: {t}")));
                }
                if meta.handoff_target.as_deref() != Some(t) {
                    meta.handoff_target_confirmed = None;
                }
                meta.handoff_target = Some(t.to_string());
            }
        }
        if let Some(c) = patch.handoff_target_confirmed {
            if meta.handoff_target.as_deref() != Some(c.trim()) {
                return Err(AppError::Invalid("only the current handoff folder can be confirmed".into()));
            }
            meta.handoff_target_confirmed = Some(c.trim().to_string());
        }
        write_json(&dir.join("project.json"), &meta)?;
        Ok(self.summary(slug, &dir)?.0)
    }

    // ----- canvas (canvas.json, one per project) -----

    fn read_canvas(dir: &Path) -> Result<Canvas> {
        let mut c: Canvas = read_json_or_default(&dir.join("canvas.json"))?;
        c.sanitize();
        Ok(c)
    }

    fn write_canvas(dir: &Path, canvas: &Canvas) -> Result<()> {
        write_json(&dir.join("canvas.json"), canvas)
    }

    pub fn save_canvas(&self, slug: &str, canvas: &Canvas) -> Result<()> {
        let dir = self.existing_project_dir(slug)?;
        let mut canvas = canvas.clone();
        canvas.sanitize();
        Self::write_canvas(&dir, &canvas)
    }

    /// First free grid slot, so new cards never stack exactly on top of each other.
    fn next_free_pos(canvas: &Canvas) -> Pos {
        for k in 0usize.. {
            let p = Pos::at((k % 4) as f64 * GRID_DX, (k / 4) as f64 * GRID_DY);
            let taken = canvas.cards.values().any(|q| (q.x - p.x).abs() < GRID_DX * 0.5 && (q.y - p.y).abs() < GRID_DY * 0.5);
            if !taken {
                return p;
            }
        }
        unreachable!()
    }

    // ----- cards -----

    fn card_path(dir: &Path, id: &str) -> Result<PathBuf> {
        check_id(id)?;
        Ok(dir.join("cards").join(format!("{id}.md")))
    }

    fn read_card_file(path: &Path, id: &str) -> Result<Card> {
        let text = fs::read_to_string(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound(format!("card {id}"))
            } else {
                AppError::io(format!("read {}", path.display()), e)
            }
        })?;
        parse_card(&text, id)
    }

    fn write_card_file(path: &Path, card: &Card) -> Result<()> {
        atomic_write(path, serialize_card(card)?.as_bytes())
    }

    fn list_cards_in(dir: &Path) -> (Vec<Card>, Vec<String>) {
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

    fn proposal_path(dir: &Path, id: &str) -> Result<PathBuf> {
        check_id(id)?;
        Ok(dir.join("cards").join(format!("{id}.proposal.json")))
    }

    fn read_proposals(dir: &Path, live: &std::collections::HashSet<&str>) -> BTreeMap<String, Value> {
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
    fn check_role(dir: &Path, role: Option<String>, except: Option<&str>) -> Result<Option<String>> {
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
    fn role_card(dir: &Path, role: &str, except: Option<&str>) -> Option<String> {
        Self::list_cards_in(dir).0.into_iter().find(|c| c.meta.role.as_deref() == Some(role) && Some(c.meta.id.as_str()) != except).map(|c| c.meta.id)
    }

    fn check_attachments(list: Vec<Attachment>) -> Result<Vec<Attachment>> {
        for a in &list {
            a.validate().map_err(AppError::Invalid)?;
        }
        Ok(merge_attachments([list.as_slice()]))
    }

    /// Checklist items get an id when they lack one (or share one).
    fn check_items(mut items: Vec<ChecklistItem>) -> Vec<ChecklistItem> {
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
    fn edit_card(&self, slug: &str, id: &str, f: impl FnOnce(&mut Card) -> Result<()>) -> Result<Card> {
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

    // ----- media -----

    /// Save bytes under the project's `media/` folder with a fresh ULID name, keeping the hinted extension.
    /// Returns the path relative to the project dir (e.g. `media/<ulid>.png`) for storing in a card's `fields`.
    pub fn save_media(&self, slug: &str, name_hint: &str, bytes: &[u8]) -> Result<String> {
        let dir = self.existing_project_dir(slug)?;
        let ext: String = Path::new(name_hint)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase())
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| "png".into());
        let fname = format!("{}.{}", ulid::Ulid::generate(), ext);
        let media_dir = dir.join("media");
        atomic_write(&media_dir.join(&fname), bytes)?;
        Ok(format!("media/{fname}"))
    }

    /// Writes a fetched clip's files under `media/` (favicon, og:image, `media/clips/<att_id>.md`)
    /// and returns the clip attachment. Re-running with the same id overwrites the excerpt.
    pub fn store_clip(&self, slug: &str, att_id: &str, url: &str, f: crate::clip::Fetched) -> Result<Attachment> {
        check_id(att_id)?;
        let dir = self.existing_project_dir(slug)?;
        let favicon = f.favicon.map(|(b, ext)| self.save_media(slug, &format!("favicon.{ext}"), &b)).transpose()?;
        let thumb = f.image.map(|(b, ext)| self.save_media(slug, &format!("thumb.{ext}"), &b)).transpose()?;
        let excerpt = match &f.excerpt {
            Some(text) => {
                let rel = format!("media/clips/{att_id}.md");
                let title = f.title.as_deref().map(|t| format!("# {t}

")).unwrap_or_default();
                atomic_write(&dir.join(&rel), format!("<{url}>

{title}{text}
").as_bytes())?;
                Some(rel)
            }
            None => None,
        };
        Ok(Attachment::Clip {
            id: att_id.to_string(),
            url: url.trim().to_string(),
            title: f.title,
            description: f.description,
            site: f.site,
            favicon,
            thumb,
            excerpt,
            caption: None,
            fetched_at: Some(now()),
            fetch_error: f.error,
        })
    }

    /// Several files at once; returns their paths in the same order.
    pub fn save_media_many(&self, slug: &str, files: &[MediaUpload]) -> Result<Vec<String>> {
        files.iter().map(|f| self.save_media(slug, &f.name_hint, &f.bytes)).collect()
    }

    /// Deletes files under `media/` that no live card (or variant) mentions. Run only when the
    /// Trash is emptied, so removed attachments and trashed cards stay restorable until then.
    fn sweep_media(dir: &Path) -> Result<()> {
        fn walk(d: &Path, out: &mut Vec<PathBuf>) {
            if let Ok(rd) = fs::read_dir(d) {
                for e in rd.filter_map(|e| e.ok()) {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, out);
                    } else {
                        out.push(p);
                    }
                }
            }
        }
        let mut media = Vec::new();
        walk(&dir.join("media"), &mut media);
        if media.is_empty() {
            return Ok(());
        }
        let mut card_files = Vec::new();
        walk(&dir.join("cards"), &mut card_files);
        // Raw text, not parsed attachments: a path in a body, a custom field or a variant counts too.
        let text: String = card_files.iter().filter(|p| p.extension().is_some_and(|x| x == "md")).filter_map(|p| fs::read_to_string(p).ok()).collect::<Vec<_>>().join("\n");
        for p in media {
            let Ok(rel) = p.strip_prefix(dir) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if !text.contains(&rel) {
                retry_io(|| fs::remove_file(&p)).map_err(|e| AppError::io(format!("remove {}", p.display()), e))?;
            }
        }
        Ok(())
    }

    /// Read a file back from inside a project (media, briefs...) as bytes, for the UI to show as a data URL.
    /// `rel` must stay inside the project dir.
    pub fn read_project_file(&self, slug: &str, rel: &str) -> Result<Vec<u8>> {
        let dir = self.existing_project_dir(slug)?;
        let rel_path = Path::new(rel);
        if rel_path.is_absolute() || rel_path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(AppError::Invalid(format!("invalid relative path: {rel:?}")));
        }
        let path = dir.join(rel_path);
        fs::read(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { AppError::NotFound(format!("file {rel}")) } else { AppError::io(format!("read {}", path.display()), e) }
        })
    }

    // ----- trash -----

    fn trash_dir(dir: &Path) -> PathBuf {
        dir.join("trash")
    }

    fn read_trash(dir: &Path) -> Result<TrashIndex> {
        read_json_or_default(&Self::trash_dir(dir).join("trash.json"))
    }

    fn write_trash(dir: &Path, idx: &TrashIndex) -> Result<()> {
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

    /// project.json as stored (unknown keys included).
    pub fn project_meta(&self, slug: &str) -> Result<ProjectMeta> {
        let dir = self.existing_project_dir(slug)?;
        read_json_or_default_meta(&dir.join("project.json"), slug)
    }

    /// Sets (or with None removes) one of project.json's extra keys (active_theme, spritecook_project).
    pub fn set_project_extra(&self, slug: &str, key: &str, value: Option<Value>) -> Result<()> {
        let dir = self.existing_project_dir(slug)?;
        let path = dir.join("project.json");
        let mut meta = read_json_or_default_meta(&path, slug)?;
        match value {
            Some(v) => meta.extra.insert(key.to_string(), v),
            None => meta.extra.remove(key),
        };
        write_json(&path, &meta)
    }
}

fn read_json_or_default_meta(path: &Path, slug: &str) -> Result<ProjectMeta> {
    let meta: Option<ProjectMeta> = match fs::read_to_string(path) {
        Ok(t) => serde_json::from_str(t.trim_start_matches('\u{feff}')).ok(),
        Err(_) => None,
    };
    Ok(meta.unwrap_or_else(|| ProjectMeta { created: String::new(), ..ProjectMeta::named(slug) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    /// The project a fresh workspace starts with.
    const P: &str = "ideas";

    fn ws() -> (TempDir, Workspace) {
        let dir = TempDir::new().unwrap();
        let ws = Workspace::open(dir.path().join("Dreamer")).unwrap();
        (dir, ws)
    }

    fn new_card(title: &str) -> NewCard {
        NewCard { title: Some(title.into()), ..Default::default() }
    }

    #[test]
    fn open_creates_layout_and_a_first_project() {
        let (_d, ws) = ws();
        assert!(ws.root.join("workspace.json").is_file());
        assert!(!ws.root.join("inbox").exists());
        let dir = ws.root.join("projects").join(P);
        for sub in ["cards", "media", "trash"] {
            assert!(dir.join(sub).is_dir(), "{sub}");
        }
        assert!(dir.join("project.json").is_file() && dir.join("canvas.json").is_file());
        assert_eq!(ws.get_settings().unwrap().extra.get("layout"), Some(&json!(2)), "a new workspace needs no migration");
        let projects = ws.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        // reopening keeps existing data
        ws.create_card(P, new_card("keep me")).unwrap();
        let again = Workspace::open(&ws.root).unwrap();
        assert_eq!(again.list_projects().unwrap().len(), 1);
        assert_eq!(again.list_projects().unwrap()[0].card_count, 1);
    }

    #[test]
    fn panel_visibility_persists_and_defaults_to_shown() {
        let (_d, ws) = ws();
        // An older workspace.json without the keys shows both panels and keeps unknown keys.
        fs::write(ws.root.join("workspace.json"), r#"{"version":1,"theme":"pearl-glow","hotkey":"Ctrl+Shift+Space","mine":7}"#).unwrap();
        let s = ws.get_settings().unwrap();
        assert!(s.show_projects && s.show_chat);
        let s = ws.update_settings(SettingsPatch { show_projects: Some(false), ..Default::default() }).unwrap();
        assert!(!s.show_projects && s.show_chat);
        ws.update_settings(SettingsPatch { show_chat: Some(false), ..Default::default() }).unwrap();
        let s = ws.get_settings().unwrap();
        assert!(!s.show_projects && !s.show_chat);
        assert_eq!(s.extra.get("mine"), Some(&serde_json::json!(7)), "unknown keys survive");
        let raw: serde_json::Value = serde_json::from_str(&fs::read_to_string(ws.root.join("workspace.json")).unwrap()).unwrap();
        assert_eq!((raw["show_projects"].clone(), raw["show_chat"].clone()), (serde_json::json!(false), serde_json::json!(false)));
        ws.update_settings(SettingsPatch { show_projects: Some(true), show_chat: Some(true), ..Default::default() }).unwrap();
        assert!(ws.get_settings().unwrap().show_projects && ws.get_settings().unwrap().show_chat);
    }

    #[test]
    fn settings_roundtrip_and_corrupt_file_is_backed_up() {
        let (_d, ws) = ws();
        let s = ws.update_settings(SettingsPatch { theme: Some("gold-sky".into()), last_project: Some("fish".into()), ..Default::default() }).unwrap();
        assert_eq!(s.theme, "gold-sky");
        assert_eq!(ws.get_settings().unwrap().last_project.as_deref(), Some("fish"));
        ws.update_settings(SettingsPatch { last_project: Some(String::new()), ..Default::default() }).unwrap();
        assert_eq!(ws.get_settings().unwrap().last_project, None);
        assert!(ws.update_settings(SettingsPatch { theme: Some("  ".into()), ..Default::default() }).is_err());

        fs::write(ws.root.join("workspace.json"), "{ not json").unwrap();
        let s = ws.get_settings().unwrap();
        assert_eq!(s.theme, "pearl-glow");
        assert!(ws.root.join("workspace.json.bak").is_file());
    }

    #[test]
    fn projects_get_unique_slugs() {
        let (_d, ws) = ws();
        let a = ws.create_project("Fish-punk fishing!").unwrap();
        // The same name twice is refused (item 8); a different name with the same slug gets -2.
        assert!(ws.create_project("Fish-punk fishing!").is_err());
        let b = ws.create_project("Fish punk, fishing").unwrap();
        // "Inbox" is an ordinary name now.
        let i = ws.create_project("Inbox").unwrap();
        assert_eq!(a.slug, "fish-punk-fishing");
        assert_eq!(b.slug, "fish-punk-fishing-2");
        assert_eq!(i.slug, "inbox");
        assert!(ws.create_project("   ").is_err());
        assert_eq!(ws.list_projects().unwrap().len(), 4);
        let u = ws.update_project(&a.slug, ProjectPatch { name: Some("Renamed".into()), theme: Some("iridescent".into()), ..Default::default() }).unwrap();
        assert_eq!((u.name.as_str(), u.theme.as_deref()), ("Renamed", Some("iridescent")));
        let u = ws.update_project(&a.slug, ProjectPatch { theme: Some(String::new()), ..Default::default() }).unwrap();
        assert_eq!(u.theme, None);
    }

    #[test]
    fn slugs_and_ids_cannot_escape_the_workspace() {
        let (_d, ws) = ws();
        for bad in ["..", "../x", "a/b", "a\\b", "", "Up", ".hidden", "x y"] {
            assert!(ws.load_project(bad).is_err(), "{bad:?}");
        }
        for bad in ["../x", "a/b", "", "a.b", "a b"] {
            assert!(ws.read_card(P, bad).is_err(), "{bad:?}");
        }
        assert!(matches!(ws.load_project("nope"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn card_file_roundtrip_matches_the_documented_format() {
        let (_d, ws) = ws();
        let c = ws
            .create_card(
                P,
                NewCard {
                    title: Some("Harpoon rod".into()),
                    body: Some("# Notes\n\nTwo moods.\n\n---\n\nA rule above.".into()),
                    stage: Some(Stage::Lucid),
                    tags: Some(vec!["weapon".into(), "core".into()]),
                    links: Some(vec![Link { to: "01OTHER".into(), label: Some("feeds".into()) }, Link { to: "01X".into(), label: None }]),
                    source: Some(Source::Claude),
                    ghost: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        let text = fs::read_to_string(ws.root.join(format!("projects/ideas/cards/{}.md", c.meta.id))).unwrap();
        assert!(text.starts_with("---\nid: "), "{text}");
        assert!(text.contains("stage: lucid"));
        assert!(text.contains("source: claude"));
        assert!(text.contains("ghost: true"));
        assert!(text.contains("- to: 01OTHER\n  label: feeds"));
        assert!(!text.contains("branch"), "branch omitted when unset");
        assert!(!text.contains('\r'));
        let back = ws.read_card(P, &c.meta.id).unwrap();
        assert_eq!(back, c);
        assert!(back.body.contains("A rule above."), "a --- rule in the body must not end the frontmatter");
        assert_eq!(c.meta.id.len(), 26, "ULID");
    }

    #[test]
    fn parser_is_tolerant_of_crlf_bom_missing_fields_and_unknown_keys() {
        let crlf = "\u{feff}---\r\nid: WRONG\r\ntitle: From Windows\r\nstage: Reverie\r\nnotes: keep me\r\n---\r\n\r\nBody line\r\n";
        let c = parse_card(crlf, "01ABC").unwrap();
        assert_eq!(c.meta.id, "01ABC", "file name is the id authority");
        assert_eq!(c.meta.title, "From Windows");
        assert_eq!(c.meta.stage, Stage::Reverie);
        assert_eq!(c.body, "Body line");
        assert_eq!(c.meta.extra.get("notes").and_then(|v| v.as_str()), Some("keep me"));
        assert!(serialize_card(&c).unwrap().contains("notes: keep me"), "unknown keys survive a rewrite");

        let plain = parse_card("# Just a note\n\nhello", "01Z").unwrap();
        assert_eq!(plain.meta.title, "Just a note");
        assert_eq!(plain.meta.stage, Stage::Mist);
        assert_eq!(parse_card("", "01E").unwrap().meta.title, "Untitled");

        let weird = parse_card("---\nstage: banana\n---\nx", "01W").unwrap();
        assert_eq!(weird.meta.stage, Stage::Mist);
        let empty_fm = parse_card("---\n---\nbody", "01F").unwrap();
        assert_eq!(empty_fm.body, "body");
        let no_body = parse_card("---\ntitle: T\n---", "01G").unwrap();
        assert_eq!((no_body.meta.title.as_str(), no_body.body.as_str()), ("T", ""));
        assert!(parse_card("---\ntitle: [unclosed\n---\nx", "01B").is_err());
    }

    #[test]
    fn update_card_patches_and_preserves_the_rest() {
        let (_d, ws) = ws();
        let c = ws.create_card(P, NewCard { title: Some("A".into()), body: Some("body".into()), tags: Some(vec!["t".into()]), ..Default::default() }).unwrap();
        let u = ws.update_card(P, &c.meta.id, CardPatch { stage: Some(Stage::Dream), title: Some("  B ".into()), ..Default::default() }).unwrap();
        assert_eq!(u.meta.title, "B");
        assert_eq!(u.meta.stage, Stage::Dream);
        assert_eq!(u.body, "body");
        assert_eq!(u.meta.tags, vec!["t"]);
        assert_eq!(u.meta.created, c.meta.created);
        assert!(u.meta.updated >= c.meta.updated);
        assert!(matches!(ws.update_card(P, "01MISSING", CardPatch::default()), Err(AppError::NotFound(_))));
    }

    #[test]
    fn new_cards_are_placed_without_overlap_and_explicit_positions_are_kept() {
        let (_d, ws) = ws();
        let a = ws.create_card(P, new_card("a")).unwrap();
        let b = ws.create_card(P, new_card("b")).unwrap();
        let c = ws.create_card(P, NewCard { x: Some(900.0), y: Some(-40.0), ..new_card("c") }).unwrap();
        let data = ws.load_project(P).unwrap();
        let pa = data.canvas.cards[&a.meta.id];
        let pb = data.canvas.cards[&b.meta.id];
        assert_ne!(pa, pb);
        assert_eq!((data.canvas.cards[&c.meta.id].x, data.canvas.cards[&c.meta.id].y), (900.0, -40.0));
        assert_eq!(data.cards.len(), 3);
    }

    #[test]
    fn externally_added_and_removed_cards_are_reconciled_on_load() {
        let (_d, ws) = ws();
        let a = ws.create_card(P, new_card("a")).unwrap();
        // a card dropped in by Claude Code / git, and a corrupt one
        fs::write(ws.root.join("projects/ideas/cards/01EXTERNAL.md"), "---\ntitle: External\nstage: reverie\n---\nhi\n").unwrap();
        fs::write(ws.root.join("projects/ideas/cards/01BROKEN.md"), "---\ntitle: [oops\n---\n").unwrap();
        fs::write(ws.root.join("projects/ideas/cards/notes.txt"), "ignored").unwrap();
        let data = ws.load_project(P).unwrap();
        assert_eq!(data.cards.len(), 2);
        assert!(data.canvas.cards.contains_key("01EXTERNAL"));
        assert_eq!(data.warnings.len(), 1);
        assert!(data.warnings[0].contains("01BROKEN"));
        // removed outside the app: position dropped
        fs::remove_file(ws.root.join(format!("projects/ideas/cards/{}.md", a.meta.id))).unwrap();
        let data = ws.load_project(P).unwrap();
        assert!(!data.canvas.cards.contains_key(&a.meta.id));
        // positions were persisted
        let on_disk: Canvas = serde_json::from_str(&fs::read_to_string(ws.root.join("projects/ideas/canvas.json")).unwrap()).unwrap();
        assert!(on_disk.cards.contains_key("01EXTERNAL"));
    }

    #[test]
    fn delete_goes_to_trash_and_restore_returns_card_to_old_position() {
        let (_d, ws) = ws();
        let c = ws.create_card(P, NewCard { x: Some(123.0), y: Some(456.0), ..new_card("doomed") }).unwrap();
        let id = c.meta.id.clone();
        let item = ws.delete_card(P, &id).unwrap();
        assert_eq!(item.reason, "deleted");
        assert!(!ws.root.join(format!("projects/ideas/cards/{id}.md")).exists());
        assert!(ws.root.join(format!("projects/ideas/trash/{id}.md")).is_file());
        let data = ws.load_project(P).unwrap();
        assert!(data.cards.is_empty() && data.canvas.cards.is_empty());
        let trash = ws.list_trash(P).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].title, "doomed");

        let back = ws.restore_card(P, &id).unwrap();
        assert_eq!(back.meta.title, "doomed");
        let data = ws.load_project(P).unwrap();
        assert_eq!((data.canvas.cards[&id].x, data.canvas.cards[&id].y), (123.0, 456.0));
        assert!(ws.list_trash(P).unwrap().is_empty());
        assert!(ws.restore_card(P, &id).is_err());
        assert!(matches!(ws.delete_card(P, "01NOPE"), Err(AppError::NotFound(_))));
    }

    // ----- fix pass #3, item 8: create/delete reliability -----

    #[test]
    fn create_project_refuses_a_second_project_with_the_same_name() {
        let (_d, ws) = ws();
        let a = ws.create_project("Twice").unwrap();
        assert_eq!(a.slug, "twice");
        for again in ["Twice", "  twice ", "TWICE"] {
            let e = ws.create_project(again).unwrap_err().to_string();
            assert!(e.contains("already exists") && e.contains("Twice"), "{again:?}: {e}");
        }
        assert!(ws.create_project("Ideas").unwrap_err().to_string().contains("already exists"));
        // Only one folder was made; a different name that slugifies the same still works.
        assert_eq!(ws.list_projects().unwrap().iter().filter(|p| p.name == "Twice").count(), 1);
        assert_eq!(ws.create_project("Twice!").unwrap().slug, "twice-2");
    }

    #[test]
    fn concurrent_creates_with_one_name_make_one_project() {
        // The command layer serialises calls on one Mutex<Workspace>; model that with 8 threads
        // firing the same create at once (a double-submitted form, Enter + blur).
        let (_d, ws) = ws();
        let shared = std::sync::Arc::new(std::sync::Mutex::new(ws));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let s = shared.clone();
                std::thread::spawn(move || s.lock().unwrap().create_project("Race").is_ok())
            })
            .collect();
        let oks = handles.into_iter().map(|h| h.join().unwrap()).filter(|ok| *ok).count();
        assert_eq!(oks, 1);
        let ws = shared.lock().unwrap();
        assert_eq!(fs::read_dir(ws.root.join("projects")).unwrap().count(), 2, "ideas + race");
    }

    fn project_with_files(ws: &Workspace, name: &str) -> (String, PathBuf) {
        let p = ws.create_project(name).unwrap();
        for i in 0..5 {
            ws.create_card(&p.slug, new_card(&format!("card {i}"))).unwrap();
        }
        let dir = ws.project_dir(&p.slug).unwrap();
        (p.slug, dir)
    }

    fn no_leftovers(ws: &Workspace) -> bool {
        fs::read_dir(ws.root.join("projects")).unwrap().filter_map(|e| e.ok()).all(|e| !e.file_name().to_string_lossy().contains(".deleting-"))
    }

    #[test]
    fn delete_project_works_while_the_watcher_is_active() {
        let (_d, ws) = ws();
        let root = ws.root.canonicalize().unwrap();
        let ws = Workspace::open(&root).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let _w = crate::watcher::start(root.clone(), move |e| {
            let _ = tx.send(e);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        for round in 0..3 {
            let (slug, dir) = project_with_files(&ws, &format!("Watched {round}"));
            // Keep the watcher busy with a burst of writes right before the delete.
            ws.create_card(&slug, new_card("last")).unwrap();
            let out = ws.delete_project(&slug, false).unwrap();
            assert!(!out.recycled && !dir.exists(), "round {round}");
        }
        assert!(no_leftovers(&ws));
        // The watcher kept running and reported the changes.
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
    }

    #[test]
    fn delete_project_clears_read_only_files() {
        let (_d, ws) = ws();
        let (slug, dir) = project_with_files(&ws, "Readonly");
        let f = dir.join("media").join("locked.bin");
        fs::write(&f, b"x").unwrap();
        let mut p = fs::metadata(&f).unwrap().permissions();
        p.set_readonly(true);
        fs::set_permissions(&f, p).unwrap();
        ws.delete_project(&slug, false).unwrap();
        assert!(!dir.exists() && no_leftovers(&ws));
    }

    /// Opens a file inside a project with no sharing at all, like a program that locks it.
    #[cfg(windows)]
    fn lock_file(path: &Path) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new().read(true).write(true).share_mode(0).open(path).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn delete_project_retries_until_a_brief_lock_is_released() {
        let (_d, ws) = ws();
        let (slug, dir) = project_with_files(&ws, "Briefly locked");
        let lock = lock_file(&dir.join("canvas.json"));
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(lock);
        });
        let started = std::time::Instant::now();
        ws.delete_project(&slug, false).unwrap();
        releaser.join().unwrap();
        assert!(!dir.exists() && no_leftovers(&ws));
        assert!(started.elapsed() >= Duration::from_millis(250), "it really had to wait for the lock");
    }

    #[cfg(windows)]
    #[test]
    fn delete_project_leaves_a_locked_project_whole_and_says_why() {
        let (_d, ws) = ws();
        let (slug, dir) = project_with_files(&ws, "Held open");
        let before: Vec<_> = fs::read_dir(dir.join("cards")).unwrap().map(|e| e.unwrap().file_name()).collect();
        let _lock = lock_file(&dir.join("canvas.json"));
        let e = ws.delete_project(&slug, false).unwrap_err().to_string();
        assert!(e.contains("in use") && e.contains("Nothing was deleted"), "{e}");
        // Not a single file is gone: no half-deleted project.
        let after: Vec<_> = fs::read_dir(dir.join("cards")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(before, after);
        assert!(dir.join("project.json").exists() && dir.join("canvas.json").exists());
        assert!(no_leftovers(&ws));
        assert!(ws.list_projects().unwrap().iter().any(|p| p.slug == slug));
    }

    #[test]
    fn retry_io_gives_up_on_permanent_errors_at_once() {
        let mut calls = 0;
        let r: std::io::Result<()> = retry_io(|| {
            calls += 1;
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "gone"))
        });
        assert!(r.is_err() && calls == 1);
        let mut calls = 0;
        let r = retry_io(|| {
            calls += 1;
            if calls < 3 { Err(std::io::Error::from_raw_os_error(32)) } else { Ok(calls) }
        });
        assert_eq!(r.unwrap(), 3);
    }

    #[test]
    fn delete_project_removes_folder_keeps_the_last_project_and_clears_last_project() {
        let (_d, ws) = ws();
        let p = ws.create_project("Doomed").unwrap();
        ws.create_card(&p.slug, new_card("x")).unwrap();
        ws.save_chat(&p.slug, "project", &serde_json::json!({"messages": []})).unwrap();
        ws.update_settings(SettingsPatch { last_project: Some(p.slug.clone()), ..Default::default() }).unwrap();
        assert!(matches!(ws.delete_project("nope", false), Err(AppError::NotFound(_))));
        assert!(ws.delete_project("../inbox", false).is_err());
        let out = ws.delete_project(&p.slug, false).unwrap();
        assert!(!out.recycled);
        assert!(!ws.root.join("projects").join(&p.slug).exists());
        assert_eq!(ws.get_settings().unwrap().last_project, None);
        assert!(ws.list_projects().unwrap().iter().all(|s| s.slug != p.slug));
        assert!(ws.root.join("projects/ideas").is_dir(), "others untouched");
        assert!(matches!(ws.delete_project(P, false), Err(AppError::Invalid(_))), "the last project stays");
    }

    /// Moves a throwaway project to the real Recycle Bin: `cargo test -- --ignored recycle`.
    #[test]
    #[ignore]
    fn delete_project_recycles_live() {
        let (_d, ws) = ws();
        let p = ws.create_project("dreamer-recycle-test").unwrap();
        let out = ws.delete_project(&p.slug, true).unwrap();
        println!("recycled={} path={}", out.recycled, out.path);
        assert!(out.recycled);
        assert!(!ws.root.join("projects").join(&p.slug).exists());
    }

    #[test]
    fn chat_threads_are_per_card_files_and_reset_clears_one() {
        let (_d, ws) = ws();
        let a = ws.create_card(P, new_card("a")).unwrap();
        let empty = ws.load_chat(P, &a.meta.id).unwrap();
        assert_eq!(empty["messages"], serde_json::json!([]));
        let t1 = serde_json::json!({"version": 1, "sessionId": "s1", "messages": [{"id": "m1", "role": "user", "text": "hi"}]});
        ws.save_chat(P, &a.meta.id, &t1).unwrap();
        ws.save_chat(P, "project", &serde_json::json!({"messages": [1]})).unwrap();
        assert!(ws.root.join(format!("projects/ideas/chats/{}.json", a.meta.id)).is_file());
        assert_eq!(ws.load_chat(P, &a.meta.id).unwrap(), t1);
        ws.reset_chat(P, &a.meta.id).unwrap();
        assert_eq!(ws.load_chat(P, &a.meta.id).unwrap()["messages"], serde_json::json!([]));
        assert_eq!(ws.load_chat(P, "project").unwrap()["messages"], serde_json::json!([1]), "other threads untouched");
        ws.reset_chat(P, &a.meta.id).unwrap(); // idempotent
        assert!(ws.load_chat(P, "../workspace").is_err());
        assert!(ws.save_chat(P, "a/b", &serde_json::json!({})).is_err());
        // Rust-owned fields (context snapshot, usage, summary) survive UI saves; reset clears them.
        ws.update_chat(P, &a.meta.id, |f| {
            f.insert("ctx".into(), serde_json::json!({"memoryHash": "h", "cards": {}}));
            f.insert("last_input_tokens".into(), serde_json::json!(123));
            f.insert("summary".into(), serde_json::json!("s"));
        })
        .unwrap();
        ws.save_chat(P, &a.meta.id, &serde_json::json!({"version": 1, "sessionId": "x", "messages": [2]})).unwrap();
        let kept = ws.load_chat(P, &a.meta.id).unwrap();
        assert_eq!((kept["ctx"]["memoryHash"].as_str(), kept["last_input_tokens"].as_u64(), kept["summary"].as_str(), kept["messages"][0].as_i64()), (Some("h"), Some(123), Some("s"), Some(2)));
        ws.reset_chat(P, &a.meta.id).unwrap();
        assert!(ws.load_chat(P, &a.meta.id).unwrap().get("summary").is_none());
    }

    #[test]
    fn size_and_z_order_persist_through_save_trash_and_restore() {
        let (_d, ws) = ws();
        let a = ws.create_card(P, new_card("a")).unwrap();
        let b = ws.create_card(P, new_card("b")).unwrap();
        let mut canvas = ws.load_project(P).unwrap().canvas;
        // New cards stack upward.
        assert!(canvas.cards[&b.meta.id].z > canvas.cards[&a.meta.id].z);
        // The UI resizes `a`, sends it to the back, and saves (bad values get sanitized).
        let pa = canvas.cards.get_mut(&a.meta.id).unwrap();
        pa.w = Some(420.0);
        pa.h = Some(f64::NAN);
        pa.z = Some(-5);
        pa.back = true;
        ws.save_canvas(P, &canvas).unwrap();
        let saved = ws.load_project(P).unwrap().canvas.cards[&a.meta.id];
        assert_eq!((saved.w, saved.h, saved.z, saved.back), (Some(420.0), None, Some(-5), true));
        // Trash keeps the whole Pos; restore brings size and stacking back.
        ws.delete_card(P, &a.meta.id).unwrap();
        ws.restore_card(P, &a.meta.id).unwrap();
        assert_eq!(ws.load_project(P).unwrap().canvas.cards[&a.meta.id], saved);
        // A third card goes above everything again.
        let c = ws.create_card(P, new_card("c")).unwrap();
        let cv = ws.load_project(P).unwrap().canvas;
        assert_eq!(cv.cards[&c.meta.id].z, Some(cv.cards[&b.meta.id].z.unwrap() + 1));
    }

    #[test]
    fn trash_reason_label_and_empty_trash() {
        let (_d, ws) = ws();
        let a = ws.create_card(P, new_card("loser")).unwrap();
        let b = ws.create_card(P, new_card("gone")).unwrap();
        ws.trash_card(P, &a.meta.id, "lost to Winner").unwrap();
        ws.delete_card(P, &b.meta.id).unwrap();
        let reasons: Vec<_> = ws.list_trash(P).unwrap().into_iter().map(|i| i.reason).collect();
        assert_eq!(reasons, vec!["lost to Winner", "deleted"]);
        assert_eq!(ws.empty_trash(P).unwrap(), 2);
        assert!(ws.list_trash(P).unwrap().is_empty());
        assert!(!ws.root.join(format!("projects/ideas/trash/{}.md", a.meta.id)).exists());
        assert!(ws.root.join("projects/ideas/trash/trash.json").is_file());
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_files() {
        let d = TempDir::new().unwrap();
        let p = d.path().join("sub/dir/file.txt");
        atomic_write(&p, b"one").unwrap();
        atomic_write(&p, b"two").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "two");
        let leftovers: Vec<_> = fs::read_dir(p.parent().unwrap()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(leftovers, vec!["file.txt"]);
    }

    #[test]
    fn viewport_save_and_load() {
        let (_d, ws) = ws();
        let p = ws.create_project("P").unwrap();
        let mut data = ws.load_project(&p.slug).unwrap();
        data.canvas.viewport = Viewport { x: -50.0, y: 20.0, zoom: 0.5 };
        ws.save_canvas(&p.slug, &data.canvas).unwrap();
        assert_eq!(ws.load_project(&p.slug).unwrap().canvas.viewport, Viewport { x: -50.0, y: 20.0, zoom: 0.5 });
    }

    #[test]
    fn media_is_saved_under_the_project_and_rejects_escaping_paths() {
        let (_d, ws) = ws();
        let rel = ws.save_media(P, "photo.PNG", b"\x89PNG-ish").unwrap();
        assert!(rel.starts_with("media/") && rel.ends_with(".png"));
        assert_eq!(ws.read_project_file(P, &rel).unwrap(), b"\x89PNG-ish");
        assert!(ws.read_project_file(P, "../../etc/passwd").is_err());
        assert!(ws.read_project_file(P, "media/nope.png").is_err());
    }

    #[test]
    fn slugify_handles_odd_names() {
        assert_eq!(slugify("  Hello,   World!! "), "hello-world");
        assert_eq!(slugify("***"), "project");
        assert_eq!(slugify("Ünï Cödé 2"), "n-c-d-2");
    }

    fn img(id: &str, path: &str) -> Attachment {
        Attachment::Image { id: id.into(), path: path.into(), caption: None }
    }
    fn clip(id: &str, url: &str) -> Attachment {
        serde_json::from_value(json!({"type": "clip", "id": id, "url": url})).unwrap()
    }

    #[test]
    fn new_card_kinds_roundtrip_through_the_file() {
        let (_d, ws) = ws();
        let c = ws
            .create_card(
                P,
                NewCard {
                    kind: Some(CardKind::Checklist),
                    items: Some(vec![
                        ChecklistItem { text: "a".into(), ..Default::default() },
                        ChecklistItem { id: "q".into(), text: "why?".into(), question: true, answer: Some("because".into()), ..Default::default() },
                    ]),
                    attachments: Some(vec![img("", "media/a.png"), clip("x", "https://e.com")]),
                    ..new_card("list")
                },
            )
            .unwrap();
        assert!(!c.meta.items[0].id.is_empty(), "missing item ids are filled");
        assert!(!c.meta.attachments[0].id().is_empty(), "missing attachment ids are filled");
        let back = ws.read_card(P, &c.meta.id).unwrap();
        assert_eq!(back, c);
        let text = fs::read_to_string(ws.root.join(format!("projects/ideas/cards/{}.md", c.meta.id))).unwrap();
        assert!(text.contains("kind: checklist") && text.contains("type: clip"), "{text}");

        // A plain card file without the new keys reads as kind "card" with no attachments.
        let plain = parse_card("---\ntitle: T\nkind: weird\n---\n", "01P").unwrap();
        assert_eq!((plain.meta.kind, plain.meta.attachments.len()), (CardKind::Card, 0));
        // A malformed attachment entry is skipped, not fatal.
        let bad = parse_card("---\nattachments:\n  - type: video\n  - {type: image, id: i, path: media/x.png}\n---\n", "01Q").unwrap();
        assert_eq!(bad.meta.attachments, vec![img("i", "media/x.png")]);

        // Escaping paths are refused.
        let err = ws.create_card(P, NewCard { attachments: Some(vec![img("", "../x.png")]), ..new_card("x") });
        assert!(matches!(err, Err(AppError::Invalid(_))));
        let u = ws.update_card(P, &c.meta.id, CardPatch { kind: Some(CardKind::Card), ..Default::default() }).unwrap();
        assert_eq!(u.meta.kind, CardKind::Card);
        assert_eq!(u.meta.attachments.len(), 2, "untouched by a patch without attachments");
    }

    #[test]
    fn legacy_image_and_clip_fields_become_attachments_and_leave_on_write() {
        let (_d, ws) = ws();
        let id = "01LEGACY0000000000000000000";
        let path = ws.root.join(format!("projects/ideas/cards/{id}.md"));
        fs::write(&path, "---\ntitle: Old\nfields:\n  image: media/old.png\n  url: https://ex.com\n  clip_title: Ex\n  mood: calm\nattachments:\n  - {type: image, id: a1, path: media/more.png}\nnotes: keep\n---\nbody\n").unwrap();
        let c = ws.read_card(P, id).unwrap();
        let ids: Vec<_> = c.meta.attachments.iter().map(|a| a.id().to_string()).collect();
        assert_eq!(ids, ["legacy-image", "legacy-clip", "a1"], "image first, then clip, then the rest");
        assert!(matches!(&c.meta.attachments[1], Attachment::Clip { title: Some(t), .. } if t == "Ex"));
        assert_eq!(c.meta.fields.keys().collect::<Vec<_>>(), ["mood"]);
        assert_eq!(ws.read_card(P, id).unwrap(), c, "stable ids across reads");
        // Any write drops the legacy keys; unknown keys still pass through.
        ws.update_attachment(P, id, "legacy-image", &json!({"caption": "cover"})).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("clip_title") && !text.contains("  image:") && text.contains("notes: keep") && text.contains("mood: calm"), "{text}");
        let again = ws.read_card(P, id).unwrap();
        assert_eq!(again.meta.attachments.len(), 3);
        assert!(matches!(&again.meta.attachments[0], Attachment::Image { caption: Some(c), .. } if c == "cover"));
    }

    #[test]
    fn attachment_commands_add_update_reorder_remove() {
        let (_d, ws) = ws();
        let c = ws.create_card(P, new_card("a")).unwrap();
        let id = c.meta.id.as_str();
        let rels = ws.save_media_many(P, &[MediaUpload { name_hint: "a.png".into(), bytes: b"1".to_vec() }, MediaUpload { name_hint: "b.jpg".into(), bytes: b"2".to_vec() }]).unwrap();
        assert_eq!(rels.len(), 2);
        assert!(rels[1].ends_with(".jpg"));
        ws.add_attachment(P, id, img("i1", &rels[0])).unwrap();
        ws.add_attachment(P, id, img("i1", &rels[1])).unwrap(); // taken id → fresh one
        let c = ws.add_attachment(P, id, clip("", "https://a.b")).unwrap();
        assert_eq!(c.meta.attachments.len(), 3);
        let i2 = c.meta.attachments[1].id().to_string();
        let cl = c.meta.attachments[2].id().to_string();
        assert_ne!(i2, "i1");
        assert!(ws.add_attachment(P, id, img("", "C:/x.png")).is_err());

        let c = ws.update_attachment(P, id, &cl, &json!({"title": "A", "fetch_error": "timeout", "id": "hijack", "type": "image"})).unwrap();
        assert!(matches!(&c.meta.attachments[2], Attachment::Clip { id, title: Some(t), fetch_error: Some(_), .. } if id == &cl && t == "A"));
        let c = ws.update_attachment(P, id, &cl, &json!({"fetch_error": null})).unwrap();
        assert!(matches!(&c.meta.attachments[2], Attachment::Clip { fetch_error: None, .. }));
        assert!(ws.update_attachment(P, id, &cl, &json!({"thumb": "../t.png"})).is_err());
        assert!(matches!(ws.update_attachment(P, id, "nope", &json!({})), Err(AppError::NotFound(_))));

        let c = ws.reorder_attachments(P, id, &[cl.clone(), i2.clone()]).unwrap();
        let order: Vec<_> = c.meta.attachments.iter().map(|a| a.id().to_string()).collect();
        assert_eq!(order, [cl.clone(), i2.clone(), "i1".into()], "unlisted ones keep their order at the end");
        assert!(ws.reorder_attachments(P, id, &["nope".into()]).is_err());

        let c = ws.remove_attachment(P, id, "i1").unwrap();
        assert_eq!(c.meta.attachments.len(), 2);
        assert!(ws.root.join("projects/ideas").join(&rels[0]).is_file(), "media stays until the Trash is emptied");
        assert!(ws.remove_attachment(P, id, "i1").is_err());
    }

    #[test]
    fn empty_trash_sweeps_only_unreferenced_media() {
        let (_d, ws) = ws();
        let keep = ws.create_card(P, new_card("keep")).unwrap();
        let gone = ws.create_card(P, new_card("gone")).unwrap();
        let r = ws.save_media_many(P, &["a.png", "b.png", "c.png", "d.png"].map(|n| MediaUpload { name_hint: n.into(), bytes: vec![1] })).unwrap();
        ws.add_attachment(P, &keep.meta.id, img("", &r[0])).unwrap();
        ws.add_attachment(P, &keep.meta.id, img("x", &r[1])).unwrap();
        ws.remove_attachment(P, &keep.meta.id, "x").unwrap();
        ws.update_card(P, &keep.meta.id, CardPatch { body: Some(format!("![]({})", r[3])), ..Default::default() }).unwrap();
        ws.add_attachment(P, &gone.meta.id, img("", &r[2])).unwrap();
        ws.delete_card(P, &gone.meta.id).unwrap();
        // Trash keeps attachments: restore brings them back intact.
        let back = ws.restore_card(P, &gone.meta.id).unwrap();
        assert_eq!(back.meta.attachments.len(), 1);
        ws.delete_card(P, &gone.meta.id).unwrap();
        let media = |rel: &str| ws.root.join("projects/ideas").join(rel).is_file();
        assert!(media(&r[1]) && media(&r[2]), "nothing is swept before the Trash is emptied");
        ws.empty_trash(P).unwrap();
        assert!(media(&r[0]), "attached to a live card");
        assert!(media(&r[3]), "mentioned in a live body");
        assert!(!media(&r[1]), "removed attachment");
        assert!(!media(&r[2]), "only used by a card that was in the Trash");
    }

    #[test]
    fn handoff_target_is_remembered_confirmed_and_cleared() {
        let (d, ws) = ws();
        let p = ws.create_project("Fish").unwrap();
        let repo = d.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let path = repo.display().to_string();
        let patch = |t: Option<&str>, c: Option<&str>| ProjectPatch { handoff_target: t.map(Into::into), handoff_target_confirmed: c.map(Into::into), ..Default::default() };
        assert!(ws.update_project(&p.slug, patch(Some("relative/dir"), None)).is_err(), "must be an absolute, existing folder");
        assert!(ws.update_project(&p.slug, patch(Some(&d.path().join("nope").display().to_string()), None)).is_err());
        ws.update_project(&p.slug, patch(Some(&path), None)).unwrap();
        assert!(ws.update_project(&p.slug, patch(None, Some("C:/other"))).is_err(), "only the current target can be confirmed");
        ws.update_project(&p.slug, patch(None, Some(&path))).unwrap();
        let meta = ws.load_project(&p.slug).unwrap().meta;
        assert_eq!((meta.handoff_target.as_deref(), meta.handoff_target_confirmed.as_deref()), (Some(path.as_str()), Some(path.as_str())));
        ws.update_project(&p.slug, patch(Some(&path), None)).unwrap();
        assert!(ws.load_project(&p.slug).unwrap().meta.handoff_target_confirmed.is_some(), "re-setting the same folder keeps the confirmation");
        ws.update_project(&p.slug, ProjectPatch { name: Some("Fish 2".into()), ..Default::default() }).unwrap();
        assert_eq!(ws.load_project(&p.slug).unwrap().meta.handoff_target.as_deref(), Some(path.as_str()), "other edits keep it");
        ws.update_project(&p.slug, patch(Some(""), None)).unwrap();
        let meta = ws.load_project(&p.slug).unwrap().meta;
        assert!(meta.handoff_target.is_none() && meta.handoff_target_confirmed.is_none());
        // Unknown project.json keys survive.
        let pj = ws.project_dir(&p.slug).unwrap().join("project.json");
        let mut v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&pj).unwrap()).unwrap();
        v["mine"] = json!(1);
        fs::write(&pj, v.to_string()).unwrap();
        ws.update_project(&p.slug, ProjectPatch { name: Some("Fish 3".into()), ..Default::default() }).unwrap();
        assert!(fs::read_to_string(&pj).unwrap().contains("\"mine\""));
    }

    #[test]
    fn one_decisions_card_per_project() {
        let (_d, ws) = ws();
        let dec = |t: &str| NewCard { role: Some("decisions".into()), ..new_card(t) };
        assert_eq!(ws.create_card(P, dec("Project decisions")).unwrap().meta.role.as_deref(), Some(ROLE_DECISIONS));
        assert!(ws.create_card(P, dec("again")).is_err());
        assert!(ws.create_card(P, NewCard { role: Some("tech".into()), ..new_card("t") }).is_ok(), "roles are independent");
    }

    #[test]
    fn only_one_tech_card_per_project() {
        let (_d, ws) = ws();
        let tech = |t: &str| NewCard { role: Some("Tech".into()), ..new_card(t) };
        let a = ws.create_card(P, tech("a")).unwrap();
        assert_eq!(a.meta.role.as_deref(), Some(ROLE_TECH));
        assert!(matches!(ws.create_card(P, tech("b")), Err(AppError::Invalid(_))));
        assert!(ws.create_card(P, NewCard { role: Some("boss".into()), ..new_card("c") }).is_err());
        let b = ws.create_card(P, new_card("b")).unwrap();
        assert!(ws.update_card(P, &b.meta.id, CardPatch { role: Some("tech".into()), ..Default::default() }).is_err());
        assert!(ws.update_card(P, &a.meta.id, CardPatch { role: Some("tech".into()), title: Some("A".into()), ..Default::default() }).is_ok(), "re-setting its own role is fine");
        // Trashed tech card doesn't block; restoring it yields the role to the newer one.
        ws.delete_card(P, &a.meta.id).unwrap();
        ws.update_card(P, &b.meta.id, CardPatch { role: Some("tech".into()), ..Default::default() }).unwrap();
        assert_eq!(ws.restore_card(P, &a.meta.id).unwrap().meta.role, None);
        assert_eq!(ws.read_card(P, &a.meta.id).unwrap().meta.role, None);
        let other = ws.create_project("Other").unwrap();
        assert!(ws.create_card(&other.slug, tech("t")).is_ok(), "per project");
    }

    #[test]
    fn frames_save_and_old_canvas_files_load() {
        let (_d, ws) = ws();
        let p = ws.create_project("P").unwrap();
        let dir = ws.project_dir(&p.slug).unwrap();
        fs::write(dir.join("canvas.json"), r#"{"version":1,"viewport":{"x":0,"y":0,"zoom":1},"cards":{}}"#).unwrap();
        let mut data = ws.load_project(&p.slug).unwrap();
        assert!(data.canvas.frames.is_empty());
        assert_eq!(data.canvas.version, CANVAS_VERSION);
        data.canvas.frames.insert("f1".into(), Frame { x: 10.0, y: f64::NAN, w: 5.0, h: 600.0, title: "Combat".into(), color: Some("#f00".into()), z: 2 });
        ws.save_canvas(&p.slug, &data.canvas).unwrap();
        let f = ws.load_project(&p.slug).unwrap().canvas.frames["f1"].clone();
        assert_eq!(f, Frame { x: 10.0, y: 0.0, w: MIN_FRAME_SIDE, h: 600.0, title: "Combat".into(), color: Some("#f00".into()), z: 2 });
        let raw: Value = serde_json::from_str(&fs::read_to_string(dir.join("canvas.json")).unwrap()).unwrap();
        assert_eq!(raw["version"], CANVAS_VERSION);
    }

    #[test]
    fn model_settings_default_and_reset() {
        let (_d, ws) = ws();
        let s = ws.get_settings().unwrap();
        assert_eq!((s.model_chat.as_str(), s.model_export.as_str()), ("sonnet", "opus"));
        let s = ws.update_settings(SettingsPatch { model_chat: Some(" haiku ".into()), model_export: Some("claude-opus-5-5".into()), ..Default::default() }).unwrap();
        assert_eq!((s.model_chat.as_str(), s.model_export.as_str()), ("haiku", "claude-opus-5-5"));
        assert_eq!(ws.update_settings(SettingsPatch { model_chat: Some(String::new()), ..Default::default() }).unwrap().model_chat, "sonnet");
        assert!(ws.update_settings(SettingsPatch { model_chat: Some("two words".into()), ..Default::default() }).is_err());
        let s = ws.get_settings().unwrap();
        assert_eq!((s.model_router, s.model_fast.as_str(), s.model_deep.as_str()), (true, "haiku", "opus"));
        let s = ws.update_settings(SettingsPatch { model_router: Some(false), model_fast: Some("claude-haiku-4-5".into()), ..Default::default() }).unwrap();
        assert_eq!((s.model_router, s.model_fast.as_str()), (false, "claude-haiku-4-5"));
        assert!(ws.update_settings(SettingsPatch { model_chat: Some("two words".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn proposals_live_beside_the_card_and_go_with_it() {
        let (_d, ws) = ws();
        let c = ws.create_card(P, new_card("A")).unwrap();
        let id = c.meta.id.clone();
        ws.write_proposal(P, &id, &serde_json::json!({ "title": "B", "reason": "r" })).unwrap();
        ws.write_proposal(P, &id, &serde_json::json!({ "title": "C", "reason": "r" })).unwrap();
        let data = ws.load_project(P).unwrap();
        assert_eq!(data.proposals.len(), 1);
        assert_eq!(data.proposals[&id]["title"], "C", "a new proposal replaces the old one");
        assert_eq!(data.cards.len(), 1, "the proposal file is not read as a card");
        assert_eq!(ws.read_card(P, &id).unwrap().meta.title, "A", "the card file is untouched");
        ws.delete_proposal(P, &id).unwrap();
        ws.delete_proposal(P, &id).unwrap();
        assert!(ws.load_project(P).unwrap().proposals.is_empty());
        ws.write_proposal(P, &id, &serde_json::json!({ "body": "x" })).unwrap();
        ws.delete_card(P, &id).unwrap();
        assert!(!ws.root.join(format!("projects/ideas/cards/{id}.proposal.json")).exists(), "trashing the card drops its proposal");
        assert!(ws.write_proposal(P, "01NOSUCHCARD", &serde_json::json!({})).is_err());
    }

    #[test]
    fn card_frames_use_the_card_centre_and_topmost_frame() {
        let (_d, ws) = ws();
        let a = ws.create_card(P, NewCard { x: Some(0.0), y: Some(0.0), ..new_card("A") }).unwrap();
        let b = ws.create_card(P, NewCard { x: Some(2000.0), y: Some(0.0), ..new_card("B") }).unwrap();
        let mut data = ws.load_project(P).unwrap();
        data.canvas.frames.insert("f1".into(), Frame { x: 100.0, y: 50.0, w: 400.0, h: 400.0, title: "Low".into(), color: None, z: 1 });
        data.canvas.frames.insert("f2".into(), Frame { x: 100.0, y: 50.0, w: 400.0, h: 400.0, title: " ".into(), color: None, z: 5 });
        ws.save_canvas(P, &data.canvas).unwrap();
        let frames = ws.card_frames(P).unwrap();
        assert_eq!(frames.get(&a.meta.id).map(String::as_str), Some("Untitled frame"), "centre (118, 75) is inside; topmost wins");
        assert!(!frames.contains_key(&b.meta.id));
    }
}
