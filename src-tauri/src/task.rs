//! "Make build prompt": a one-shot Claude session (`model_export`, read-only tools) turns the chosen
//! cards, plus their one-hop links as context, into a stand-alone task for Claude Code. Claude has
//! no file access: it hands the markdown to `write_task`, the app shows it for editing and writes
//! `<repo>/docs/design/tasks/<yyyy-mm-dd>-<slug>.md` only when the user saves. Saving queues the cards.
//! The diff of a rebuild card is inserted by the app (a `{{DIFF:<id>}}` placeholder), never by Claude.

use crate::error::{AppError, Result};
use crate::handoff::{self, Job, Mode, Scope, ScopeSpec};
use crate::model::{Card, CardKind, Stage};
use crate::state::AppState;
use crate::storage::{atomic_write, build, check_id, now, Workspace};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const MAX_TASK_BYTES: usize = 400_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Flag {
    #[serde(default)]
    pub card_id: Option<String>,
    pub text: String,
}

pub struct TaskOut {
    pub markdown: String,
    pub title: String,
    pub card_ids: Vec<String>,
    pub flags: Vec<Flag>,
}

/// What a task job needs beyond the handoff job.
#[derive(Default)]
pub struct TaskState {
    /// The cards to build; the rest of the job's cards are context.
    pub build: Vec<String>,
    /// Rebuild cards (dirty): id -> diff of the built snapshot against the saved card.
    pub diffs: BTreeMap<String, String>,
    /// The latest design revision of the job's version: (folder under design/, revision).
    pub design: Option<(String, u32)>,
    pub out: Option<TaskOut>,
}

// ---------- diff ----------

/// A line diff (`+`, `-`, two spaces for context): changed lines with one line of context each side.
pub fn line_diff(old: &str, new: &str) -> String {
    let (a, b): (Vec<&str>, Vec<&str>) = (old.lines().collect(), new.lines().collect());
    let (n, m) = (a.len(), b.len());
    let mut t = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            t[i][j] = if a[i] == b[j] { t[i + 1][j + 1] + 1 } else { t[i + 1][j].max(t[i][j + 1]) };
        }
    }
    let mut ops: Vec<(char, &str)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push((' ', a[i]));
            i += 1;
            j += 1;
        } else if t[i + 1][j] >= t[i][j + 1] {
            ops.push(('-', a[i]));
            i += 1;
        } else {
            ops.push(('+', b[j]));
            j += 1;
        }
    }
    ops.extend(a[i..].iter().map(|l| ('-', *l)));
    ops.extend(b[j..].iter().map(|l| ('+', *l)));
    let changed = |k: usize| ops[k].0 != ' ';
    let mut out: Vec<String> = Vec::new();
    let mut skipped = false;
    for k in 0..ops.len() {
        if changed(k) || (k > 0 && changed(k - 1)) || (k + 1 < ops.len() && changed(k + 1)) {
            if skipped {
                out.push("  …".into());
                skipped = false;
            }
            out.push(if ops[k].0 == ' ' { format!("  {}", ops[k].1) } else { format!("{} {}", ops[k].0, ops[k].1) });
        } else {
            skipped = true;
        }
    }
    out.join("\n")
}

fn placeholder(id: &str) -> String {
    format!("{{{{DIFF:{id}}}}}")
}

fn diff_block(title: &str, id: &str, diff: &str) -> String {
    format!("**{title}** (card {id}):\n\n```diff\n{diff}\n```")
}

// ---------- the job ----------

fn dedup(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|i| seen.insert(i.clone())).collect()
}

/// Starts the one-shot session for these cards. Progress arrives as `handoff-event`s with the job id.
pub fn start(app: &AppHandle, state: &AppState, slug: &str, ids: Vec<String>) -> Result<String> {
    crate::storage::check_slug(slug)?;
    if handoff::lock_job(state)?.is_some() {
        return Err(AppError::Invalid("A handoff session is already running. Wait for it or cancel it first.".into()));
    }
    let (data, frames, model, dir, memory, texts) = {
        let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let data = ws.load_project(slug)?;
        let model = ws.get_settings().map(|s| s.model_export).unwrap_or_else(|_| crate::model::DEFAULT_MODEL_EXPORT.into());
        let mut texts = BTreeMap::new();
        for c in data.cards.iter().filter(|c| build::is_dirty(c)) {
            if let Ok(t) = ws.built_texts(slug, &c.meta.id) {
                texts.insert(c.meta.id.clone(), t);
            }
        }
        (data, ws.card_frames(slug).unwrap_or_default(), model, ws.existing_project_dir(slug)?, ws.read_memory(slug), texts)
    };
    let wanted = dedup(ids);
    let buildable = |c: &Card| !c.meta.ghost && c.meta.kind == CardKind::Card && c.meta.role.is_none();
    let to_build: Vec<String> = data.cards.iter().filter(|c| buildable(c) && wanted.contains(&c.meta.id)).map(|c| c.meta.id.clone()).collect();
    if to_build.is_empty() {
        return Err(AppError::Invalid("Nothing to build: pick at least one card.".into()));
    }
    // One hop of links, both directions, as context only.
    let context: Vec<String> = data
        .cards
        .iter()
        .filter(|o| !o.meta.ghost && !to_build.contains(&o.meta.id))
        .filter(|o| o.meta.links.iter().any(|l| to_build.contains(&l.to)) || data.cards.iter().any(|c| to_build.contains(&c.meta.id) && c.meta.links.iter().any(|l| l.to == o.meta.id)))
        .map(|o| o.meta.id.clone())
        .collect();
    let diffs: BTreeMap<String, String> = texts.into_iter().filter(|(id, _)| to_build.contains(id)).map(|(id, (snap, now))| (id, line_diff(snap.as_deref().unwrap_or(""), &now))).collect();

    let spec = ScopeSpec { scope: Scope::Selection { ids: to_build.clone() }, stages: vec![Stage::Mist, Stage::Reverie, Stage::Lucid, Stage::Dream, Stage::Built], include_stickies: true, version: None };
    let ver = handoff::job_version(&data, &spec);
    let (ver_id, ver_title) = ver.as_ref().map(|f| (f.id.clone(), f.name())).unwrap_or_default();
    let ddir = if ver_id.is_empty() { String::new() } else { handoff::dir_for(&dir, &ver_id, &ver_title) };
    let latest = handoff::next_revision(&dir, &ddir) - 1;
    let design = (latest > 0 && handoff::revision_dir(&dir, &ddir, latest).is_dir()).then(|| (ddir.clone(), latest));
    let repo = data.meta.handoff_target.clone().filter(|t| !t.trim().is_empty());
    let prompt = task_prompt(&data, &frames, &to_build, &context, &diffs, &ver_title, design.is_some(), repo.as_deref().map(Path::new), memory.as_deref());

    let mut cards = to_build.clone();
    cards.extend(context);
    let label = format!("Build prompt: {}", to_build.iter().filter_map(|id| data.cards.iter().find(|c| &c.meta.id == id)).map(|c| c.meta.title.clone()).collect::<Vec<_>>().join(", "));
    let id = format!("h{}", ulid::Ulid::generate());
    {
        let mut g = handoff::lock_job(state)?;
        if g.is_some() {
            return Err(AppError::Invalid("A handoff session is already running.".into()));
        }
        *g = Some(Job {
            id: id.clone(), slug: slug.into(), mode: Mode::Task, model: model.clone(), spec, label, cards, version: 0, ver_id, ver_title, dir: ddir, gaps_in: vec![], gaps_out: None, memory_hash: String::new(),
            docs: BTreeMap::new(), read: HashSet::new(), viewed: HashSet::new(), images: 0,
            task: Some(TaskState { build: to_build, diffs, design, out: None }),
        });
    }
    if let Err(e) = crate::sidecar::ensure_started(app, state) {
        *handoff::lock_job(state)? = None;
        return Err(e);
    }
    crate::sidecar::write_line(state, &json!({ "type": "oneshot_start", "job": id, "mode": "task", "prompt": prompt, "model": model }));
    handoff::emit(app, &id, json!({ "type": "progress", "step": "reading", "read": 0, "total": 0 }));
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
fn task_prompt(data: &crate::model::ProjectData, frames: &std::collections::HashMap<String, String>, build_ids: &[String], context: &[String], diffs: &BTreeMap<String, String>, version: &str, has_design: bool, repo: Option<&Path>, memory: Option<&str>) -> String {
    let mut out = format!("Write a build task for Claude Code, from the project \"{}\"{}.\n{}\n", data.meta.name, if version.is_empty() { String::new() } else { format!(" (version {version})") }, handoff::memory_text(memory));
    out.push_str(&format!("\nCards to build ({}):\n{}\n", build_ids.len(), handoff::card_lines(data, build_ids, frames)));
    if !context.is_empty() {
        out.push_str(&format!("\nContext cards, linked one hop from them (context, not to build; never list them as work):\n{}\n", handoff::card_lines(data, context, frames)));
    }
    if !diffs.is_empty() {
        out.push_str("\nRebuild cards (already built, design changed since). The app inserts the exact diff itself: put the placeholder on its own line, verbatim, where the change belongs (once per card, under a 'Design change since last build' heading in the 'What to build' section), and write the change task around it. Read each card's build.files and list them as the likely places to change.\n");
        for id in diffs.keys() {
            out.push_str(&format!("- {}\n", placeholder(id)));
        }
    }
    match repo {
        Some(r) => {
            let docs: Vec<String> = fs::read_dir(r.join("docs").join("design")).map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).take(30).collect()).unwrap_or_default();
            out.push_str(&format!(
                "
Repo: CLAUDE.md {}. docs/design/ holds: {}. Point to only those that exist.
{}",
                if r.join("CLAUDE.md").is_file() { "exists" } else { "does not exist" },
                if docs.is_empty() { "nothing yet".into() } else { docs.join(", ") },
                if has_design { "The design docs of this version can be read with read_design_doc.
" } else { "" }
            ));
        }
        None => out.push_str("
No repo is linked, so what exists of CLAUDE.md and docs/design/ is unknown: say so in Context instead of guessing.
"),
    }
    out.push_str("\nWrite the task with write_task, once.\n");
    out
}

/// The task session's own tools (`handoff_read_design_doc`, `handoff_write_task`).
pub fn run_tool(state: &AppState, tool: &str, job_id: &str, input: Value) -> Result<Value> {
    let gone = || AppError::Invalid("this handoff session was cancelled; stop now".into());
    match tool {
        "handoff_read_design_doc" => {
            let name = handoff::check_doc_name(input.get("name").and_then(Value::as_str).unwrap_or_default())?;
            let (slug, design) = {
                let g = handoff::lock_job(state)?;
                let j = g.as_ref().filter(|j| j.id == job_id).ok_or_else(gone)?;
                (j.slug.clone(), j.task.as_ref().and_then(|t| t.design.clone()))
            };
            let (dir, rev) = design.ok_or_else(|| AppError::Invalid("This version has no design docs yet. Work from the cards.".into()))?;
            let pdir = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.existing_project_dir(&slug)?;
            Ok(json!(handoff::read_doc_in(&pdir, &dir, rev, name)?))
        }
        "handoff_write_task" => {
            let md = input.get("markdown").and_then(Value::as_str).unwrap_or_default().replace("\r\n", "\n");
            if md.trim().is_empty() {
                return Err(AppError::Invalid("the markdown is empty".into()));
            }
            if md.len() > MAX_TASK_BYTES {
                return Err(AppError::Invalid(format!("the task is too long ({} KB, max {} KB)", md.len() / 1000, MAX_TASK_BYTES / 1000)));
            }
            let meta = input.get("meta").cloned().unwrap_or(Value::Null);
            let title = meta.get("title").and_then(Value::as_str).unwrap_or_default().trim().to_string();
            if title.is_empty() {
                return Err(AppError::Invalid("meta.title is required".into()));
            }
            let slug = handoff::lock_job(state)?.as_ref().filter(|j| j.id == job_id).map(|j| j.slug.clone()).ok_or_else(gone)?;
            // The workspace lock is never taken while the job lock is held.
            let titles: BTreeMap<String, String> = state.ws.lock().ok().and_then(|ws| ws.load_project(&slug).ok()).map(|d| d.cards.iter().map(|c| (c.meta.id.clone(), c.meta.title.clone())).collect()).unwrap_or_default();
            let mut g = handoff::lock_job(state)?;
            let j = g.as_mut().filter(|j| j.id == job_id).ok_or_else(gone)?;
            let ctx_cards = j.cards.clone();
            let t = j.task.as_mut().ok_or_else(|| AppError::Invalid("write_task is only for build prompts".into()))?;
            if t.out.is_some() {
                return Err(AppError::Invalid("write_task was already called; end your turn".into()));
            }
            let card_ids: Vec<String> = serde_json::from_value::<Vec<String>>(meta.get("card_ids").cloned().unwrap_or(Value::Null)).map_err(|_| AppError::Invalid("meta.card_ids must be a list of card ids".into()))?;
            if card_ids.is_empty() || card_ids.iter().any(|c| !t.build.contains(c)) || t.build.iter().any(|b| !card_ids.contains(b)) {
                return Err(AppError::Invalid(format!("meta.card_ids must be exactly the cards to build: {}", t.build.join(", "))));
            }
            let flags: Vec<Flag> = serde_json::from_value(meta.get("flags").cloned().unwrap_or_else(|| json!([]))).map_err(|e| AppError::Invalid(format!("meta.flags must be a list of {{card_id?, text}}: {e}")))?;
            let flags = flags.into_iter().filter(|f| !f.text.trim().is_empty()).map(|f| Flag { card_id: f.card_id.filter(|c| ctx_cards.contains(c)), text: f.text.trim().to_string() }).collect();
            let mut md = md;
            for id in t.diffs.keys() {
                let ph = placeholder(id);
                if !md.contains(&ph) {
                    return Err(AppError::Invalid(format!("Put the placeholder {ph} on its own line where card {id}'s design change belongs, then call write_task again.")));
                }
            }
            for (id, diff) in &t.diffs {
                md = md.replace(&placeholder(id), &diff_block(titles.get(id).map(String::as_str).unwrap_or(id), id, diff));
            }
            t.out = Some(TaskOut { markdown: md, title, card_ids, flags });
            Ok(json!("Saved. The user now reviews the task. End your turn with one short sentence."))
        }
        other => Err(AppError::Invalid(format!("unknown task tool {other:?}"))),
    }
}

/// The job ended: the finished task (or the reason there is none) for the preview dialog.
pub fn done_event(job: Job) -> Value {
    let kind = job.task.as_ref().map(|t| if !t.diffs.is_empty() && t.diffs.len() == t.build.len() { "rebuild" } else { "build" }).unwrap_or("build");
    match job.task.and_then(|t| t.out) {
        Some(o) => json!({ "type": "done", "mode": "task", "markdown": o.markdown, "title": o.title, "card_ids": o.card_ids, "flags": o.flags, "model": job.model, "version": job.ver_title, "kind": kind }),
        None => json!({ "type": "error", "message": "Claude ended without writing the task. Try again." }),
    }
}

// ---------- saving, listing, terminal ----------

#[derive(Deserialize)]
pub struct TaskSave {
    pub markdown: String,
    pub title: String,
    pub card_ids: Vec<String>,
    pub kind: String,
    #[serde(default)]
    pub version: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct TaskInfo {
    /// Repo-relative path, e.g. `docs/design/tasks/2026-11-25-harpoon.md`.
    pub file: String,
    pub title: String,
    pub id: String,
    pub kind: String,
    pub cards: Vec<String>,
    pub created: String,
    pub version: String,
    pub done: Option<String>,
}

pub(crate) fn confirmed_repo(ws: &Workspace, slug: &str) -> Result<PathBuf> {
    let m = ws.project_meta(slug)?;
    m.handoff_target.clone().filter(|t| m.handoff_target_confirmed.as_deref() == Some(t.as_str())).map(PathBuf::from).ok_or_else(|| AppError::Invalid("No repo is linked for this project. Use Link repo… first.".into()))
}

/// `---\n<yaml>\n---\n<rest>`: (yaml, rest).
fn split_front(text: &str) -> Option<(&str, &str)> {
    let t = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n"))?;
    let end = t.find("\n---")?;
    let after = &t[end + 4..];
    Some((&t[..end], after.strip_prefix("\r\n").or_else(|| after.strip_prefix('\n')).unwrap_or(after)))
}

pub(crate) fn file_name_ok(rel: &str) -> Result<String> {
    let name = rel.strip_prefix(&format!("{}/", build::TASKS_REL)).unwrap_or_default();
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.starts_with('.') || !name.ends_with(".md") {
        return Err(AppError::Invalid(format!("not a task file: {rel:?}")));
    }
    Ok(name.to_string())
}

/// What Claude Code is told to do with a saved task.
pub fn reference(rel: &str) -> String {
    format!("Implement {rel}. Follow CLAUDE.md and the Report back section.")
}

/// Writes the task into the repo and queues its cards. Returns the repo-relative path.
pub fn save(state: &AppState, slug: &str, t: TaskSave) -> Result<String> {
    if t.markdown.trim().is_empty() {
        return Err(AppError::Invalid("The task is empty.".into()));
    }
    if !matches!(t.kind.as_str(), "build" | "rebuild") {
        return Err(AppError::Invalid(format!("unknown task kind {:?}", t.kind)));
    }
    t.card_ids.iter().try_for_each(|i| check_id(i))?;
    let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
    let repo = confirmed_repo(&ws, slug)?;
    let dir = repo.join(build::TASKS_REL);
    let created = now();
    let base = format!("{}-{}", &created[..10], handoff::dir_name(&t.title).to_lowercase().chars().take(48).collect::<String>().trim_matches(['-', '.']));
    let mut name = format!("{base}.md");
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("{base}-{n}.md");
        n += 1;
    }
    #[derive(Serialize)]
    struct Head<'a> {
        dreamer_task: u8,
        id: String,
        version: &'a str,
        kind: &'a str,
        cards: &'a [String],
        created: &'a str,
    }
    let head = serde_yaml::to_string(&Head { dreamer_task: 1, id: format!("t{}", ulid::Ulid::generate()), version: &t.version, kind: &t.kind, cards: &t.card_ids, created: &created }).map_err(|e| AppError::Invalid(e.to_string()))?;
    let text = format!("---\n{head}---\n\n{}\n", t.markdown.trim_end());
    atomic_write(&dir.join(&name), text.as_bytes())?;
    let rel = format!("{}/{name}", build::TASKS_REL);
    ws.queue_cards(slug, &t.card_ids, &rel)?;
    let _ = ws.write_link(slug);
    Ok(rel)
}

pub fn list(state: &AppState, slug: &str) -> Result<Vec<TaskInfo>> {
    let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
    let Ok(repo) = confirmed_repo(&ws, slug) else { return Ok(vec![]) };
    let Ok(rd) = fs::read_dir(repo.join(build::TASKS_REL)) else { return Ok(vec![]) };
    let mut out: Vec<TaskInfo> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let text = fs::read_to_string(e.path()).ok()?;
            let (head, rest) = split_front(&text)?;
            let y: serde_yaml::Value = serde_yaml::from_str(head).ok()?;
            y.get("dreamer_task")?;
            let s = |k: &str| y.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let title = rest.lines().find_map(|l| l.strip_prefix("# ")).map(|t| t.trim().to_string()).unwrap_or_else(|| name.trim_end_matches(".md").to_string());
            Some(TaskInfo {
                file: format!("{}/{name}", build::TASKS_REL),
                title,
                id: s("id"),
                kind: s("kind"),
                cards: y.get("cards").and_then(|v| v.as_sequence()).map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect()).unwrap_or_default(),
                created: s("created"),
                version: s("version"),
                done: y.get("done").and_then(|v| v.as_str()).map(String::from),
            })
        })
        .collect();
    out.sort_by(|a, b| b.created.cmp(&a.created).then(b.file.cmp(&a.file)));
    Ok(out)
}

pub fn mark_done(state: &AppState, slug: &str, rel: &str) -> Result<()> {
    let name = file_name_ok(rel)?;
    let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
    let path = confirmed_repo(&ws, slug)?.join(build::TASKS_REL).join(name);
    let text = fs::read_to_string(&path).map_err(|e| AppError::io(format!("read {}", path.display()), e))?;
    let (head, rest) = split_front(&text).ok_or_else(|| AppError::Invalid("the task file has no frontmatter".into()))?;
    let mut y: serde_yaml::Mapping = serde_yaml::from_str(head).map_err(|e| AppError::Invalid(e.to_string()))?;
    y.insert("done".into(), now().into());
    let head = serde_yaml::to_string(&y).map_err(|e| AppError::Invalid(e.to_string()))?;
    atomic_write(&path, format!("---\n{head}---\n{rest}").as_bytes())
}

/// Opens a terminal in the repo running `claude "<reference>"` (Windows Terminal, else a plain cmd window).
pub fn open_terminal(state: &AppState, slug: &str, rel: &str) -> Result<()> {
    let name = file_name_ok(rel)?;
    let repo = {
        let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        confirmed_repo(&ws, slug)?
    };
    if !repo.join(build::TASKS_REL).join(name).is_file() {
        return Err(AppError::NotFound(rel.to_string()));
    }
    if !cfg!(windows) {
        return Err(AppError::Invalid("Opening a terminal is only supported on Windows.".into()));
    }
    let mut which = crate::claude_setup::command(Path::new("where"));
    which.arg("claude").stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    if !which.output().map(|o| o.status.success() && !o.stdout.is_empty()).unwrap_or(false) {
        return Err(AppError::Invalid("`claude` isn't on your PATH. Install Claude Code, or save the task and run it yourself.".into()));
    }
    terminal_at(&repo, Some(&reference(rel)))
}

/// Opens a terminal in `dir` (Windows Terminal, else a plain cmd window), running `claude "<text>"` when given.
pub(crate) fn terminal_at(dir: &Path, claude: Option<&str>) -> Result<()> {
    if !cfg!(windows) {
        return Err(AppError::Invalid("Opening a terminal is only supported on Windows.".into()));
    }
    // `;` separates Windows Terminal commands: such a path goes through cmd instead.
    let wt = if dir.to_string_lossy().contains(';') {
        Err(std::io::Error::other("path has a semicolon"))
    } else {
        let mut c = std::process::Command::new("wt.exe");
        c.arg("-d").arg(dir);
        if let Some(t) = claude {
            c.arg("claude").arg(t);
        }
        c.spawn()
    };
    if wt.is_ok() {
        return Ok(());
    }
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/c", "start", "", "/d"]).arg(dir);
    match claude {
        Some(t) => cmd.args(["cmd", "/k", "claude"]).arg(t),
        None => cmd.arg("cmd"),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map(|_| ()).map_err(|e| AppError::io("open a terminal".to_string(), e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_keeps_changes_with_one_line_of_context() {
        let d = line_diff("a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nD\ne\nf\ng");
        assert_eq!(d, "  …\n  c\n- d\n+ D\n  e");
        assert_eq!(line_diff("same", "same"), "");
        assert_eq!(line_diff("", "x"), "+ x");
    }

    #[test]
    fn frontmatter_splits_and_references_are_stable() {
        let (h, r) = split_front("---\ndreamer_task: 1\n---\n\n# T\n").unwrap();
        assert_eq!((h, r), ("dreamer_task: 1", "\n# T\n"));
        assert!(split_front("# no front").is_none());
        assert_eq!(reference("docs/design/tasks/x.md"), "Implement docs/design/tasks/x.md. Follow CLAUDE.md and the Report back section.");
        assert!(file_name_ok("docs/design/tasks/../x.md").is_err());
        assert!(file_name_ok("docs/design/tasks/a.md").is_ok());
    }
}
