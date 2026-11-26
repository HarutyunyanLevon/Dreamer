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

    pub(super) fn writable(&self) -> Result<()> {
        match self.read_only() {
            Some(why) => Err(AppError::Invalid(format!("Dreamer is read-only right now. {why}"))),
            None => Ok(()),
        }
    }

    pub(super) fn ensure_subdirs(dir: &Path) -> Result<()> {
        // (Older projects also have an unused `briefs/` folder from the removed brief export.)
        for sub in ["cards", "media", "trash"] {
            let d = dir.join(sub);
            fs::create_dir_all(&d).map_err(|e| AppError::io(format!("create {}", d.display()), e))?;
        }
        Ok(())
    }

    pub(super) fn init_project_dir(&self, dir: &Path, name: &str) -> Result<()> {
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


    pub(super) fn card_count(dir: &Path) -> usize {
        fs::read_dir(dir.join("cards"))
            .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().extension().is_some_and(|x| x == "md") && !e.file_name().to_string_lossy().ends_with(".built.md")).count())
            .unwrap_or(0)
    }

    pub(super) fn summary(&self, slug: &str, dir: &Path) -> Result<(ProjectSummary, String)> {
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


mod chats;
mod canvas;
mod cards;
mod media;
mod trashbin;
#[cfg(test)]
mod tests;
