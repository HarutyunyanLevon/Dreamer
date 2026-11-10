//! Plain-file storage: workspace, projects, Inbox, cards, canvas, trash.
//! Everything is human-readable and git-friendly; all writes are atomic (temp file + rename).

use crate::error::{AppError, Result};
use crate::model::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const INBOX_SLUG: &str = "inbox";
const GRID_DX: f64 = 264.0;
const GRID_DY: f64 = 196.0;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------- low-level helpers ----------

/// Write `bytes` to `path` atomically: temp file in the same directory, fsync, rename over the target.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
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

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
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
    /// Open (and, if needed, create) a workspace folder.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let ws = Workspace { root: root.into() };
        for d in [ws.root.clone(), ws.root.join("projects"), ws.root.join("themes")] {
            fs::create_dir_all(&d).map_err(|e| AppError::io(format!("create {}", d.display()), e))?;
        }
        if !ws.root.join("workspace.json").exists() {
            write_json(&ws.root.join("workspace.json"), &Settings::default())?;
        }
        ws.ensure_inbox()?;
        Ok(ws)
    }

    fn ensure_inbox(&self) -> Result<()> {
        let dir = self.root.join(INBOX_SLUG);
        if !dir.join("project.json").exists() {
            self.init_project_dir(&dir, "Inbox")?;
        } else {
            Self::ensure_subdirs(&dir)?;
        }
        Ok(())
    }

    fn ensure_subdirs(dir: &Path) -> Result<()> {
        for sub in ["cards", "media", "briefs", "trash"] {
            let d = dir.join(sub);
            fs::create_dir_all(&d).map_err(|e| AppError::io(format!("create {}", d.display()), e))?;
        }
        Ok(())
    }

    fn init_project_dir(&self, dir: &Path, name: &str) -> Result<()> {
        Self::ensure_subdirs(dir)?;
        write_json(&dir.join("project.json"), &ProjectMeta { name: name.into(), theme: None, created: now() })?;
        let canvas = Canvas { viewport: Viewport { x: 300.0, y: 110.0, zoom: 1.0 }, ..Canvas::default() };
        write_json(&dir.join("canvas.json"), &canvas)?;
        write_json(&dir.join("trash").join("trash.json"), &TrashIndex::default())?;
        Ok(())
    }

    pub fn project_dir(&self, slug: &str) -> Result<PathBuf> {
        check_slug(slug)?;
        Ok(if slug == INBOX_SLUG { self.root.join(INBOX_SLUG) } else { self.root.join("projects").join(slug) })
    }

    fn existing_project_dir(&self, slug: &str) -> Result<PathBuf> {
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
        if let Some(h) = patch.hotkey {
            if h.trim().is_empty() {
                return Err(AppError::Invalid("hotkey cannot be empty".into()));
            }
            s.hotkey = h;
        }
        if let Some(p) = patch.last_project {
            s.last_project = if p.is_empty() { None } else { Some(p) };
        }
        write_json(&self.root.join("workspace.json"), &s)?;
        Ok(s)
    }

    // ----- projects -----

    fn card_count(dir: &Path) -> usize {
        fs::read_dir(dir.join("cards"))
            .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().extension().is_some_and(|x| x == "md")).count())
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
                is_inbox: slug == INBOX_SLUG,
            },
            created,
        ))
    }

    /// Inbox first, then projects by creation time.
    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        let mut out = vec![self.summary(INBOX_SLUG, &self.root.join(INBOX_SLUG))?.0];
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
        out.extend(rest.into_iter().map(|(s, _)| s));
        Ok(out)
    }

    pub fn create_project(&self, name: &str) -> Result<ProjectSummary> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("project name cannot be empty".into()));
        }
        if name.chars().count() > 120 {
            return Err(AppError::Invalid("project name is too long".into()));
        }
        let base = slugify(name);
        for n in 1..1000 {
            let slug = match (n, base.as_str()) {
                (1, INBOX_SLUG) => continue, // reserved
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

    pub fn update_project(&self, slug: &str, patch: ProjectPatch) -> Result<ProjectSummary> {
        let dir = self.existing_project_dir(slug)?;
        let mut meta = read_json_or_default_meta(&dir.join("project.json"), slug)?;
        if let Some(n) = patch.name {
            let n = n.trim();
            if n.is_empty() {
                return Err(AppError::Invalid("project name cannot be empty".into()));
            }
            if slug != INBOX_SLUG {
                meta.name = n.to_string();
            }
        }
        if let Some(t) = patch.theme {
            meta.theme = if t.is_empty() { None } else { Some(t) };
        }
        write_json(&dir.join("project.json"), &meta)?;
        Ok(self.summary(slug, &dir)?.0)
    }

    // ----- canvas -----

    fn read_canvas(dir: &Path) -> Result<Canvas> {
        read_json_or_default(&dir.join("canvas.json"))
    }

    pub fn save_canvas(&self, slug: &str, canvas: &Canvas) -> Result<()> {
        let dir = self.existing_project_dir(slug)?;
        write_json(&dir.join("canvas.json"), canvas)
    }

    /// First free grid slot, so new cards never stack exactly on top of each other.
    fn next_free_pos(canvas: &Canvas) -> Pos {
        for k in 0usize.. {
            let p = Pos { x: (k % 4) as f64 * GRID_DX, y: (k / 4) as f64 * GRID_DY };
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
            if stem.starts_with('.') {
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

    /// Load everything the canvas needs. Cards created outside the app get a position here.
    pub fn load_project(&self, slug: &str) -> Result<ProjectData> {
        let dir = self.existing_project_dir(slug)?;
        let meta = read_json_or_default_meta(&dir.join("project.json"), slug)?;
        let mut canvas = Self::read_canvas(&dir)?;
        let (cards, warnings) = Self::list_cards_in(&dir);

        let mut changed = false;
        let live: std::collections::HashSet<&str> = cards.iter().map(|c| c.meta.id.as_str()).collect();
        let before = canvas.cards.len();
        canvas.cards.retain(|id, _| live.contains(id.as_str()));
        changed |= canvas.cards.len() != before;
        for c in &cards {
            if !canvas.cards.contains_key(&c.meta.id) {
                let p = Self::next_free_pos(&canvas);
                canvas.cards.insert(c.meta.id.clone(), p);
                changed = true;
            }
        }
        if changed {
            write_json(&dir.join("canvas.json"), &canvas)?;
        }
        Ok(ProjectData { slug: slug.into(), is_inbox: slug == INBOX_SLUG, meta, canvas, cards, warnings })
    }

    pub fn create_card(&self, slug: &str, new: NewCard) -> Result<Card> {
        let dir = self.existing_project_dir(slug)?;
        let id = ulid::Ulid::generate().to_string();
        let stamp = now();
        let title = new.title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled".into());
        let card = Card {
            meta: Frontmatter {
                id: id.clone(),
                title,
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
                extra: Default::default(),
            },
            body: norm_body(&new.body.unwrap_or_default()),
        };
        Self::write_card_file(&Self::card_path(&dir, &id)?, &card)?;
        let mut canvas = Self::read_canvas(&dir)?;
        let pos = match (new.x, new.y) {
            (Some(x), Some(y)) => Pos { x, y },
            _ => Self::next_free_pos(&canvas),
        };
        canvas.cards.insert(id, pos);
        write_json(&dir.join("canvas.json"), &canvas)?;
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
        card.meta.updated = now();
        Self::write_card_file(&path, &card)?;
        Ok(card)
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
        let mut idx = Self::read_trash(&dir)?;
        idx.items.retain(|i| i.id != id);
        idx.items.push(item.clone());
        Self::write_trash(&dir, &idx)?;
        if canvas.cards.remove(id).is_some() {
            write_json(&dir.join("canvas.json"), &canvas)?;
        }
        Ok(item)
    }

    pub fn list_trash(&self, slug: &str) -> Result<Vec<TrashItem>> {
        let dir = self.existing_project_dir(slug)?;
        Ok(Self::read_trash(&dir)?.items)
    }

    /// Restore an ordinary deleted card to its old position.
    pub fn restore_card(&self, slug: &str, id: &str) -> Result<Card> {
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
        write_json(&dir.join("canvas.json"), &canvas)?;
        idx.items.remove(pos_in_idx);
        Self::write_trash(&dir, &idx)?;
        Self::read_card_file(&dest, id)
    }

    /// Permanently remove everything in the Trash. Callers must have confirmed with the user.
    pub fn empty_trash(&self, slug: &str) -> Result<usize> {
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
        Ok(n)
    }
}

fn read_json_or_default_meta(path: &Path, slug: &str) -> Result<ProjectMeta> {
    let meta: Option<ProjectMeta> = match fs::read_to_string(path) {
        Ok(t) => serde_json::from_str(t.trim_start_matches('\u{feff}')).ok(),
        Err(_) => None,
    };
    Ok(meta.unwrap_or(ProjectMeta { name: slug.to_string(), theme: None, created: String::new() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn ws() -> (TempDir, Workspace) {
        let dir = TempDir::new().unwrap();
        let ws = Workspace::open(dir.path().join("Dreamer")).unwrap();
        (dir, ws)
    }

    fn new_card(title: &str) -> NewCard {
        NewCard { title: Some(title.into()), ..Default::default() }
    }

    #[test]
    fn open_creates_layout_and_inbox() {
        let (_d, ws) = ws();
        assert!(ws.root.join("workspace.json").is_file());
        assert!(ws.root.join("projects").is_dir());
        assert!(ws.root.join("themes").is_dir());
        for sub in ["cards", "media", "briefs", "trash"] {
            assert!(ws.root.join("inbox").join(sub).is_dir(), "{sub}");
        }
        assert!(ws.root.join("inbox/project.json").is_file());
        assert!(ws.root.join("inbox/canvas.json").is_file());
        let projects = ws.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        assert!(projects[0].is_inbox);
        // reopening keeps existing data
        ws.create_card(INBOX_SLUG, new_card("keep me")).unwrap();
        let again = Workspace::open(&ws.root).unwrap();
        assert_eq!(again.list_projects().unwrap()[0].card_count, 1);
    }

    #[test]
    fn settings_roundtrip_and_corrupt_file_is_backed_up() {
        let (_d, ws) = ws();
        let s = ws.update_settings(SettingsPatch { theme: Some("gold-sky".into()), last_project: Some("fish".into()), ..Default::default() }).unwrap();
        assert_eq!(s.theme, "gold-sky");
        assert_eq!(ws.get_settings().unwrap().last_project.as_deref(), Some("fish"));
        ws.update_settings(SettingsPatch { last_project: Some(String::new()), ..Default::default() }).unwrap();
        assert_eq!(ws.get_settings().unwrap().last_project, None);
        assert_eq!(ws.get_settings().unwrap().hotkey, "Ctrl+Shift+Space");
        assert!(ws.update_settings(SettingsPatch { theme: Some("  ".into()), ..Default::default() }).is_err());

        fs::write(ws.root.join("workspace.json"), "{ not json").unwrap();
        let s = ws.get_settings().unwrap();
        assert_eq!(s.theme, "pearl-glow");
        assert!(ws.root.join("workspace.json.bak").is_file());
    }

    #[test]
    fn projects_get_unique_slugs_and_inbox_is_reserved() {
        let (_d, ws) = ws();
        let a = ws.create_project("Fish-punk fishing!").unwrap();
        let b = ws.create_project("Fish-punk fishing!").unwrap();
        let i = ws.create_project("Inbox").unwrap();
        assert_eq!(a.slug, "fish-punk-fishing");
        assert_eq!(b.slug, "fish-punk-fishing-2");
        assert_eq!(i.slug, "inbox-2");
        assert!(ws.create_project("   ").is_err());
        let list = ws.list_projects().unwrap();
        assert!(list[0].is_inbox);
        assert_eq!(list.len(), 4);
        let u = ws.update_project(&a.slug, ProjectPatch { name: Some("Renamed".into()), theme: Some("iridescent".into()) }).unwrap();
        assert_eq!((u.name.as_str(), u.theme.as_deref()), ("Renamed", Some("iridescent")));
        let u = ws.update_project(&a.slug, ProjectPatch { theme: Some(String::new()), ..Default::default() }).unwrap();
        assert_eq!(u.theme, None);
        // inbox cannot be renamed
        let u = ws.update_project(INBOX_SLUG, ProjectPatch { name: Some("Nope".into()), ..Default::default() }).unwrap();
        assert_eq!(u.name, "Inbox");
    }

    #[test]
    fn slugs_and_ids_cannot_escape_the_workspace() {
        let (_d, ws) = ws();
        for bad in ["..", "../x", "a/b", "a\\b", "", "Up", ".hidden", "x y"] {
            assert!(ws.load_project(bad).is_err(), "{bad:?}");
        }
        for bad in ["../x", "a/b", "", "a.b", "a b"] {
            assert!(ws.read_card(INBOX_SLUG, bad).is_err(), "{bad:?}");
        }
        assert!(matches!(ws.load_project("nope"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn card_file_roundtrip_matches_the_documented_format() {
        let (_d, ws) = ws();
        let c = ws
            .create_card(
                INBOX_SLUG,
                NewCard {
                    title: Some("Harpoon rod".into()),
                    body: Some("# Notes\n\nTwo moods.\n\n---\n\nA rule above.".into()),
                    stage: Some(Stage::Draft),
                    tags: Some(vec!["weapon".into(), "core".into()]),
                    links: Some(vec![Link { to: "01OTHER".into(), label: Some("feeds".into()) }, Link { to: "01X".into(), label: None }]),
                    source: Some(Source::Claude),
                    ghost: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        let text = fs::read_to_string(ws.root.join(format!("inbox/cards/{}.md", c.meta.id))).unwrap();
        assert!(text.starts_with("---\nid: "), "{text}");
        assert!(text.contains("stage: draft"));
        assert!(text.contains("source: claude"));
        assert!(text.contains("ghost: true"));
        assert!(text.contains("- to: 01OTHER\n  label: feeds"));
        assert!(!text.contains("branch"), "branch omitted when unset");
        assert!(!text.contains('\r'));
        let back = ws.read_card(INBOX_SLUG, &c.meta.id).unwrap();
        assert_eq!(back, c);
        assert!(back.body.contains("A rule above."), "a --- rule in the body must not end the frontmatter");
        assert_eq!(c.meta.id.len(), 26, "ULID");
    }

    #[test]
    fn parser_is_tolerant_of_crlf_bom_missing_fields_and_unknown_keys() {
        let crlf = "\u{feff}---\r\nid: WRONG\r\ntitle: From Windows\r\nstage: Sketch\r\nnotes: keep me\r\n---\r\n\r\nBody line\r\n";
        let c = parse_card(crlf, "01ABC").unwrap();
        assert_eq!(c.meta.id, "01ABC", "file name is the id authority");
        assert_eq!(c.meta.title, "From Windows");
        assert_eq!(c.meta.stage, Stage::Sketch);
        assert_eq!(c.body, "Body line");
        assert_eq!(c.meta.extra.get("notes").and_then(|v| v.as_str()), Some("keep me"));
        assert!(serialize_card(&c).unwrap().contains("notes: keep me"), "unknown keys survive a rewrite");

        let plain = parse_card("# Just a note\n\nhello", "01Z").unwrap();
        assert_eq!(plain.meta.title, "Just a note");
        assert_eq!(plain.meta.stage, Stage::Cloud);
        assert_eq!(parse_card("", "01E").unwrap().meta.title, "Untitled");

        let weird = parse_card("---\nstage: banana\n---\nx", "01W").unwrap();
        assert_eq!(weird.meta.stage, Stage::Cloud);
        let empty_fm = parse_card("---\n---\nbody", "01F").unwrap();
        assert_eq!(empty_fm.body, "body");
        let no_body = parse_card("---\ntitle: T\n---", "01G").unwrap();
        assert_eq!((no_body.meta.title.as_str(), no_body.body.as_str()), ("T", ""));
        assert!(parse_card("---\ntitle: [unclosed\n---\nx", "01B").is_err());
    }

    #[test]
    fn update_card_patches_and_preserves_the_rest() {
        let (_d, ws) = ws();
        let c = ws.create_card(INBOX_SLUG, NewCard { title: Some("A".into()), body: Some("body".into()), tags: Some(vec!["t".into()]), ..Default::default() }).unwrap();
        let u = ws.update_card(INBOX_SLUG, &c.meta.id, CardPatch { stage: Some(Stage::Pitch), title: Some("  B ".into()), ..Default::default() }).unwrap();
        assert_eq!(u.meta.title, "B");
        assert_eq!(u.meta.stage, Stage::Pitch);
        assert_eq!(u.body, "body");
        assert_eq!(u.meta.tags, vec!["t"]);
        assert_eq!(u.meta.created, c.meta.created);
        assert!(u.meta.updated >= c.meta.updated);
        assert!(matches!(ws.update_card(INBOX_SLUG, "01MISSING", CardPatch::default()), Err(AppError::NotFound(_))));
    }

    #[test]
    fn new_cards_are_placed_without_overlap_and_explicit_positions_are_kept() {
        let (_d, ws) = ws();
        let a = ws.create_card(INBOX_SLUG, new_card("a")).unwrap();
        let b = ws.create_card(INBOX_SLUG, new_card("b")).unwrap();
        let c = ws.create_card(INBOX_SLUG, NewCard { x: Some(900.0), y: Some(-40.0), ..new_card("c") }).unwrap();
        let data = ws.load_project(INBOX_SLUG).unwrap();
        let pa = data.canvas.cards[&a.meta.id];
        let pb = data.canvas.cards[&b.meta.id];
        assert_ne!(pa, pb);
        assert_eq!(data.canvas.cards[&c.meta.id], Pos { x: 900.0, y: -40.0 });
        assert_eq!(data.cards.len(), 3);
    }

    #[test]
    fn externally_added_and_removed_cards_are_reconciled_on_load() {
        let (_d, ws) = ws();
        let a = ws.create_card(INBOX_SLUG, new_card("a")).unwrap();
        // a card dropped in by Claude Code / git, and a corrupt one
        fs::write(ws.root.join("inbox/cards/01EXTERNAL.md"), "---\ntitle: External\nstage: sketch\n---\nhi\n").unwrap();
        fs::write(ws.root.join("inbox/cards/01BROKEN.md"), "---\ntitle: [oops\n---\n").unwrap();
        fs::write(ws.root.join("inbox/cards/notes.txt"), "ignored").unwrap();
        let data = ws.load_project(INBOX_SLUG).unwrap();
        assert_eq!(data.cards.len(), 2);
        assert!(data.canvas.cards.contains_key("01EXTERNAL"));
        assert_eq!(data.warnings.len(), 1);
        assert!(data.warnings[0].contains("01BROKEN"));
        // removed outside the app: position dropped
        fs::remove_file(ws.root.join(format!("inbox/cards/{}.md", a.meta.id))).unwrap();
        let data = ws.load_project(INBOX_SLUG).unwrap();
        assert!(!data.canvas.cards.contains_key(&a.meta.id));
        // positions were persisted
        let on_disk: Canvas = serde_json::from_str(&fs::read_to_string(ws.root.join("inbox/canvas.json")).unwrap()).unwrap();
        assert!(on_disk.cards.contains_key("01EXTERNAL"));
    }

    #[test]
    fn delete_goes_to_trash_and_restore_returns_card_to_old_position() {
        let (_d, ws) = ws();
        let c = ws.create_card(INBOX_SLUG, NewCard { x: Some(123.0), y: Some(456.0), ..new_card("doomed") }).unwrap();
        let id = c.meta.id.clone();
        let item = ws.delete_card(INBOX_SLUG, &id).unwrap();
        assert_eq!(item.reason, "deleted");
        assert!(!ws.root.join(format!("inbox/cards/{id}.md")).exists());
        assert!(ws.root.join(format!("inbox/trash/{id}.md")).is_file());
        let data = ws.load_project(INBOX_SLUG).unwrap();
        assert!(data.cards.is_empty() && data.canvas.cards.is_empty());
        let trash = ws.list_trash(INBOX_SLUG).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].title, "doomed");

        let back = ws.restore_card(INBOX_SLUG, &id).unwrap();
        assert_eq!(back.meta.title, "doomed");
        let data = ws.load_project(INBOX_SLUG).unwrap();
        assert_eq!(data.canvas.cards[&id], Pos { x: 123.0, y: 456.0 });
        assert!(ws.list_trash(INBOX_SLUG).unwrap().is_empty());
        assert!(ws.restore_card(INBOX_SLUG, &id).is_err());
        assert!(matches!(ws.delete_card(INBOX_SLUG, "01NOPE"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn trash_reason_label_and_empty_trash() {
        let (_d, ws) = ws();
        let a = ws.create_card(INBOX_SLUG, new_card("loser")).unwrap();
        let b = ws.create_card(INBOX_SLUG, new_card("gone")).unwrap();
        ws.trash_card(INBOX_SLUG, &a.meta.id, "lost to Winner").unwrap();
        ws.delete_card(INBOX_SLUG, &b.meta.id).unwrap();
        let reasons: Vec<_> = ws.list_trash(INBOX_SLUG).unwrap().into_iter().map(|i| i.reason).collect();
        assert_eq!(reasons, vec!["lost to Winner", "deleted"]);
        assert_eq!(ws.empty_trash(INBOX_SLUG).unwrap(), 2);
        assert!(ws.list_trash(INBOX_SLUG).unwrap().is_empty());
        assert!(!ws.root.join(format!("inbox/trash/{}.md", a.meta.id)).exists());
        assert!(ws.root.join("inbox/trash/trash.json").is_file());
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
        let rel = ws.save_media(INBOX_SLUG, "photo.PNG", b"\x89PNG-ish").unwrap();
        assert!(rel.starts_with("media/") && rel.ends_with(".png"));
        assert_eq!(ws.read_project_file(INBOX_SLUG, &rel).unwrap(), b"\x89PNG-ish");
        assert!(ws.read_project_file(INBOX_SLUG, "../../etc/passwd").is_err());
        assert!(ws.read_project_file(INBOX_SLUG, "media/nope.png").is_err());
    }

    #[test]
    fn slugify_handles_odd_names() {
        assert_eq!(slugify("  Hello,   World!! "), "hello-world");
        assert_eq!(slugify("***"), "project");
        assert_eq!(slugify("Ünï Cödé 2"), "n-c-d-2");
    }
}
