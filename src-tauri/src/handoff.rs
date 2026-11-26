//! The project handoff pack: turns the cards in a scope into design docs that Claude Code can
//! build from.
//!
//! One one-shot Claude session runs in the sidecar (separate from the chat threads) with the
//! `model_export` model and read-only tools answered here: it reads the cards, looks at every
//! image, and hands each doc to `write_design_doc(name, markdown)`. Claude has no file access: the
//! docs are kept in memory and only written when the session ends successfully, into the linked
//! repo folder (`docs/design/` + a marked block in the repo's `CLAUDE.md`), overwriting the last
//! pack. A cancelled or failed run writes nothing.

use crate::error::{AppError, Result};
use crate::model::{Attachment, Card, CardKind, ProjectData, Stage, ROLES};
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
pub const BLOCK_BEGIN: &str = "<!-- dreamer:begin -->";
pub const BLOCK_END: &str = "<!-- dreamer:end -->";
/// Largest doc accepted from Claude (a runaway write shouldn't fill the disk).
const MAX_DOC_BYTES: usize = 400_000;

/// The doc name `write_design_doc` was given, if it is one of the allowed files.
pub fn check_doc_name(name: &str) -> Result<&'static str> {
    DOC_NAMES
        .iter()
        .find(|n| **n == name)
        .copied()
        .ok_or_else(|| AppError::Invalid(format!("{name:?} is not a design doc; use one of: {}", DOC_NAMES.join(", "))))
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

// ---------- the pack ----------

/// Everything one pack holds, ready to write.
pub struct Pack {
    pub docs: BTreeMap<String, String>,
    /// (name under assets/, source file)
    pub assets: Vec<(String, PathBuf)>,
    pub manifest: Value,
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

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RepoResult {
    pub path: String,
    pub files: Vec<String>,
    pub warnings: Vec<String>,
}

/// Writes the pack into a repo, replacing the last one: the docs (except CLAUDE.md), the assets and
/// manifest.json into `docs/design/` (only those files; nothing else there is touched), and the
/// CLAUDE.md doc into the marked block of `<repo>/CLAUDE.md`. Missing asset sources are skipped
/// and reported.
pub fn write_pack(repo: &Path, pack: &Pack) -> Result<RepoResult> {
    if !repo.is_dir() {
        return Err(AppError::NotFound(format!("the handoff folder {}", repo.display())));
    }
    let dd = repo.join("docs").join("design");
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    for (name, text) in pack.docs.iter().filter(|(n, _)| n.as_str() != "CLAUDE.md") {
        atomic_write(&dd.join(name), text.as_bytes())?;
        files.push(format!("docs/design/{name}"));
    }
    for (name, src) in &pack.assets {
        match fs::read(src) {
            Ok(bytes) => {
                atomic_write(&dd.join("assets").join(name), &bytes)?;
                files.push(format!("docs/design/assets/{name}"));
            }
            Err(e) => warnings.push(format!("asset {name} was not copied: {e}")),
        }
    }
    write_json(&dd.join("manifest.json"), &pack.manifest)?;
    files.push("docs/design/manifest.json".into());
    if let Some(block) = pack.docs.get("CLAUDE.md") {
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
    Ok(RepoResult { path: repo.display().to_string(), files, warnings })
}

// ---------- the running job ----------

pub struct Job {
    pub id: String,
    pub slug: String,
    pub model: String,
    pub spec: ScopeSpec,
    pub label: String,
    pub cards: Vec<String>,
    /// The confirmed repo folder the pack is written into.
    pub repo: PathBuf,
    /// Hash of memory.md when the job started ("" = none); recorded in the manifest.
    pub memory_hash: String,
    pub docs: BTreeMap<String, String>,
    pub read: HashSet<String>,
    pub viewed: HashSet<String>,
    pub images: usize,
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

/// Starts a generation. Only one handoff session runs at a time. Needs a linked, confirmed repo folder.
pub fn start(app: &AppHandle, state: &AppState, slug: &str, spec: ScopeSpec) -> Result<String> {
    crate::storage::check_slug(slug)?;
    if lock_job(state)?.is_some() {
        return Err(AppError::Invalid("A handoff session is already running. Wait for it or cancel it first.".into()));
    }
    let (data, frames, model, memory) = {
        let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let model = ws.get_settings().map(|s| s.model_export).unwrap_or_else(|_| crate::model::DEFAULT_MODEL_EXPORT.into());
        (ws.load_project(slug)?, ws.card_frames(slug).unwrap_or_default(), model, ws.read_memory(slug))
    };
    let repo = data
        .meta
        .handoff_target
        .clone()
        .filter(|t| data.meta.handoff_target_confirmed.as_deref() == Some(t.as_str()))
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Invalid("Link a repo folder first: the design pack is written there.".into()))?;
    if !repo.is_dir() {
        return Err(AppError::NotFound(format!("the handoff folder {}", repo.display())));
    }
    let cards = resolve_scope(&data, &spec)?;
    if cards.is_empty() {
        return Err(AppError::Invalid("Nothing to summarize: no cards match this scope and these stages.".into()));
    }
    let label = scope_label(&data, &spec.scope);
    let mut prompt = gen_prompt(&data, &label, &spec, &cards, &frames, memory.as_deref());
    let note = state.ws.lock().map(|ws| crate::artifacts::handoff(&ws, slug).prompt_note).unwrap_or_default();
    if !note.is_empty() {
        prompt.push_str(&format!("\nApproved visual artifacts (Dreamer copies their files and appends an 'Artifacts' and a 'Style guide' section to 05-assets.md itself; do not repeat those lists, but refer to these files where they matter, e.g. art direction in 01-gdd.md):{note}\n"));
    }
    let id = format!("h{}", ulid::Ulid::generate());
    let images = image_count(&data, &cards);
    {
        let mut g = lock_job(state)?;
        if g.is_some() {
            return Err(AppError::Invalid("A handoff session is already running.".into()));
        }
        *g = Some(Job { id: id.clone(), slug: slug.into(), model: model.clone(), spec, label, cards, repo, memory_hash: memory.as_deref().map(crate::memory::hash_of).unwrap_or_default(), docs: BTreeMap::new(), read: HashSet::new(), viewed: HashSet::new(), images });
    }
    if let Err(e) = crate::sidecar::ensure_started(app, state) {
        *lock_job(state)? = None;
        return Err(e);
    }
    crate::sidecar::write_line(state, &json!({ "type": "oneshot_start", "job": id, "prompt": prompt, "model": model }));
    emit(app, &id, json!({ "type": "progress", "step": "reading", "read": 0, "total": 0, "images": images }));
    Ok(id)
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
    cards: Vec<String>,
}

fn view_of(state: &AppState, job_id: &str) -> Result<JobView> {
    let g = lock_job(state)?;
    match g.as_ref() {
        Some(j) if j.id == job_id => Ok(JobView { slug: j.slug.clone(), cards: j.cards.clone() }),
        _ => Err(AppError::Invalid("this handoff session was cancelled; stop now".into())),
    }
}

fn in_scope(v: &JobView, id: &str) -> Result<()> {
    if v.cards.iter().any(|c| c == id) { Ok(()) } else { Err(AppError::Invalid(format!("card {id} is not in this handoff's scope; use list_cards"))) }
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
                        "images": c.meta.attachments.iter().filter(|a| matches!(a, Attachment::Image { .. })).count(),
                        "clips": c.meta.attachments.iter().filter(|a| matches!(a, Attachment::Clip { .. })).count(),
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
                "items": card.meta.items, "links": links, "linked_from": linked_from, "attachments": atts,
                "updated": card.meta.updated,
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
        "handoff_report_progress" => {
            let step = input.get("step").and_then(Value::as_str).unwrap_or_default();
            let note = input.get("note").and_then(Value::as_str).unwrap_or_default();
            emit(app, &job_id, json!({ "type": "note", "step": step, "note": note }));
            Ok(json!("ok"))
        }
        "handoff_write_design_doc" => {
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
            Ok(json!(if left.is_empty() { format!("Saved {name}. All docs are written; end your turn.") } else { format!("Saved {name}. Still to write: {}.", left.join(", ")) }))
        }
        other => Err(AppError::Invalid(format!("unknown handoff tool {other:?}"))),
    }
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
    let missing: Vec<&str> = DOC_NAMES.iter().filter(|n| !job.docs.contains_key(**n)).copied().collect();
    if !missing.is_empty() {
        emit(app, &job.id, json!({ "type": "error", "message": format!("Claude ended without writing {}. Nothing was saved; try again.", missing.join(", ")) }));
        return;
    }
    emit(app, &job.id, json!({ "type": "progress", "step": "copying" }));
    match finalize(state, &job) {
        Ok(mut v) => {
            v["type"] = json!("done");
            emit(app, &job.id, v);
        }
        Err(e) => emit(app, &job.id, json!({ "type": "error", "message": e.to_string() })),
    }
}

/// Writes the pack into the repo folder.
fn finalize(state: &AppState, job: &Job) -> Result<Value> {
    let pack = {
        let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let dir = ws.existing_project_dir(&job.slug)?;
        let data = ws.load_project(&job.slug)?;
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
        let manifest = json!({
            "created": now(),
            "model": job.model,
            "scope": { "spec": job.spec.scope, "label": job.label },
            "stages": job.spec.stages,
            "cards": cards.iter().map(|c| json!({ "id": c.meta.id, "title": c.meta.title, "updated": c.meta.updated })).collect::<Vec<_>>(),
            "memory_hash": job.memory_hash,
            "docs": docs.keys().collect::<Vec<_>>(),
            "assets": assets.iter().map(|(n, _)| n).collect::<Vec<_>>(),
        });
        Pack { docs, assets, manifest }
    };
    // The workspace lock is released: the copy only touches the repo.
    Ok(json!(write_pack(&job.repo, &pack)?))
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
            if let Some(f) = frames.get(&c.meta.id) {
                bits.push(format!("frame \"{f}\""));
            }
            format!("- \"{}\" (id {}; {})", c.meta.title, c.meta.id, bits.join(", "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn stages_text(spec: &ScopeSpec) -> String {
    spec.stages.iter().map(|s| format!("{s:?}").to_lowercase()).collect::<Vec<_>>().join(", ")
}

/// The project memory as a primary source: what the user decided and rejected outranks Mist cards.
pub(crate) fn memory_text(memory: Option<&str>) -> String {
    match memory {
        Some(m) => format!("\nProject memory (memory.md; the user's own confirmed decisions). It is a PRIMARY source: 'Decisions' and 'Rejected' are authoritative and win over any Mist card that disagrees; 'Pillars', 'Pitch' and 'How to work with me' are confirmed too. Never list a rejected idea as a feature.\n---\n{m}\n---\n"),
        None => String::new(),
    }
}

pub fn gen_prompt(data: &ProjectData, label: &str, spec: &ScopeSpec, cards: &[String], frames: &HashMap<String, String>, memory: Option<&str>) -> String {
    let mut out = format!(
        "Write the handoff pack for the project \"{}\".\nScope: {label}. Stages: {}.\n{}\nCards in scope ({}):\n{}\n",
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
    out.push_str("\nAnything the cards leave undecided becomes an explicit TBD and goes into 04-open-questions.md.\n");
    out.push_str(&format!("\nWrite these files with write_design_doc, each exactly once: {}.\n", DOC_NAMES.join(", ")));
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
        ScopeSpec { scope, stages: vec![Stage::Mist, Stage::Reverie, Stage::Lucid, Stage::Dream, Stage::Built] }
    }

    fn pack() -> Pack {
        let docs: BTreeMap<String, String> = DOC_NAMES.iter().map(|n| (n.to_string(), format!("# {n}
"))).collect();
        Pack { docs, assets: vec![], manifest: json!({ "version": 1 }) }
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
    fn the_pack_replaces_only_its_own_files_in_the_repo_each_time() {
        let d = TempDir::new().unwrap();
        let mut pk = pack();
        let img = d.path().join("img.png");
        fs::write(&img, b"img").unwrap();
        pk.assets = vec![("img.png".into(), img), ("gone.png".into(), d.path().join("gone.png"))];
        let repo = d.path().join("repo");
        fs::create_dir_all(repo.join("docs/design")).unwrap();
        fs::write(repo.join("docs/design/mine.md"), "mine").unwrap();
        fs::write(repo.join("docs/design/01-gdd.md"), "stale").unwrap();
        fs::write(repo.join("CLAUDE.md"), "# Repo rules
").unwrap();

        let r = write_pack(&repo, &pk).unwrap();
        assert_eq!(r.warnings.len(), 1, "a missing asset is reported, not fatal");
        assert_eq!(fs::read_to_string(repo.join("docs/design/01-gdd.md")).unwrap(), "# 01-gdd.md
");
        assert_eq!(fs::read_to_string(repo.join("docs/design/mine.md")).unwrap(), "mine", "other files untouched");
        assert!(!repo.join("docs/design/CLAUDE.md").exists(), "CLAUDE.md goes to the repo root block");
        assert_eq!(fs::read(repo.join("docs/design/assets/img.png")).unwrap(), b"img");
        assert!(repo.join("docs/design/manifest.json").is_file());
        let claude = fs::read_to_string(repo.join("CLAUDE.md")).unwrap();
        assert!(claude.starts_with("# Repo rules
") && claude.contains(BLOCK_BEGIN) && claude.contains("# CLAUDE.md"));
        // Written again: overwritten in place, still one block.
        write_pack(&repo, &pack()).unwrap();
        assert_eq!(fs::read_to_string(repo.join("CLAUDE.md")).unwrap().matches(BLOCK_BEGIN).count(), 1);
        assert!(write_pack(&d.path().join("nope"), &pack()).is_err());
    }

    #[test]
    fn write_design_doc_names_are_checked() {
        for n in DOC_NAMES.iter() {
            assert_eq!(check_doc_name(n).unwrap(), *n);
        }
        for bad in ["README.md", "../CLAUDE.md", "docs/01-gdd.md", "01-gdd", "claude.md", "", "QUESTIONS.md", "manifest.json", "01-gdd.md ", "CHANGELOG.md"] {
            assert!(check_doc_name(bad).is_err(), "{bad:?}");
        }
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
        let ghost = mk("g", NewCard { ghost: Some(true), ..Default::default() });
        let tech = mk("t", NewCard { role: Some("tech".into()), x: Some(9000.0), y: Some(9000.0), ..Default::default() });
        let mut canvas = ws.load_project(INBOX_SLUG).unwrap().canvas;
        canvas.frames.insert("f1".into(), Frame { x: -10.0, y: -10.0, w: 300.0, h: 300.0, title: "Core".into(), ..Default::default() });
        canvas.cards.insert(a.clone(), Pos::at(0.0, 0.0));
        ws.save_canvas(INBOX_SLUG, &canvas).unwrap();
        let data = ws.load_project(INBOX_SLUG).unwrap();

        let all = resolve_scope(&data, &spec(Scope::Project)).unwrap();
        assert!(all.contains(&a) && all.contains(&c) && all.contains(&tech));
        assert!(!all.contains(&ghost), "never ghosts");

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
}
