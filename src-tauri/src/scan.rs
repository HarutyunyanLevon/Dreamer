//! "Scan repo for built features": a one-shot Claude session reads the linked repo (Read, Glob, Grep only)
//! and hands back one `.dreamer.md` bundle (source `dreamer-scan`), which goes straight to the import preview.
//! The sidecar runs the session (`scan_start` in claude-sidecar.mjs); this side owns the tools it calls and
//! the permission rule (`build_run::decide`'s path check, everything but Read/Glob/Grep denied).

use crate::error::{AppError, Result};
use crate::handoff::{Scope, ScopeSpec};
use crate::model::Stage;
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

pub const DEFAULT_MAX: usize = 40;
const HARD_MAX: usize = 200;
/// Never read: build output, caches, dependencies, third-party code.
const SKIP: [&str; 14] = [".git", "node_modules", "build", "dist", "library", "intermediate", "binaries", ".vs", "third-party", "third_party", "thirdparty", "3rdparty", "vendor", "target"];

pub struct Job {
    id: String,
    slug: String,
    repo: PathBuf,
    max: usize,
    /// emit_bundle was accepted.
    done: bool,
}

fn lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, Option<Job>>> {
    state.claude.scan.lock().map_err(|_| AppError::Invalid("scan lock poisoned".into()))
}

fn emit(app: &AppHandle, job: &str, mut payload: Value) {
    payload["job"] = json!(job);
    let _ = app.emit("scan-event", payload);
}

/// A path with a skipped folder in it.
fn skipped(p: &str) -> bool {
    p.split(['/', '\\']).any(|c| SKIP.contains(&c.to_lowercase().as_str()))
}

/// `folder` (inside the repo) as a path relative to it; "" = the whole repo.
fn scope_rel(repo: &Path, folder: Option<&str>) -> Result<String> {
    let Some(f) = folder.map(str::trim).filter(|f| !f.is_empty()) else { return Ok(String::new()) };
    if !crate::build_run::inside(repo, f) {
        return Err(AppError::Invalid(format!("{f} is not inside the repo.")));
    }
    let full = dunce::canonicalize(if Path::new(f).is_absolute() { PathBuf::from(f) } else { repo.join(f) }).map_err(|e| AppError::io(format!("open {f}"), e))?;
    Ok(full.strip_prefix(repo).map(|r| r.display().to_string().replace('\\', "/")).unwrap_or_default())
}

pub fn start(app: &AppHandle, state: &AppState, slug: &str, folder: Option<String>, max: Option<usize>, model: Option<String>) -> Result<String> {
    crate::storage::check_slug(slug)?;
    let (repo, default_model) = {
        let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let repo = crate::task::confirmed_repo(&ws, slug)?;
        let model = ws.get_settings().map(|s| s.model_export).unwrap_or_else(|_| crate::model::DEFAULT_MODEL_EXPORT.into());
        (dunce::canonicalize(&repo).map_err(|e| AppError::io(format!("open {}", repo.display()), e))?, model)
    };
    let rel = scope_rel(&repo, folder.as_deref())?;
    let max = max.unwrap_or(DEFAULT_MAX).clamp(1, HARD_MAX);
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).unwrap_or(default_model);
    let id = format!("s{}", ulid::Ulid::generate());
    {
        let mut g = lock(state)?;
        if g.is_some() {
            return Err(AppError::Invalid("A repo scan is already running. Wait for it or cancel it.".into()));
        }
        *g = Some(Job { id: id.clone(), slug: slug.into(), repo: repo.clone(), max, done: false });
    }
    let scope = if rel.is_empty() { "the whole repo".to_string() } else { format!("only the folder `{rel}` (relative to the repo root)") };
    let prompt = format!("Today is {}. Scan {scope}. Report at most {max} cards. Call list_cards first, then explore, then call emit_bundle once.", chrono::Local::now().format("%Y-%m-%d"));
    if let Err(e) = crate::sidecar::ensure_started(app, state) {
        *lock(state)? = None;
        return Err(e);
    }
    crate::sidecar::write_line(state, &json!({ "type": "scan_start", "job": id, "cwd": crate::claude_setup::child_path(&repo), "prompt": prompt, "model": model }));
    emit(app, &id, json!({ "type": "progress", "note": "Starting…" }));
    Ok(id)
}

pub fn cancel(state: &AppState) -> Result<()> {
    if let Some(j) = lock(state)?.take() {
        crate::sidecar::write_line(state, &json!({ "type": "oneshot_cancel", "job": j.id }));
    }
    Ok(())
}

/// What a tool call needs from the job: (id, repo, max cards, project).
fn view(state: &AppState, input: &Value) -> Result<(String, PathBuf, usize, String)> {
    let id = input.get("job").and_then(Value::as_str).unwrap_or_default();
    match lock(state)?.as_ref() {
        Some(j) if j.id == id && !j.done => Ok((j.id.clone(), j.repo.clone(), j.max, j.slug.clone())),
        _ => Err(AppError::Invalid("this scan was cancelled or is over; stop now".into())),
    }
}

/// The sidecar's `scan_*` requests.
pub fn run_tool(app: &AppHandle, state: &AppState, tool: &str, input: Value) -> Result<Value> {
    let (id, repo, max, slug) = view(state, &input)?;
    match tool {
        "scan_permission" => Ok(permission(&repo, &input)),
        "scan_report_progress" => {
            let note: String = input.get("note").and_then(Value::as_str).unwrap_or_default().trim().chars().take(200).collect();
            emit(app, &id, json!({ "type": "progress", "note": note }));
            Ok(json!("ok"))
        }
        "scan_list_cards" => {
            let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
            let data = ws.load_project(&slug)?;
            let frames = ws.card_frames(&slug).unwrap_or_default();
            let spec = ScopeSpec { scope: Scope::Project, stages: vec![Stage::Mist, Stage::Reverie, Stage::Lucid, Stage::Dream, Stage::Built], include_stickies: false, version: None };
            let ids = crate::handoff::resolve_scope(&data, &spec)?;
            let cards: Vec<Value> = data.cards.iter().filter(|c| ids.contains(&c.meta.id)).map(|c| json!({ "id": c.meta.id, "title": c.meta.title, "stage": c.meta.stage, "tags": c.meta.tags, "frame": frames.get(&c.meta.id) })).collect();
            let mut tags: Vec<&String> = data.cards.iter().filter(|c| ids.contains(&c.meta.id)).flat_map(|c| &c.meta.tags).collect();
            tags.sort();
            tags.dedup();
            Ok(json!({ "cards": cards, "tags": tags }))
        }
        "scan_emit_bundle" => {
            let md = input.get("markdown").and_then(Value::as_str).unwrap_or_default();
            // Refused here, so Claude can fix it in the same session.
            let b = crate::bundle::parse(md).map_err(AppError::Invalid)?;
            if b.header.source != "dreamer-scan" {
                return Err(AppError::Invalid("The header needs `source: dreamer-scan`.".into()));
            }
            if b.cards.is_empty() {
                return Err(AppError::Invalid("The bundle has no cards (each starts with <!-- card -->).".into()));
            }
            if b.cards.len() > max {
                return Err(AppError::Invalid(format!("{} cards is over the limit of {max}: merge or drop the least important.", b.cards.len())));
            }
            if let Some(c) = b.cards.iter().find(|c| c.stage != Stage::Built || c.build.is_none()) {
                return Err(AppError::Invalid(format!("Card \"{}\" must have `stage: built` and a `build` block.", c.title)));
            }
            if !b.warnings.is_empty() {
                return Err(AppError::Invalid(format!("Fix these and call emit_bundle again: {}", b.warnings.join(" "))));
            }
            let mut g = lock(state)?;
            let Some(j) = g.as_mut().filter(|j| j.id == id) else { return Err(AppError::Invalid("this scan was cancelled; stop now".into())) };
            j.done = true;
            drop(g);
            emit(app, &id, json!({ "type": "bundle", "bundle": md }));
            Ok(json!("Bundle accepted. End your turn now."))
        }
        other => Err(AppError::Invalid(format!("unknown tool {other}"))),
    }
}

/// Read, Glob and Grep inside the repo (and outside the skipped folders); nothing else.
fn permission(repo: &Path, input: &Value) -> Value {
    let tool = input.get("tool").and_then(Value::as_str).unwrap_or_default();
    let tin = input.get("input").cloned().unwrap_or(Value::Null);
    let deny = |m: &str| json!({ "behavior": "deny", "message": m });
    if !matches!(tool, "Read" | "Glob" | "Grep") {
        return deny("A repo scan may only use Read, Glob and Grep.");
    }
    let touched = ["file_path", "path", "pattern", "glob"].iter().filter_map(|k| tin.get(*k).and_then(Value::as_str));
    if touched.into_iter().any(skipped) {
        return deny("That folder is skipped in a scan (.git, node_modules, build, dist, Library, Intermediate, Binaries, .vs, third-party, vendor).");
    }
    match crate::build_run::decide(repo, tool, &tin, &[]) {
        crate::build_run::Verdict::Allow => json!({ "behavior": "allow" }),
        _ => deny("That path is outside the repo."),
    }
}

/// The sidecar's `scan_step` / `scan_done`.
pub fn on_message(app: &AppHandle, state: &AppState, msg: &Value) {
    let id = msg.get("job").and_then(Value::as_str).unwrap_or_default();
    match msg.get("type").and_then(Value::as_str) {
        Some("scan_step") => {
            let mine = lock(state).ok().is_some_and(|g| g.as_ref().is_some_and(|j| j.id == id));
            if let (true, Some(l)) = (mine, msg.pointer("/step/label").and_then(Value::as_str)) {
                emit(app, id, json!({ "type": "step", "label": l }));
            }
        }
        Some("scan_done") => finish(app, state, id, msg),
        _ => {}
    }
}

/// The job is over, whatever `msg` says.
pub fn finish(app: &AppHandle, state: &AppState, id: &str, msg: &Value) {
    let job = match lock(state) {
        Ok(mut g) if g.as_ref().is_some_and(|j| j.id == id) => g.take().expect("checked"),
        _ => return, // cancelled: output dropped
    };
    if msg.get("ok").and_then(Value::as_bool) == Some(true) {
        if job.done {
            emit(app, id, json!({ "type": "done" }));
        } else {
            emit(app, id, json!({ "type": "error", "message": "Claude finished without producing a bundle. Try again." }));
        }
    } else {
        let m = msg.get("error").and_then(Value::as_str).unwrap_or("Claude stopped before finishing.");
        emit(app, id, json!({ "type": "error", "message": m }));
    }
}

/// The helper died: end the running scan.
pub fn on_sidecar_gone(app: &AppHandle, state: &AppState, why: &str) {
    let id = lock(state).ok().and_then(|g| g.as_ref().map(|j| j.id.clone()));
    if let Some(id) = id {
        finish(app, state, &id, &json!({ "ok": false, "error": why }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_read_glob_grep_inside_the_repo() {
        let d = tempfile::TempDir::new().unwrap();
        let repo = dunce::canonicalize(d.path()).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let call = |tool: &str, input: Value| permission(&repo, &json!({ "tool": tool, "input": input }))["behavior"].as_str().unwrap().to_string();
        assert_eq!(call("Read", json!({ "file_path": repo.join("src").join("a.rs").display().to_string() })), "allow");
        assert_eq!(call("Grep", json!({ "pattern": "fn main", "path": "src" })), "allow");
        assert_eq!(call("Glob", json!({ "pattern": "**/*.rs" })), "allow");
        assert_eq!(call("Read", json!({ "file_path": "node_modules/x/index.js" })), "deny");
        assert_eq!(call("Glob", json!({ "pattern": "Library/**" })), "deny");
        assert_eq!(call("Read", json!({ "file_path": "C:\\Windows\\win.ini" })), "deny");
        assert_eq!(call("Bash", json!({ "command": "ls" })), "deny");
        assert_eq!(call("Write", json!({ "file_path": "src/a.rs" })), "deny");
        assert!(skipped("a/Third-Party/b") && !skipped("src/vendors_page.rs"));
    }
}
