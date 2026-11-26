//! The project handoff pack: turns the cards in a scope into versioned design docs that Claude
//! Code can build from.
//!
//! Two one-shot Claude sessions run in the sidecar (separate from the chat threads), each with the
//! `model_export` model and read-only tools answered here:
//! - **gap check**: reads the cards, calls `report_gaps` once with a status per checklist item;
//! - **generation**: reads the cards, looks at every image, and hands each doc to
//!   `write_design_doc(name, markdown)`. Claude has no file access: the docs are kept in memory and
//!   only written when the session ends successfully, as `<project>/design/v<N>/` (built in a temp
//!   folder and renamed into place), then optionally copied into a repo (`docs/design/` + a marked
//!   block in the repo's `CLAUDE.md`). A cancelled or failed run writes nothing.

use crate::error::{AppError, Result};
use crate::model::{Attachment, Card, CardKind, ProjectData, Stage, ROLES};
use crate::storage::build;
use crate::state::AppState;
use crate::storage::{atomic_write, now, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// The docs generation must write, in reading order.
pub const DOC_NAMES: [&str; 7] = ["00-overview.md", "01-gdd.md", "02-tech-design.md", "03-roadmap.md", "04-open-questions.md", "05-assets.md", "CLAUDE.md"];
/// Written by Claude too (from the previous version's manifest and headings), but optional: a
/// default is used when it is missing.
pub const CHANGELOG: &str = "CHANGELOG.md";
pub const BLOCK_BEGIN: &str = "<!-- dreamer:begin -->";
pub const BLOCK_END: &str = "<!-- dreamer:end -->";
/// Largest doc accepted from Claude (a runaway write shouldn't fill the disk).
const MAX_DOC_BYTES: usize = 400_000;

/// What the gap check judges, in order. The tech item is answered from the Tech card.
pub const CHECKLIST: [&str; 13] = [
    "core experience/feeling",
    "target player",
    "core loop",
    "key mechanics",
    "progression",
    "setting & tone",
    "art direction",
    "audio direction",
    "platform & tech",
    "scope & time budget",
    "monetization",
    "what makes it different",
    "top risks",
];

/// The doc name `write_design_doc` was given, if it is one of the allowed files.
pub fn check_doc_name(name: &str) -> Result<&'static str> {
    DOC_NAMES
        .iter()
        .chain(std::iter::once(&CHANGELOG))
        .find(|n| **n == name)
        .copied()
        .ok_or_else(|| AppError::Invalid(format!("{name:?} is not a design doc; use one of: {}, {CHANGELOG}", DOC_NAMES.join(", "))))
}

// ---------- scope ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Scope {
    Project,
    Selection { ids: Vec<String> },
    Frames { ids: Vec<String> },
    /// A card plus the cards linked to it (both directions, up to two steps).
    Card { id: String },
}

fn find_frame<'a>(data: &'a ProjectData, id: &str) -> Option<&'a crate::model::Frame> {
    data.canvas.frames.get(id)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ScopeSpec {
    pub scope: Scope,
    /// Stages of plain cards to include (other kinds have no stage and are always included).
    pub stages: Vec<Stage>,
    #[serde(default)]
    pub include_stickies: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GapStatus {
    Ok,
    Thin,
    Missing,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Gap {
    pub item: String,
    pub status: GapStatus,
    #[serde(default)]
    pub note: String,
}

/// Default card size, mirroring CARD_W / CARD_H in src/components/cardGeometry.ts.
const CARD_W: f64 = 236.0;
const CARD_H: f64 = 150.0;
const LINK_DEPTH: usize = 2;

/// The in-scope card ids, in the project's card order. Ghosts are never included; the role cards
/// (Tech & constraints, Project decisions) always are, since they hold project-wide decisions.
pub fn resolve_scope(data: &ProjectData, spec: &ScopeSpec) -> Result<Vec<String>> {
    let live: Vec<&Card> = data.cards.iter().filter(|c| !c.meta.ghost).collect();
    let by_id: HashMap<&str, &Card> = live.iter().map(|c| (c.meta.id.as_str(), *c)).collect();
    let base: HashSet<String> = match &spec.scope {
        Scope::Project => live.iter().map(|c| c.meta.id.clone()).collect(),
        Scope::Selection { ids } => {
            let s: HashSet<String> = ids.iter().filter(|id| by_id.contains_key(id.as_str())).cloned().collect();
            if s.is_empty() {
                return Err(AppError::Invalid("none of the selected cards exist any more".into()));
            }
            s
        }
        Scope::Frames { ids } => {
            let mut frames = Vec::new();
            for id in ids {
                frames.push(find_frame(data, id).ok_or_else(|| AppError::NotFound(format!("frame {id}")))?);
            }
            if frames.is_empty() {
                return Err(AppError::Invalid("pick at least one frame".into()));
            }
            live.iter()
                .filter(|c| {
                    frames.iter().any(|f| {
                        data.canvas.cards.get(&c.meta.id).is_some_and(|p| {
                            let (cx, cy) = (p.x + p.w.unwrap_or(CARD_W) / 2.0, p.y + p.h.unwrap_or(CARD_H) / 2.0);
                            cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h
                        })
                    })
                })
                .map(|c| c.meta.id.clone())
                .collect()
        }
        Scope::Card { id } => {
            if !by_id.contains_key(id.as_str()) {
                return Err(AppError::NotFound(format!("card {id}")));
            }
            let mut seen: HashSet<String> = HashSet::from([id.clone()]);
            let mut queue = VecDeque::from([(id.clone(), 0usize)]);
            while let Some((cur, depth)) = queue.pop_front() {
                if depth == LINK_DEPTH {
                    continue;
                }
                let out = by_id.get(cur.as_str()).map(|c| c.meta.links.iter().map(|l| l.to.clone()).collect::<Vec<_>>()).unwrap_or_default();
                let inc = live.iter().filter(|c| c.meta.links.iter().any(|l| l.to == cur)).map(|c| c.meta.id.clone());
                for next in out.into_iter().chain(inc) {
                    if by_id.contains_key(next.as_str()) && seen.insert(next.clone()) {
                        queue.push_back((next, depth + 1));
                    }
                }
            }
            seen
        }
    };
    let keep = |c: &Card| {
        if c.meta.role.as_deref().is_some_and(|r| ROLES.contains(&r)) {
            return true;
        }
        if !base.contains(&c.meta.id) {
            return false;
        }
        match c.meta.kind {
            CardKind::Sticky => spec.include_stickies,
            CardKind::Card => spec.stages.contains(&c.meta.stage),
            // Artifacts enter the pack through approval (assets + 05-assets.md), not as cards.
            CardKind::Artifact => false,
            _ => true,
        }
    };
    Ok(live.into_iter().filter(|c| keep(c)).map(|c| c.meta.id.clone()).collect())
}

/// One line for the manifest, the prompt and the UI.
pub fn scope_label(data: &ProjectData, scope: &Scope) -> String {
    match scope {
        Scope::Project => "Whole project".into(),
        Scope::Selection { ids } => format!("Selection ({} card{})", ids.len(), if ids.len() == 1 { "" } else { "s" }),
        Scope::Frames { ids } => {
            let names: Vec<String> = ids.iter().filter_map(|id| find_frame(data, id)).map(|f| if f.title.trim().is_empty() { "Untitled frame".into() } else { f.title.trim().to_string() }).collect();
            format!("Frame{}: {}", if names.len() == 1 { "" } else { "s" }, names.join(", "))
        }
        Scope::Card { id } => {
            let title = data.cards.iter().find(|c| &c.meta.id == id).map(|c| c.meta.title.clone()).unwrap_or_else(|| id.clone());
            format!("\"{title}\" and its linked cards")
        }
    }
}

/// The file name an attachment's media file gets under `assets/` (`media/a/b.png` -> `a-b.png`).
pub fn asset_name(media_path: &str) -> String {
    media_path.strip_prefix("media/").unwrap_or(media_path).replace('/', "-")
}

/// Every media file the pack copies for a card: images, and clips' favicons and thumbnails.
fn card_assets(card: &Card) -> Vec<String> {
    let mut out = Vec::new();
    for a in &card.meta.attachments {
        match a {
            Attachment::Image { path, .. } => out.push(path.clone()),
            Attachment::Clip { favicon, thumb, .. } => out.extend([favicon, thumb].into_iter().flatten().cloned()),
        }
    }
    out
}

// ---------- design/index.json and versions ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct IndexEntry {
    pub version: u32,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub docs: Vec<String>,
    #[serde(default)]
    pub cards: usize,
    /// The project version (folder id) this revision is of; "" in a project without versions.
    #[serde(default)]
    pub version_id: String,
    #[serde(default)]
    pub version_title: String,
    /// Folder under design/ holding this version's revisions (`design/<dir>/r<N>/`); "" = the old
    /// flat layout `design/v<N>/` (projects without versions, i.e. the Inbox).
    #[serde(default)]
    pub dir: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct DesignIndex {
    #[serde(default)]
    pub versions: Vec<IndexEntry>,
}

/// design/index.json, oldest first. Missing or unreadable = no versions (lenient, hand-editable).
pub fn read_index(project_dir: &Path) -> DesignIndex {
    let mut idx: DesignIndex = fs::read_to_string(project_dir.join("design").join("index.json")).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()).unwrap_or_default();
    idx.versions.sort_by_key(|v| v.version);
    idx
}

/// One more than the highest version in the index *or* on disk (a `v<N>` folder whose index entry
/// was lost still counts, so it is never overwritten).
#[cfg_attr(not(test), allow(dead_code))]
pub fn next_version(project_dir: &Path) -> u32 {
    next_revision(project_dir, "")
}

/// The next revision of the version stored under `design/<dir>/` ("" = the flat `design/v<N>/`).
pub fn next_revision(project_dir: &Path, dir: &str) -> u32 {
    let from_index = read_index(project_dir).versions.iter().filter(|v| v.dir == dir).map(|v| v.version).max().unwrap_or(0);
    let (base, prefix) = if dir.is_empty() { (project_dir.join("design"), 'v') } else { (project_dir.join("design").join(dir), 'r') };
    let from_dirs = fs::read_dir(base)
        .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().to_string_lossy().strip_prefix(prefix).and_then(|n| n.parse::<u32>().ok())).max().unwrap_or(0))
        .unwrap_or(0);
    from_index.max(from_dirs) + 1
}

/// Where the next pack goes: where the project's last one went (an older project may have used
/// `design/<version>/r<N>/`), as (version id, version title, dir); "" = `design/v<N>/`.
pub fn pack_dir(project_dir: &Path) -> (String, String, String) {
    let last = read_index(project_dir).versions.into_iter().max_by(|a, b| a.created.cmp(&b.created)).unwrap_or_default();
    (last.version_id, last.version_title, last.dir)
}

pub fn revision_dir(project_dir: &Path, dir: &str, rev: u32) -> PathBuf {
    if dir.is_empty() { project_dir.join("design").join(format!("v{rev}")) } else { project_dir.join("design").join(dir).join(format!("r{rev}")) }
}

/// A version title as a folder name under design/ (letters, digits, '-', '_', '.'; spaces become '-').
pub fn dir_name(title: &str) -> String {
    let s: String = title.trim().chars().map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' }).collect();
    let s = s.trim_matches(['-', '.']).chars().take(60).collect::<String>();
    if s.is_empty() { "version".into() } else { s }
}


/// Everything one version holds, ready to write.
pub struct Pack {
    pub docs: BTreeMap<String, String>,
    /// (name under assets/, source file)
    pub assets: Vec<(String, PathBuf)>,
    pub manifest: Value,
    pub entry: IndexEntry,
}

/// Writes `design/v<N>/` all at once: everything goes into a hidden temp folder first, which is
/// renamed into place, so a version is either complete or absent. Then index.json is updated
/// (atomically). Missing asset sources are skipped and reported.
pub fn write_version(project_dir: &Path, pack: &Pack) -> Result<(PathBuf, Vec<String>)> {
    let design = project_dir.join("design");
    let target = revision_dir(project_dir, &pack.entry.dir, pack.entry.version);
    if target.exists() {
        return Err(AppError::Invalid(format!("{} already exists", target.display())));
    }
    let parent = target.parent().unwrap_or(&design).to_path_buf();
    let tmp = parent.join(format!(".r{}.{}.tmp", pack.entry.version, ulid::Ulid::generate()));
    let mut warnings = Vec::new();
    let res = (|| -> Result<()> {
        fs::create_dir_all(tmp.join("assets")).map_err(|e| AppError::io("create the design folder", e))?;
        for (name, text) in &pack.docs {
            atomic_write(&tmp.join(name), text.as_bytes())?;
        }
        for (name, src) in &pack.assets {
            match fs::read(src) {
                Ok(bytes) => atomic_write(&tmp.join("assets").join(name), &bytes)?,
                Err(e) => warnings.push(format!("asset {name} was not copied: {e}")),
            }
        }
        write_json(&tmp.join("manifest.json"), &pack.manifest)?;
        fs::rename(&tmp, &target).map_err(|e| AppError::io(format!("move the new version into {}", target.display()), e))
    })();
    if let Err(e) = res {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let mut idx = read_index(project_dir);
    idx.versions.retain(|v| !(v.version == pack.entry.version && v.dir == pack.entry.dir));
    idx.versions.push(pack.entry.clone());
    idx.versions.sort_by(|a, b| a.created.cmp(&b.created).then(a.version.cmp(&b.version)));
    write_json(&design.join("index.json"), &idx)?;
    Ok((target, warnings))
}

/// Reads one doc of a revision (for the Design view). Only the known doc names can be read.
pub fn read_doc_in(project_dir: &Path, dir: &str, rev: u32, name: &str) -> Result<String> {
    check_doc_name(name)?;
    if !dir.is_empty() && (dir.contains(['/', '\\']) || dir.starts_with('.')) {
        return Err(AppError::Invalid(format!("invalid design folder {dir:?}")));
    }
    let path = revision_dir(project_dir, dir, rev).join(name);
    fs::read_to_string(&path).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { AppError::NotFound(format!("{}", path.display())) } else { AppError::io(format!("read {}", path.display()), e) })
}

/// The revision a new one is compared against: its manifest and each doc's headings.
pub struct Previous {
    /// "v1 r3" (or "v3" in the flat layout).
    pub label: String,
    pub manifest: Value,
    pub headings: Vec<(String, Vec<String>)>,
}

/// The last revision stored under `design/<dir>/`; for a version's first revision, the last
/// revision of the version it was created from (`from` = that version's id).
pub fn previous_in(project_dir: &Path, dir: &str, from: Option<&str>) -> Option<Previous> {
    let idx = read_index(project_dir);
    let e = idx.versions.iter().filter(|e| e.dir == dir).max_by_key(|e| e.version).or_else(|| from.and_then(|f| idx.versions.iter().filter(|e| e.version_id == f).max_by_key(|e| e.version)))?;
    let last = e.version;
    let label = if e.dir.is_empty() { format!("v{last}") } else { format!("{} r{last}", if e.version_title.is_empty() { &e.dir } else { &e.version_title }) };
    let dir = revision_dir(project_dir, &e.dir, last);
    let manifest = fs::read_to_string(dir.join("manifest.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let headings = DOC_NAMES
        .iter()
        .filter_map(|n| {
            let text = fs::read_to_string(dir.join(n)).ok()?;
            Some((n.to_string(), text.lines().filter(|l| l.starts_with('#')).map(|l| l.trim().to_string()).collect()))
        })
        .collect();
    Some(Previous { label, manifest, headings })
}

// ---------- repo target ----------

/// Replaces only the text between the dreamer markers in a repo's CLAUDE.md.
/// - no file / empty file: the file becomes just the block;
/// - exactly one begin marker followed by exactly one end marker: what is between them is replaced;
/// - no markers: the block is appended;
/// - anything else (an unmatched, repeated or reversed marker): the stray markers are removed and a
///   fresh block is appended. Text that sat inside the broken block is left in place, never deleted.
///
/// Returns the new text and a warning for the malformed case. Keeps the file's line endings.
pub fn replace_block(existing: Option<&str>, block: &str) -> (String, Option<String>) {
    let crlf = existing.is_some_and(|t| t.contains("\r\n"));
    let inner = block.replace("\r\n", "\n").replace(BLOCK_BEGIN, "").replace(BLOCK_END, "");
    let fresh = format!("{BLOCK_BEGIN}\n{}\n{BLOCK_END}", inner.trim_matches('\n'));
    let eol = |s: String| if crlf { s.replace("\r\n", "\n").replace('\n', "\r\n") } else { s };
    let Some(text) = existing.filter(|t| !t.trim().is_empty()) else { return (eol(format!("{fresh}\n")), None) };
    let begins: Vec<usize> = text.match_indices(BLOCK_BEGIN).map(|(i, _)| i).collect();
    let ends: Vec<usize> = text.match_indices(BLOCK_END).map(|(i, _)| i).collect();
    if begins.len() == 1 && ends.len() == 1 && begins[0] < ends[0] {
        let out = format!("{}{}{}", &text[..begins[0]], fresh, &text[ends[0] + BLOCK_END.len()..]);
        return (eol(out), None);
    }
    let append = |base: &str| {
        let base = base.trim_end_matches(['\n', '\r']);
        if base.trim().is_empty() { format!("{fresh}\n") } else { format!("{base}\n\n{fresh}\n") }
    };
    if begins.is_empty() && ends.is_empty() {
        return (eol(append(text)), None);
    }
    // Malformed: drop marker-only lines, and any marker text left inside other lines.
    let cleaned: Vec<&str> = text.lines().filter(|l| { let t = l.trim(); t != BLOCK_BEGIN && t != BLOCK_END }).collect();
    let cleaned = cleaned.join("\n").replace(BLOCK_BEGIN, "").replace(BLOCK_END, "");
    (
        eol(append(&cleaned)),
        Some("CLAUDE.md had unmatched Dreamer markers. They were removed and a fresh block was appended; the text that was inside the broken block was left as it was.".into()),
    )
}

pub const QUESTIONS_TEMPLATE: &str = "# Design questions\n\nQuestions Claude Code ran into while building. One per line:\n`- [ ] Q (task id): question — context`. Answer them in Dreamer, then generate a new design version.\n\n";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RepoResult {
    pub path: String,
    pub files: Vec<String>,
    pub questions_created: bool,
    pub warnings: Vec<String>,
}

/// Copies a version into a repo: the docs (except CLAUDE.md) and assets into `docs/design/`
/// (replacing those files only, nothing else there is touched), `docs/design/QUESTIONS.md` only if
/// it doesn't exist, and the CLAUDE.md doc into the marked block of `<repo>/CLAUDE.md`.
pub fn apply_to_repo(repo: &Path, version_dir: &Path, docs: &BTreeMap<String, String>, assets: &[String]) -> Result<RepoResult> {
    if !repo.is_dir() {
        return Err(AppError::NotFound(format!("the handoff folder {}", repo.display())));
    }
    let dd = repo.join("docs").join("design");
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    for (name, text) in docs.iter().filter(|(n, _)| n.as_str() != "CLAUDE.md") {
        atomic_write(&dd.join(name), text.as_bytes())?;
        files.push(format!("docs/design/{name}"));
    }
    for name in assets {
        match fs::read(version_dir.join("assets").join(name)) {
            Ok(bytes) => {
                atomic_write(&dd.join("assets").join(name), &bytes)?;
                files.push(format!("docs/design/assets/{name}"));
            }
            Err(e) => warnings.push(format!("asset {name} was not copied: {e}")),
        }
    }
    let questions_created = create_if_missing(&dd.join("QUESTIONS.md"), QUESTIONS_TEMPLATE)?;
    if questions_created {
        files.push("docs/design/QUESTIONS.md".into());
    }
    // Claude Code writes the build status here; Dreamer only ever creates it empty.
    if create_if_missing(&dd.join("STATUS.md"), build::STATUS_TEMPLATE)? {
        files.push("docs/design/STATUS.md".into());
    }
    if let Some(block) = docs.get("CLAUDE.md") {
        let path = repo.join("CLAUDE.md");
        let existing = match fs::read_to_string(&path) {
            Ok(t) => Some(t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(AppError::io(format!("read {}", path.display()), e)),
        };
        let (text, warn) = replace_block(existing.as_deref(), block);
        atomic_write(&path, text.as_bytes())?;
        files.push("CLAUDE.md".into());
        warnings.extend(warn);
    }
    Ok(RepoResult { path: repo.display().to_string(), files, questions_created, warnings })
}

/// Creates `path` with `text` unless it already exists (never overwrites). True when created.
pub fn create_if_missing(path: &Path, text: &str) -> Result<bool> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| AppError::io(format!("create {}", dir.display()), e))?;
    }
    match fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut f) => {
            f.write_all(text.as_bytes()).map_err(|e| AppError::io(format!("write {}", path.display()), e))?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(AppError::io(format!("create {}", path.display()), e)),
    }
}

// ---------- the running job ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Gaps,
    Generate,
    /// A build prompt for Claude Code (task.rs).
    Task,
}

pub struct Job {
    pub id: String,
    pub slug: String,
    pub mode: Mode,
    pub model: String,
    pub spec: ScopeSpec,
    pub label: String,
    pub cards: Vec<String>,
    /// The revision number (r<N>; v<N> in the flat layout).
    pub version: u32,
    /// The project version the pack is of ("" = none) and its folder under design/.
    pub ver_id: String,
    pub ver_title: String,
    pub dir: String,
    pub gaps_in: Vec<Gap>,
    pub gaps_out: Option<Vec<Gap>>,
    /// Hash of memory.md when the job started ("" = none); recorded in the manifest.
    pub memory_hash: String,
    pub docs: BTreeMap<String, String>,
    pub read: HashSet<String>,
    pub viewed: HashSet<String>,
    pub images: usize,
    /// Only in a build-prompt job.
    pub task: Option<crate::task::TaskState>,
}

pub(crate) fn emit(app: &AppHandle, job: &str, payload: Value) {
    let mut p = payload;
    p["job"] = json!(job);
    let _ = app.emit("handoff-event", p);
}

pub(crate) fn lock_job(state: &AppState) -> Result<std::sync::MutexGuard<'_, Option<Job>>> {
    state.claude.handoff.lock().map_err(|_| AppError::Invalid("handoff lock poisoned".into()))
}

fn image_count(data: &ProjectData, cards: &[String]) -> usize {
    data.cards.iter().filter(|c| cards.contains(&c.meta.id)).map(|c| c.meta.attachments.iter().filter(|a| matches!(a, Attachment::Image { .. })).count()).sum()
}

/// Starts a gap check or a generation. Only one handoff session runs at a time.
pub fn start(app: &AppHandle, state: &AppState, slug: &str, mode: Mode, spec: ScopeSpec, gaps: Vec<Gap>) -> Result<String> {
    crate::storage::check_slug(slug)?;
    if lock_job(state)?.is_some() {
        return Err(AppError::Invalid("A handoff session is already running. Wait for it or cancel it first.".into()));
    }
    let (data, frames, model, dir, memory) = {
        let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let model = ws.get_settings().map(|s| s.model_export).unwrap_or_else(|_| crate::model::DEFAULT_MODEL_EXPORT.into());
        (ws.load_project(slug)?, ws.card_frames(slug).unwrap_or_default(), model, ws.existing_project_dir(slug)?, ws.read_memory(slug))
    };
    let cards = resolve_scope(&data, &spec)?;
    if cards.is_empty() {
        return Err(AppError::Invalid("Nothing to summarize: no cards match this scope and these stages.".into()));
    }
    let (ver_id, ver_title, ddir) = pack_dir(&dir);
    let label = scope_label(&data, &spec.scope);
    let version = next_revision(&dir, &ddir);
    let prev = previous_in(&dir, &ddir, None);
    let tag = rev_label(&ver_title, version);
    let mut prompt = match mode {
        Mode::Gaps => gap_prompt(&data, &label, &spec, &cards, &frames, memory.as_deref()),
        Mode::Generate => gen_prompt(&data, &label, &spec, &cards, &frames, &tag, &gaps, prev.as_ref(), memory.as_deref()),
        Mode::Task => return Err(AppError::Invalid("Build prompts start with task::start.".into())),
    };
    if mode == Mode::Generate {
        let note = state.ws.lock().map(|ws| crate::artifacts::handoff(&ws, slug).prompt_note).unwrap_or_default();
        if !note.is_empty() {
            prompt.push_str(&format!("\nApproved visual artifacts (Dreamer copies their files and appends an 'Artifacts' and a 'Style guide' section to 05-assets.md itself; do not repeat those lists, but refer to these files where they matter, e.g. art direction in 01-gdd.md):{note}\n"));
        }
    }
    let id = format!("h{}", ulid::Ulid::generate());
    let images = image_count(&data, &cards);
    {
        let mut g = lock_job(state)?;
        if g.is_some() {
            return Err(AppError::Invalid("A handoff session is already running.".into()));
        }
        *g = Some(Job { id: id.clone(), slug: slug.into(), mode, model: model.clone(), spec, label, cards, version, ver_id, ver_title, dir: ddir, gaps_in: gaps, gaps_out: None, memory_hash: memory.as_deref().map(crate::memory::hash_of).unwrap_or_default(), docs: BTreeMap::new(), read: HashSet::new(), viewed: HashSet::new(), images, task: None });
    }
    if let Err(e) = crate::sidecar::ensure_started(app, state) {
        *lock_job(state)? = None;
        return Err(e);
    }
    crate::sidecar::write_line(state, &json!({ "type": "oneshot_start", "job": id, "mode": mode, "prompt": prompt, "model": model }));
    emit(app, &id, json!({ "type": "progress", "step": "reading", "read": 0, "total": 0, "images": images }));
    Ok(id)
}

/// "v2 r3" for a version's revision, "v3" in the flat layout.
pub fn rev_label(ver_title: &str, rev: u32) -> String {
    if ver_title.is_empty() { format!("v{rev}") } else { format!("{ver_title} r{rev}") }
}

/// Stops the running handoff session; whatever it produced is dropped.
pub fn cancel(state: &AppState) -> Result<()> {
    if let Some(job) = lock_job(state)?.take() {
        crate::sidecar::write_line(state, &json!({ "type": "oneshot_cancel", "job": job.id }));
    }
    Ok(())
}

/// A copy of what tool calls need, taken without holding the job lock during file IO.
struct JobView {
    slug: String,
    mode: Mode,
    cards: Vec<String>,
    /// A build prompt's cards to build (the other cards are context).
    build: Vec<String>,
}

fn view_of(state: &AppState, job_id: &str) -> Result<JobView> {
    let g = lock_job(state)?;
    match g.as_ref() {
        Some(j) if j.id == job_id => Ok(JobView { slug: j.slug.clone(), mode: j.mode, cards: j.cards.clone(), build: j.task.as_ref().map(|t| t.build.clone()).unwrap_or_default() }),
        _ => Err(AppError::Invalid("this handoff session was cancelled; stop now".into())),
    }
}

fn in_scope(v: &JobView, id: &str) -> Result<()> {
    if v.cards.iter().any(|c| c == id) { Ok(()) } else { Err(AppError::Invalid(format!("card {id} is not in this handoff's scope; use list_cards"))) }
}

/// In a build prompt: whether a card is to be built or only context (null elsewhere).
fn task_role(v: &JobView, id: &str) -> Value {
    if v.mode != Mode::Task {
        return Value::Null;
    }
    json!(if v.build.iter().any(|b| b == id) { "build" } else { "context, not to build" })
}

/// The handoff session's tools (`handoff_*` requests from the sidecar).
pub fn run_tool(app: &AppHandle, state: &AppState, tool: &str, input: Value) -> Result<Value> {
    let job_id = input.get("job").and_then(Value::as_str).unwrap_or_default().to_string();
    let v = view_of(state, &job_id)?;
    let ws_lock = || state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()));
    match tool {
        "handoff_list_cards" => {
            let (data, frames) = {
                let ws = ws_lock()?;
                (ws.load_project(&v.slug)?, ws.card_frames(&v.slug).unwrap_or_default())
            };
            let out: Vec<Value> = data
                .cards
                .iter()
                .filter(|c| v.cards.contains(&c.meta.id))
                .map(|c| {
                    json!({
                        "id": c.meta.id, "kind": c.meta.kind, "title": c.meta.title, "stage": c.meta.stage, "role": c.meta.role,
                        "unconfirmed": c.meta.kind == CardKind::Card && c.meta.stage == Stage::Mist,
                        "tags": c.meta.tags, "frame": frames.get(&c.meta.id),
                        "build_status": build::build_status(c), "needs_rebuild": build::is_dirty(c),
                        "images": c.meta.attachments.iter().filter(|a| matches!(a, Attachment::Image { .. })).count(),
                        "clips": c.meta.attachments.iter().filter(|a| matches!(a, Attachment::Clip { .. })).count(),
                        "task_role": task_role(&v, &c.meta.id),
                    })
                })
                .collect();
            Ok(Value::Array(out))
        }
        "handoff_read_card" => {
            let id = input.get("id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(id)?;
            in_scope(&v, id)?;
            let (card, data, frames) = {
                let ws = ws_lock()?;
                (ws.read_card(&v.slug, id)?, ws.load_project(&v.slug)?, ws.card_frames(&v.slug).unwrap_or_default())
            };
            let title_of = |to: &str| data.cards.iter().find(|c| c.meta.id == to).map(|c| c.meta.title.clone());
            let links: Vec<Value> = card.meta.links.iter().map(|l| json!({ "to": l.to, "title": title_of(&l.to), "label": l.label, "in_scope": v.cards.contains(&l.to) })).collect();
            let linked_from: Vec<Value> = data.cards.iter().filter(|c| !c.meta.ghost && c.meta.links.iter().any(|l| l.to == id)).map(|c| json!({ "id": c.meta.id, "title": c.meta.title, "in_scope": v.cards.contains(&c.meta.id) })).collect();
            let atts: Vec<Value> = card
                .meta
                .attachments
                .iter()
                .map(|a| match a {
                    Attachment::Image { id, path, caption } => json!({ "id": id, "type": "image", "caption": caption, "asset": format!("assets/{}", asset_name(path)) }),
                    Attachment::Clip { id, url, title, caption, site, description, favicon, thumb, excerpt, .. } => json!({
                        "id": id, "type": "clip", "url": url, "title": title, "caption": caption, "site": site, "description": description,
                        "has_excerpt": excerpt.is_some(),
                        "favicon_asset": favicon.as_deref().map(|p| format!("assets/{}", asset_name(p))),
                        "thumb_asset": thumb.as_deref().map(|p| format!("assets/{}", asset_name(p))),
                    }),
                })
                .collect();
            let (read, total) = {
                let mut g = lock_job(state)?;
                let j = g.as_mut().filter(|j| j.id == job_id).ok_or_else(|| AppError::Invalid("this handoff session was cancelled; stop now".into()))?;
                j.read.insert(id.to_string());
                (j.read.len(), j.cards.len())
            };
            emit(app, &job_id, json!({ "type": "progress", "step": "reading", "read": read, "total": total }));
            Ok(json!({
                "id": card.meta.id, "title": card.meta.title, "kind": card.meta.kind, "role": card.meta.role, "stage": card.meta.stage,
                "unconfirmed": card.meta.kind == CardKind::Card && card.meta.stage == Stage::Mist,
                "tags": card.meta.tags, "fields": card.meta.fields, "frame": frames.get(id), "body": card.body,
                "build": card.meta.extra.get("build").map(|b| json!({ "status": b.get("status"), "files": b.get("files"), "commits": b.get("commits"), "notes": b.get("notes"), "needs_rebuild": build::is_dirty(&card) })),
                "items": card.meta.items, "links": links, "linked_from": linked_from, "attachments": atts,
                "updated": card.meta.updated, "task_role": task_role(&v, id),
            }))
        }
        "handoff_view_attachment" => {
            let card = input.get("card_id").and_then(Value::as_str).unwrap_or_default();
            let att = input.get("attachment_id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(card)?;
            in_scope(&v, card)?;
            let out = crate::sidecar::view_attachment(state, &v.slug, card, att)?;
            if out.get("kind").and_then(Value::as_str) == Some("image") {
                let (viewed, total) = {
                    let mut g = lock_job(state)?;
                    let j = g.as_mut().filter(|j| j.id == job_id).ok_or_else(|| AppError::Invalid("this handoff session was cancelled; stop now".into()))?;
                    j.viewed.insert(format!("{card}/{att}"));
                    (j.viewed.len(), j.images)
                };
                emit(app, &job_id, json!({ "type": "progress", "step": "viewing", "viewed": viewed, "images": total }));
            }
            Ok(out)
        }
        "handoff_report_gaps" => {
            if v.mode != Mode::Gaps {
                return Err(AppError::Invalid("report_gaps is only for the gap check".into()));
            }
            let gaps: Vec<Gap> = serde_json::from_value(input.get("gaps").cloned().unwrap_or(Value::Null)).map_err(|e| AppError::Invalid(format!("gaps must be a list of {{item, status: ok|thin|missing, note}}: {e}")))?;
            let gaps = normalize_gaps(gaps);
            {
                let mut g = lock_job(state)?;
                if let Some(j) = g.as_mut().filter(|j| j.id == job_id) {
                    j.gaps_out = Some(gaps.clone());
                }
            }
            emit(app, &job_id, json!({ "type": "gaps", "gaps": gaps }));
            Ok(json!("Recorded. The user now sees the list. End your turn with one short sentence."))
        }
        "handoff_report_progress" => {
            let step = input.get("step").and_then(Value::as_str).unwrap_or_default();
            let note = input.get("note").and_then(Value::as_str).unwrap_or_default();
            emit(app, &job_id, json!({ "type": "note", "step": step, "note": note }));
            Ok(json!("ok"))
        }
        "handoff_write_design_doc" => {
            if v.mode != Mode::Generate {
                return Err(AppError::Invalid("write_design_doc is only for generation".into()));
            }
            let name = check_doc_name(input.get("name").and_then(Value::as_str).unwrap_or_default())?;
            let md = input.get("markdown").and_then(Value::as_str).unwrap_or_default();
            if md.trim().is_empty() {
                return Err(AppError::Invalid("the markdown is empty".into()));
            }
            if md.len() > MAX_DOC_BYTES {
                return Err(AppError::Invalid(format!("{name} is too long ({} KB, max {} KB)", md.len() / 1000, MAX_DOC_BYTES / 1000)));
            }
            let written = {
                let mut g = lock_job(state)?;
                let j = g.as_mut().filter(|j| j.id == job_id).ok_or_else(|| AppError::Invalid("this handoff session was cancelled; stop now".into()))?;
                j.docs.insert(name.to_string(), md.replace("\r\n", "\n"));
                DOC_NAMES.iter().filter(|n| j.docs.contains_key(**n)).count()
            };
            emit(app, &job_id, json!({ "type": "progress", "step": "writing", "doc": name, "written": written, "of": DOC_NAMES.len() }));
            let left: Vec<&str> = {
                let g = lock_job(state)?;
                g.as_ref().map(|j| DOC_NAMES.iter().filter(|n| !j.docs.contains_key(**n)).copied().collect()).unwrap_or_default()
            };
            Ok(json!(if left.is_empty() { format!("Saved {name}. All docs are written; write CHANGELOG.md if you haven't, then end.") } else { format!("Saved {name}. Still to write: {}.", left.join(", ")) }))
        }
        "handoff_read_design_doc" | "handoff_write_task" => {
            if v.mode != Mode::Task {
                return Err(AppError::Invalid("this tool is only for build prompts".into()));
            }
            crate::task::run_tool(state, tool, &job_id, input)
        }
        other => Err(AppError::Invalid(format!("unknown handoff tool {other:?}"))),
    }
}

/// One entry per item (first wins), checklist order first, unknown items after.
fn normalize_gaps(gaps: Vec<Gap>) -> Vec<Gap> {
    let mut out: Vec<Gap> = Vec::new();
    for g in gaps {
        let item = g.item.trim().to_string();
        if item.is_empty() || out.iter().any(|o| o.item.eq_ignore_ascii_case(&item)) {
            continue;
        }
        out.push(Gap { item, note: g.note.trim().to_string(), ..g });
    }
    let rank = |g: &Gap| CHECKLIST.iter().position(|c| c.eq_ignore_ascii_case(&g.item)).unwrap_or(CHECKLIST.len());
    out.sort_by_key(rank);
    out
}

/// The sidecar finished (or failed, or was interrupted) a handoff session.
pub fn finish(app: &AppHandle, state: &AppState, msg: &Value) {
    let job_id = msg.get("job").and_then(Value::as_str).unwrap_or_default();
    let job = match lock_job(state) {
        Ok(mut g) if g.as_ref().is_some_and(|j| j.id == job_id) => g.take().expect("checked"),
        _ => return, // cancelled: already gone, output dropped
    };
    let ok = msg.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !ok {
        let m = msg.get("error").and_then(Value::as_str).unwrap_or("Claude stopped before finishing.");
        emit(app, &job.id, json!({ "type": "error", "message": m }));
        return;
    }
    match job.mode {
        Mode::Gaps => match &job.gaps_out {
            Some(_) => emit(app, &job.id, json!({ "type": "done", "mode": "gaps" })),
            None => emit(app, &job.id, json!({ "type": "error", "message": "Claude ended without reporting the gaps. Try again." })),
        },
        Mode::Task => {
            let id = job.id.clone();
            emit(app, &id, crate::task::done_event(job));
        }
        Mode::Generate => {
            let missing: Vec<&str> = DOC_NAMES.iter().filter(|n| !job.docs.contains_key(**n)).copied().collect();
            if !missing.is_empty() {
                emit(app, &job.id, json!({ "type": "error", "message": format!("Claude ended without writing {}. Nothing was saved; try again.", missing.join(", ")) }));
                return;
            }
            emit(app, &job.id, json!({ "type": "progress", "step": "copying" }));
            match finalize(state, &job) {
                Ok(v) => {
                    let mut v = v;
                    v["type"] = json!("done");
                    v["mode"] = json!("generate");
                    emit(app, &job.id, v);
                }
                Err(e) => emit(app, &job.id, json!({ "type": "error", "message": e.to_string() })),
            }
        }
    }
}

/// Writes the version folder and, when a confirmed repo target is set, copies it there.
fn finalize(state: &AppState, job: &Job) -> Result<Value> {
    let (docs, version_path, version, warnings, assets, target) = {
        let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let dir = ws.existing_project_dir(&job.slug)?;
        let data = ws.load_project(&job.slug)?;
        let version = next_revision(&dir, &job.dir).max(job.version);
        let tag = rev_label(&job.ver_title, version);
        let cards: Vec<&Card> = data.cards.iter().filter(|c| job.cards.contains(&c.meta.id)).collect();
        let mut assets: Vec<(String, PathBuf)> = Vec::new();
        for c in &cards {
            for p in card_assets(c) {
                let name = asset_name(&p);
                if !assets.iter().any(|(n, _)| n == &name) {
                    assets.push((name, dir.join(&p)));
                }
            }
        }
        // Approved artifacts and the active theme's style guide (written by Dreamer, not Claude).
        let art = crate::artifacts::handoff(&ws, &job.slug);
        for (n, p) in art.assets {
            if !assets.iter().any(|(x, _)| x == &n) {
                assets.push((n, p));
            }
        }
        let mut docs = job.docs.clone();
        if !art.section.is_empty() {
            if let Some(d) = docs.get_mut("05-assets.md") {
                d.push_str(&art.section);
                d.push('\n');
            }
        }
        docs.entry(CHANGELOG.to_string()).or_insert_with(|| format!("# Changelog\n\n## {tag}\n\n{}\n", if version == 1 { "Initial version" } else { "Regenerated from the current cards." }));
        // The repo's CLAUDE.md block names the version it was built from.
        if !job.ver_title.is_empty() {
            if let Some(d) = docs.get_mut("CLAUDE.md") {
                *d = format!("Design version: {} (revision r{version}, docs/design/)\n\n{}", job.ver_title, d.trim_start());
            }
        }
        let created = now();
        let manifest = json!({
            "version": version,
            "revision": version,
            "project_version": if job.ver_id.is_empty() { Value::Null } else { json!({ "id": job.ver_id, "title": job.ver_title }) },
            "created": created,
            "model": job.model,
            "scope": { "spec": job.spec.scope, "label": job.label },
            "stages": job.spec.stages,
            "include_stickies": job.spec.include_stickies,
            "cards": cards.iter().map(|c| json!({ "id": c.meta.id, "title": c.meta.title, "updated": c.meta.updated })).collect::<Vec<_>>(),
            "gaps": job.gaps_in,
            "memory_hash": job.memory_hash,
            "docs": docs.keys().collect::<Vec<_>>(),
            "assets": assets.iter().map(|(n, _)| n).collect::<Vec<_>>(),
        });
        let entry = IndexEntry { version, created, model: job.model.clone(), scope: job.label.clone(), docs: docs.keys().cloned().collect(), cards: cards.len(), version_id: job.ver_id.clone(), version_title: job.ver_title.clone(), dir: job.dir.clone() };
        let pack = Pack { docs, assets, manifest, entry };
        let (path, warnings) = write_version(&dir, &pack)?;
        let target = data.meta.handoff_target.clone().filter(|t| data.meta.handoff_target_confirmed.as_deref() == Some(t.as_str()));
        (pack.docs, path, version, warnings, pack.assets.into_iter().map(|(n, _)| n).collect::<Vec<_>>(), target)
    };
    // The workspace lock is released: the repo copy only touches the repo and the new version.
    let repo = target.map(|t| match apply_to_repo(Path::new(&t), &version_path, &docs, &assets) {
        Ok(r) => json!(r),
        Err(e) => json!({ "path": t, "error": e.to_string() }),
    });
    if repo.is_some() {
        if let Ok(ws) = state.ws.lock() {
            let _ = ws.write_link(&job.slug);
        }
    }
    Ok(json!({ "version": version, "label": rev_label(&job.ver_title, version), "design_dir": job.dir, "dir": version_path.display().to_string(), "warnings": warnings, "repo": repo }))
}

// ---------- prompts (the task message; the standing instructions live in the sidecar) ----------

pub(crate) fn card_lines(data: &ProjectData, cards: &[String], frames: &HashMap<String, String>) -> String {
    data.cards
        .iter()
        .filter(|c| cards.contains(&c.meta.id))
        .map(|c| {
            let mut bits = vec![format!("{:?}", c.meta.kind).to_lowercase()];
            if c.meta.kind == CardKind::Card {
                bits.push(format!("{:?}", c.meta.stage).to_lowercase());
            }
            if let Some(r) = &c.meta.role {
                bits.push(format!("role {r}"));
            }
            if c.meta.stage == Stage::Built {
                bits.push(if build::is_dirty(c) { "needs rebuild".into() } else if build::build_status(c) == Some("partial") { "partly built".into() } else { "built".into() });
            }
            if let Some(f) = frames.get(&c.meta.id) {
                bits.push(format!("frame \"{f}\""));
            }
            format!("- \"{}\" (id {}; {})", c.meta.title, c.meta.id, bits.join(", "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn stages_text(spec: &ScopeSpec) -> String {
    let s: Vec<String> = spec.stages.iter().map(|s| format!("{s:?}").to_lowercase()).collect();
    format!("{}{}", s.join(", "), if spec.include_stickies { "; stickies included" } else { "; stickies left out" })
}

/// The "From Claude Code" questions: answered ones are decisions, unanswered ones stay open.
fn cc_questions_text(data: &ProjectData) -> String {
    let items: Vec<_> = data.cards.iter().filter(|c| c.meta.role.as_deref() == Some(crate::model::ROLE_CC_QUESTIONS)).flat_map(|c| c.meta.items.clone()).collect();
    let (answered, open) = crate::questions::summary(&items);
    let mut out = String::new();
    if !answered.is_empty() {
        out.push_str("\nQuestions from Claude Code that the user has ANSWERED. Treat each answer as a decision (not a gap, not an open question): record it where it belongs and list it under decisions in 04-open-questions.md:\n");
        for (q, a) in &answered {
            out.push_str(&format!("- Q: {q}\n  A: {a}\n"));
        }
    }
    if !open.is_empty() {
        out.push_str("\nQuestions from Claude Code still unanswered (keep them as open questions):\n");
        for q in &open {
            out.push_str(&format!("- {q}\n"));
        }
    }
    out
}

/// The project memory as a primary source: what the user decided and rejected outranks Mist cards.
pub(crate) fn memory_text(memory: Option<&str>) -> String {
    match memory {
        Some(m) => format!("\nProject memory (memory.md; the user's own confirmed decisions). It is a PRIMARY source: 'Decisions' and 'Rejected' are authoritative and win over any Mist card that disagrees; 'Pillars', 'Pitch' and 'How to work with me' are confirmed too. Never list a rejected idea as a feature.\n---\n{m}\n---\n"),
        None => String::new(),
    }
}

pub fn gap_prompt(data: &ProjectData, label: &str, spec: &ScopeSpec, cards: &[String], frames: &HashMap<String, String>, memory: Option<&str>) -> String {
    format!(
        "Gap check for the project \"{}\".\nScope: {label}. Stages: {}.\n{}\nCards in scope ({}):\n{}\n{}\nChecklist (report every item, in this order, using these exact names):\n{}\n",
        data.meta.name,
        stages_text(spec),
        memory_text(memory),
        cards.len(),
        card_lines(data, cards, frames),
        cc_questions_text(data),
        CHECKLIST.iter().map(|c| format!("- {c}")).collect::<Vec<_>>().join("\n"),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn gen_prompt(data: &ProjectData, label: &str, spec: &ScopeSpec, cards: &[String], frames: &HashMap<String, String>, version: &str, gaps: &[Gap], prev: Option<&Previous>, memory: Option<&str>) -> String {
    let mut out = format!(
        "Write the handoff pack, {version}, for the project \"{}\".\nScope: {label}. Stages: {}.\n{}\nCards in scope ({}):\n{}\n",
        data.meta.name,
        stages_text(spec),
        memory_text(memory),
        cards.len(),
        card_lines(data, cards, frames),
    );
    let frame_names: Vec<&String> = {
        let mut v: Vec<&String> = cards.iter().filter_map(|id| frames.get(id)).collect();
        v.sort();
        v.dedup();
        v
    };
    if !frame_names.is_empty() {
        out.push_str(&format!("\nFrames (grouping hints for the GDD): {}\n", frame_names.iter().map(|f| format!("\"{f}\"")).collect::<Vec<_>>().join(", ")));
    }
    let images = image_count(data, cards);
    out.push_str(&format!("\nImages in scope: {images}. View every one before writing.\n"));
    out.push_str(&cc_questions_text(data));
    if gaps.is_empty() {
        out.push_str("\nNo gap check was run. Anything the cards leave undecided still becomes an explicit TBD and goes into 04-open-questions.md.\n");
    } else {
        out.push_str("\nKnown gaps from the gap check (each thin or missing item must appear as an explicit TBD in the relevant doc and in 04-open-questions.md):\n");
        for g in gaps {
            out.push_str(&format!("- {} [{}]: {}\n", g.item, format!("{:?}", g.status).to_lowercase(), g.note));
        }
    }
    match prev {
        None => out.push_str("\nThis is the first version: CHANGELOG.md says \"Initial version\".\n"),
        Some(p) => {
            out.push_str(&format!("\nPrevious revision: {}. Write CHANGELOG.md with a new top section \"## {version}\" listing what changed since {} (added, changed and removed material, in a few bullets), above the earlier entries summarized in one line each.\n", p.label, p.label));
            let old: Vec<(String, String, String)> = p.manifest.get("cards").and_then(Value::as_array).map(|a| a.iter().map(|c| (c["id"].as_str().unwrap_or_default().to_string(), c["title"].as_str().unwrap_or_default().to_string(), c["updated"].as_str().unwrap_or_default().to_string())).collect()).unwrap_or_default();
            let now_cards: Vec<&Card> = data.cards.iter().filter(|c| cards.contains(&c.meta.id)).collect();
            let added: Vec<String> = now_cards.iter().filter(|c| !old.iter().any(|o| o.0 == c.meta.id)).map(|c| format!("\"{}\"", c.meta.title)).collect();
            let changed: Vec<String> = now_cards.iter().filter(|c| old.iter().any(|o| o.0 == c.meta.id && o.2 != c.meta.updated)).map(|c| format!("\"{}\"", c.meta.title)).collect();
            let removed: Vec<String> = old.iter().filter(|o| !now_cards.iter().any(|c| c.meta.id == o.0)).map(|o| format!("\"{}\"", o.1)).collect();
            let list = |v: &Vec<String>| if v.is_empty() { "none".to_string() } else { v.join(", ") };
            out.push_str(&format!("Cards added since {}: {}\nCards edited since {}: {}\nCards no longer in scope: {}\n", p.label, list(&added), p.label, list(&changed), list(&removed)));
            out.push_str(&format!("Previous manifest: {}\n", serde_json::to_string(&p.manifest).unwrap_or_default()));
            out.push_str("Previous docs' headings:\n");
            for (doc, hs) in &p.headings {
                out.push_str(&format!("{doc}:\n{}\n", hs.iter().map(|h| format!("  {h}")).collect::<Vec<_>>().join("\n")));
            }
        }
    }
    out.push_str(&format!("\nWrite these files with write_design_doc, each exactly once: {}, then {CHANGELOG}.\n", DOC_NAMES.join(", ")));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Frame, Link, NewCard, Pos};
    use crate::storage::Workspace;
    const INBOX_SLUG: &str = "ideas";
    use tempfile::TempDir;

    fn spec(scope: Scope) -> ScopeSpec {
        ScopeSpec { scope, stages: vec![Stage::Mist, Stage::Reverie, Stage::Lucid, Stage::Dream, Stage::Built], include_stickies: false }
    }

    fn pack(version: u32) -> Pack {
        let docs: BTreeMap<String, String> = DOC_NAMES.iter().map(|n| (n.to_string(), format!("# {n}\n"))).collect();
        Pack { docs, assets: vec![], manifest: json!({ "version": version }), entry: IndexEntry { version, ..Default::default() } }
    }

    #[test]
    fn versions_number_up_from_the_index_and_the_folders() {
        let d = TempDir::new().unwrap();
        let p = d.path();
        assert_eq!(next_version(p), 1, "no design folder yet");
        write_version(p, &pack(1)).unwrap();
        assert_eq!(next_version(p), 2);
        assert!(p.join("design/v1/00-overview.md").is_file() && p.join("design/v1/manifest.json").is_file());
        assert!(write_version(p, &pack(1)).is_err(), "an existing version is never overwritten");
        // A folder whose index entry was lost still counts.
        fs::create_dir_all(p.join("design/v5")).unwrap();
        assert_eq!(next_version(p), 6);
        write_version(p, &pack(6)).unwrap();
        assert_eq!(read_index(p).versions.iter().map(|v| v.version).collect::<Vec<_>>(), vec![1, 6]);
        // A corrupt index falls back to the folders.
        fs::write(p.join("design/index.json"), "{nope").unwrap();
        assert_eq!(next_version(p), 7);
        // No temp folders left behind.
        assert!(fs::read_dir(p.join("design")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn missing_assets_are_reported_not_fatal() {
        let d = TempDir::new().unwrap();
        let src = d.path().join("a.png");
        fs::write(&src, b"png").unwrap();
        let mut pk = pack(1);
        pk.assets = vec![("a.png".into(), src), ("gone.png".into(), d.path().join("gone.png"))];
        let (dir, warnings) = write_version(d.path(), &pk).unwrap();
        assert_eq!(fs::read(dir.join("assets/a.png")).unwrap(), b"png");
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn claude_md_block_replacement() {
        let b = |s: &str| format!("{BLOCK_BEGIN}\n{s}\n{BLOCK_END}");
        // Absent file.
        assert_eq!(replace_block(None, "new"), (format!("{}\n", b("new")), None));
        assert_eq!(replace_block(Some("  \n"), "new\n").0, format!("{}\n", b("new")));
        // No markers: appended, user text kept.
        let (t, w) = replace_block(Some("# Mine\n\nKeep me.\n"), "new");
        assert_eq!(t, format!("# Mine\n\nKeep me.\n\n{}\n", b("new")));
        assert!(w.is_none());
        // Present: only the inside changes.
        let before = format!("# Mine\n\n{}\n\nAfter.\n", b("old\nstuff"));
        let (t, w) = replace_block(Some(&before), "new");
        assert_eq!(t, format!("# Mine\n\n{}\n\nAfter.\n", b("new")));
        assert!(w.is_none());
        // Idempotent.
        assert_eq!(replace_block(Some(&t), "new").0, t);
        // Claude's own markers inside the block can't nest.
        assert_eq!(replace_block(None, &b("x")).0, format!("{}\n", b("x")));
        // CRLF files keep CRLF.
        let (t, _) = replace_block(Some("# Mine\r\n"), "a\nb");
        assert_eq!(t, format!("# Mine\r\n\r\n{BLOCK_BEGIN}\r\na\r\nb\r\n{BLOCK_END}\r\n"));
        // Malformed: begin without end, end before begin, two begins.
        for bad in [
            format!("top\n{BLOCK_BEGIN}\ninside\nbottom\n"),
            format!("top\n{BLOCK_END}\nmid\n{BLOCK_BEGIN}\nbottom\n"),
            format!("top\n{BLOCK_BEGIN}\na\n{BLOCK_BEGIN}\nb\n{BLOCK_END}\n"),
        ] {
            let (t, w) = replace_block(Some(&bad), "new");
            assert!(w.is_some(), "{bad:?}");
            assert_eq!(t.matches(BLOCK_BEGIN).count(), 1, "{t:?}");
            assert_eq!(t.matches(BLOCK_END).count(), 1, "{t:?}");
            assert!(t.ends_with(&format!("{}\n", b("new"))), "{t:?}");
            assert!(t.starts_with("top\n"), "text before is kept: {t:?}");
            for keep in ["inside", "mid", "bottom", "a\n", "b\n"] {
                if bad.contains(keep) {
                    assert!(t.contains(keep), "{keep:?} kept in {t:?}");
                }
            }
            // And the next run is a clean replacement.
            assert!(replace_block(Some(&t), "again").1.is_none());
        }
    }

    #[test]
    fn repo_copy_replaces_only_pack_files_and_never_overwrites_questions() {
        let d = TempDir::new().unwrap();
        let project = d.path().join("p");
        let mut pk = pack(1);
        let img = d.path().join("img.png");
        fs::write(&img, b"img").unwrap();
        pk.assets = vec![("img.png".into(), img)];
        let (vdir, _) = write_version(&project, &pk).unwrap();
        let repo = d.path().join("repo");
        fs::create_dir_all(repo.join("docs/design")).unwrap();
        fs::write(repo.join("docs/design/mine.md"), "mine").unwrap();
        fs::write(repo.join("docs/design/01-gdd.md"), "stale").unwrap();
        fs::write(repo.join("CLAUDE.md"), "# Repo rules\n").unwrap();

        let r = apply_to_repo(&repo, &vdir, &pk.docs, &["img.png".into()]).unwrap();
        assert!(r.questions_created);
        assert_eq!(fs::read_to_string(repo.join("docs/design/01-gdd.md")).unwrap(), "# 01-gdd.md\n");
        assert_eq!(fs::read_to_string(repo.join("docs/design/mine.md")).unwrap(), "mine", "other files untouched");
        assert!(!repo.join("docs/design/CLAUDE.md").exists(), "CLAUDE.md goes to the repo root block");
        assert_eq!(fs::read(repo.join("docs/design/assets/img.png")).unwrap(), b"img");
        let claude = fs::read_to_string(repo.join("CLAUDE.md")).unwrap();
        assert!(claude.starts_with("# Repo rules\n") && claude.contains(BLOCK_BEGIN) && claude.contains("# CLAUDE.md"));

        // QUESTIONS.md with answers is never overwritten.
        fs::write(repo.join("docs/design/QUESTIONS.md"), "- [x] Q (M1-T1): answered").unwrap();
        let r = apply_to_repo(&repo, &vdir, &pk.docs, &[]).unwrap();
        assert!(!r.questions_created);
        assert_eq!(fs::read_to_string(repo.join("docs/design/QUESTIONS.md")).unwrap(), "- [x] Q (M1-T1): answered");
        assert!(!create_if_missing(&repo.join("docs/design/QUESTIONS.md"), "x").unwrap());
        // Second run replaced the block instead of adding another.
        assert_eq!(fs::read_to_string(repo.join("CLAUDE.md")).unwrap().matches(BLOCK_BEGIN).count(), 1);
        assert!(apply_to_repo(&d.path().join("nope"), &vdir, &pk.docs, &[]).is_err());
    }

    #[test]
    fn write_design_doc_names_are_checked() {
        for n in DOC_NAMES.iter().chain([&CHANGELOG]) {
            assert_eq!(check_doc_name(n).unwrap(), *n);
        }
        for bad in ["README.md", "../CLAUDE.md", "docs/01-gdd.md", "01-gdd", "claude.md", "", "QUESTIONS.md", "manifest.json", "01-gdd.md "] {
            assert!(check_doc_name(bad).is_err(), "{bad:?}");
        }
        let d = TempDir::new().unwrap();
        write_version(d.path(), &pack(1)).unwrap();
        assert!(read_doc_in(d.path(), "", 1, "01-gdd.md").is_ok());
        assert!(read_doc_in(d.path(), "", 1, "manifest.json").is_err());
        assert!(read_doc_in(d.path(), "", 1, "../../x").is_err());
    }

    #[test]
    fn scope_resolution() {
        let d = TempDir::new().unwrap();
        let ws = Workspace::open(d.path().join("w")).unwrap();
        let mk = |t: &str, f: NewCard| ws.create_card(INBOX_SLUG, NewCard { title: Some(t.into()), ..f }).unwrap().meta.id;
        let a = mk("a", NewCard { stage: Some(Stage::Dream), x: Some(0.0), y: Some(0.0), ..Default::default() });
        let b = mk("b", NewCard { links: Some(vec![Link { to: a.clone(), label: None }]), x: Some(2000.0), y: Some(0.0), ..Default::default() });
        let c = mk("c", NewCard { x: Some(4000.0), y: Some(0.0), ..Default::default() });
        let far = mk("far", NewCard { links: Some(vec![Link { to: b.clone(), label: None }]), ..Default::default() });
        let farther = mk("farther", NewCard { links: Some(vec![Link { to: far.clone(), label: None }]), ..Default::default() });
        let sticky = mk("s", NewCard { kind: Some(CardKind::Sticky), ..Default::default() });
        let ghost = mk("g", NewCard { ghost: Some(true), ..Default::default() });
        let tech = mk("t", NewCard { role: Some("tech".into()), x: Some(9000.0), y: Some(9000.0), ..Default::default() });
        let mut canvas = ws.load_project(INBOX_SLUG).unwrap().canvas;
        canvas.frames.insert("f1".into(), Frame { x: -10.0, y: -10.0, w: 300.0, h: 300.0, title: "Core".into(), ..Default::default() });
        canvas.cards.insert(a.clone(), Pos::at(0.0, 0.0));
        ws.save_canvas(INBOX_SLUG, &canvas).unwrap();
        let data = ws.load_project(INBOX_SLUG).unwrap();

        let all = resolve_scope(&data, &spec(Scope::Project)).unwrap();
        assert!(all.contains(&a) && all.contains(&c) && all.contains(&tech));
        assert!(!all.contains(&sticky) && !all.contains(&ghost), "no stickies (off) and never ghosts");
        assert!(resolve_scope(&data, &ScopeSpec { include_stickies: true, ..spec(Scope::Project) }).unwrap().contains(&sticky));

        let dream_only = resolve_scope(&data, &ScopeSpec { stages: vec![Stage::Dream], ..spec(Scope::Project) }).unwrap();
        assert_eq!(dream_only, vec![a.clone(), tech.clone()], "role cards always ride along");

        let from_a = resolve_scope(&data, &spec(Scope::Card { id: a.clone() })).unwrap();
        assert!(from_a.contains(&b) && from_a.contains(&far), "both directions, two steps");
        assert!(!from_a.contains(&farther) && !from_a.contains(&c));

        assert_eq!(resolve_scope(&data, &spec(Scope::Frames { ids: vec!["f1".into()] })).unwrap(), vec![a.clone(), tech.clone()]);
        assert!(resolve_scope(&data, &spec(Scope::Frames { ids: vec!["nope".into()] })).is_err());
        assert_eq!(resolve_scope(&data, &spec(Scope::Selection { ids: vec![c.clone(), "gone".into()] })).unwrap(), vec![c.clone(), tech.clone()]);
        assert!(resolve_scope(&data, &spec(Scope::Selection { ids: vec!["gone".into()] })).is_err());
        assert_eq!(scope_label(&data, &Scope::Frames { ids: vec!["f1".into()] }), "Frame: Core");
    }

    #[test]
    fn asset_names_flatten_media_paths() {
        assert_eq!(asset_name("media/abc.png"), "abc.png");
        assert_eq!(asset_name("media/clips/x-thumb.jpg"), "clips-x-thumb.jpg");
    }

    #[test]
    fn gaps_are_deduped_and_ordered_by_the_checklist() {
        let g = |item: &str, status| Gap { item: item.into(), status, note: " n ".into() };
        let out = normalize_gaps(vec![g("top risks", GapStatus::Thin), g("Core loop", GapStatus::Ok), g("core loop", GapStatus::Missing), g(" ", GapStatus::Ok), g("extra", GapStatus::Ok)]);
        assert_eq!(out.iter().map(|g| g.item.as_str()).collect::<Vec<_>>(), vec!["Core loop", "top risks", "extra"]);
        assert_eq!((out[0].status, out[0].note.as_str()), (GapStatus::Ok, "n"));
    }
}
