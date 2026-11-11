//! Bridges the chat panel to `sidecar/claude-sidecar.mjs`, a Node process that talks to the
//! Claude Agent SDK (and so to the user's locally installed, already-logged-in Claude Code).
//! Communication is newline-delimited JSON over the child's stdio. The sidecar's `create_card`
//! tool does not touch files itself: it asks us to, over this same channel, so every card still
//! goes through `storage::Workspace` (one writer, atomic writes, ids stay ULIDs).

use crate::error::{AppError, Result};
use crate::claude_setup::{self, ClaudeStatus, Tool};
use crate::model::{NewCard, Source};
use crate::state::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub struct ClaudeState {
    sidecar: Mutex<Option<Sidecar>>,
    active_slug: Mutex<String>,
    pub setup: crate::claude_setup::SetupState,
}

impl Default for ClaudeState {
    fn default() -> Self {
        ClaudeState { sidecar: Mutex::new(None), active_slug: Mutex::new("inbox".into()), setup: Default::default() }
    }
}

struct Sidecar {
    child: Child,
    stdin: std::process::ChildStdin,
}

/// Full status for the chat panel's setup screen. Also notices when Claude Code has just become
/// usable (installed + signed in, e.g. after `claude auth login` in a terminal) and drops the
/// running sidecar so the next message starts a fresh one with the new credential.
pub fn claude_status(state: &AppState) -> ClaudeStatus {
    let setup = &state.claude.setup;
    let job = setup.running();
    // Don't probe a half-installed CLI while npm is still writing it.
    if job == Some(crate::claude_setup::JobKind::Install) {
        return ClaudeStatus { job, ..Default::default() };
    }
    let mut status = crate::claude_setup::check_status();
    status.job = job;
    if setup.note_ready(status.installed && status.logged_in != Some(false)) {
        shutdown(state);
    }
    status
}

fn sidecar_script_path(app: &AppHandle) -> Result<PathBuf> {
    // Dev: the `sidecar/` folder next to this crate's project root.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar").join("claude-sidecar.mjs");
    if dev.is_file() {
        return Ok(dev);
    }
    // Packaged: bundled as a resource (see tauri.conf.json `bundle.resources`).
    if let Ok(dir) = app.path().resource_dir() {
        let res = dir.join("sidecar").join("claude-sidecar.mjs");
        if res.is_file() {
            return Ok(res);
        }
    }
    Err(AppError::Invalid("the Claude sidecar script is missing from this build".into()))
}

fn ensure_started(app: &AppHandle, state: &AppState) -> Result<()> {
    let mut guard = state.claude.sidecar.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))?;
    if guard.is_some() {
        return Ok(());
    }
    let script = sidecar_script_path(app)?;
    // Node resolves `node_modules` by walking up from the script, so running it from the repo
    // root in dev (two levels up from `sidecar/claude-sidecar.mjs`) lets it see the project's
    // top-level `@anthropic-ai/claude-agent-sdk` install without any extra configuration.
    let cwd = script.parent().and_then(|p| p.parent()).map(|p| p.to_path_buf());
    // Resolve Node the same way as `claude` (a GUI-launched app may not inherit the terminal's PATH).
    let node = claude_setup::resolve(Tool::Node).unwrap_or_else(|| PathBuf::from("node"));
    let mut cmd = claude_setup::command(&node);
    cmd.arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().map_err(|e| AppError::io("spawn the Claude sidecar (is Node.js installed?)", e))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let out_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                handle_sidecar_message(&out_app, msg);
            }
        }
    });
    let err_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
            eprintln!("[claude-sidecar] {line}");
            let _ = err_app.emit("claude-event", json!({ "type": "stderr", "message": line }));
        }
    });

    *guard = Some(Sidecar { child, stdin });
    Ok(())
}

fn write_line(state: &AppState, value: &Value) {
    if let Ok(mut guard) = state.claude.sidecar.lock() {
        if let Some(sc) = guard.as_mut() {
            let _ = writeln!(sc.stdin, "{value}");
            let _ = sc.stdin.flush();
        }
    }
}

fn handle_sidecar_message(app: &AppHandle, msg: Value) {
    if msg.get("type").and_then(Value::as_str) == Some("tool_request") {
        let state = app.state::<AppState>();
        let req_id = msg.get("reqId").and_then(Value::as_str).unwrap_or_default().to_string();
        let tool = msg.get("tool").and_then(Value::as_str).unwrap_or_default();
        let input = msg.get("input").cloned().unwrap_or(Value::Null);
        let reply = match run_tool(&state, tool, input) {
            Ok(result) => json!({ "type": "tool_response", "reqId": req_id, "result": result }),
            Err(e) => json!({ "type": "tool_response", "reqId": req_id, "error": e.to_string() }),
        };
        write_line(&state, &reply);
        return;
    }
    let _ = app.emit("claude-event", msg);
}

fn to_json<T: Serialize>(v: &T, what: &str) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| AppError::Parse { context: what.into(), message: e.to_string() })
}

fn active_slug(state: &AppState) -> Result<String> {
    Ok(state.claude.active_slug.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))?.clone())
}

fn run_tool(state: &AppState, tool: &str, input: Value) -> Result<Value> {
    match tool {
        "create_card" => {
            let slug = state.claude.active_slug.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))?.clone();
            let branch_group = input.get("branch_group").and_then(Value::as_str);
            let branch = branch_group.map(|g| json!({ "group": g, "of": input.get("variant_of").and_then(Value::as_str) }));
            let new_card = NewCard {
                title: input.get("title").and_then(Value::as_str).map(str::to_string),
                body: input.get("body").and_then(Value::as_str).map(str::to_string),
                tags: input.get("tags").cloned().and_then(|v| serde_json::from_value(v).ok()),
                stage: input.get("stage").cloned().and_then(|v| serde_json::from_value(v).ok()),
                links: input.get("links").cloned().and_then(|v| serde_json::from_value(v).ok()),
                source: Some(Source::Claude),
                ghost: Some(true),
                branch,
                ..Default::default()
            };
            let card = {
                let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
                guard.create_card(&slug, new_card)?
            };
            // Don't wait for the watcher's debounce: a search right after this should see it.
            if let Ok(mut idx) = state.search.lock() {
                idx.mark_dirty(Some(&slug));
            }
            to_json(&card, "create_card result")
        }
        // ---- read-only retrieval tools: nothing below writes to disk ----
        "search_cards" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or_default();
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
            let project = match input.get("scope").and_then(Value::as_str) {
                Some("project") => Some(active_slug(state)?),
                _ => None,
            };
            let hits = state.with_search(|idx| idx.search(query, project.as_deref(), limit.min(25)))?;
            to_json(&hits, "search results")
        }
        "read_card" => {
            let id = input.get("id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(id)?;
            let slug = active_slug(state)?;
            state.with_search(|idx| {
                let (project, card) = idx.find(id, Some(&slug)).ok_or_else(|| AppError::NotFound(format!("card {id} (it may have been trashed)")))?;
                let mut v = to_json(&card, "card")?;
                v["project"] = json!(project);
                v["links"] = json!(idx.describe_links(&project, &card.meta.links));
                Ok(v)
            })?
        }
        "list_related" => {
            let id = input.get("id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(id)?;
            let related = state.with_search(|idx| idx.related(id, 20))?.ok_or_else(|| AppError::NotFound(format!("card {id}")))?;
            to_json(&related, "related cards")
        }
        // Only *proposes* a link: validated here, then shown in the UI as a dashed ghost link the
        // user must Keep. Nothing is written to any card file.
        "propose_link" => {
            let from = input.get("from").and_then(Value::as_str).unwrap_or_default();
            let to = input.get("to").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(from)?;
            crate::storage::check_id(to)?;
            if from == to {
                return Err(AppError::Invalid("a card can't link to itself".into()));
            }
            let slug = active_slug(state)?;
            let from_card = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.read_card(&slug, from)?;
            let to_card = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.read_card(&slug, to)?;
            if from_card.meta.links.iter().any(|l| l.to == to) {
                return Err(AppError::Invalid(format!("\"{}\" already links to \"{}\"", from_card.meta.title, to_card.meta.title)));
            }
            Ok(json!({ "slug": slug, "from": from, "to": to, "fromTitle": from_card.meta.title, "toTitle": to_card.meta.title }))
        }
        other => Err(AppError::Invalid(format!("unknown tool {other:?}"))),
    }
}

/// One chat turn from the UI.
pub struct Turn {
    pub slug: String,
    pub id: String,
    pub text: String,
    /// Pre-formatted card context (title/body/tags) from the UI.
    pub context: Option<String>,
    /// Chat thread: a card id, or "project".
    pub thread: String,
    /// Claude session id saved in that thread's file, to resume the conversation.
    pub resume: Option<String>,
}

/// The sidecar's key for a thread: one Claude session per (project, thread).
fn thread_key(slug: &str, thread: &str) -> String {
    format!("{slug}/{thread}")
}

/// Sends one chat turn. `context` is prepended to `text` so the sidecar stays unaware of
/// Dreamer's card shape entirely.
pub fn send_message(app: &AppHandle, state: &AppState, turn: Turn) -> Result<()> {
    if turn.thread != "project" {
        crate::storage::check_id(&turn.thread)?;
    }
    crate::storage::check_slug(&turn.slug)?;
    ensure_started(app, state)?;
    *state.claude.active_slug.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))? = turn.slug.clone();
    // Every turn carries a compact overview of the whole project (titles, tags, stage), so
    // Claude knows what exists without a tool call; then the selected card's details, if any.
    let overview = state
        .with_search(|idx| idx.overview(&turn.slug))
        .ok()
        .flatten()
        .map(|(name, cards)| crate::search::format_project_context(&name, &cards, crate::search::CONTEXT_MAX_CARDS, crate::search::CONTEXT_MAX_CHARS));
    let mut parts: Vec<String> = Vec::new();
    if let Some(o) = overview {
        parts.push(o);
    }
    if let Some(c) = turn.context.filter(|c| !c.trim().is_empty()) {
        parts.push(c);
    }
    let full_text = if parts.is_empty() { turn.text } else { format!("{}\n\n---\n\n{}", parts.join("\n\n"), turn.text) };
    write_line(
        state,
        &json!({ "type": "user_message", "id": turn.id, "text": full_text, "thread": thread_key(&turn.slug, &turn.thread), "resume": turn.resume }),
    );
    Ok(())
}

/// Drops the sidecar's live session for one thread (after "Reset chat"). No-op when the
/// sidecar isn't running: a fresh start has no sessions anyway.
pub fn reset_thread(state: &AppState, slug: &str, thread: &str) {
    write_line(state, &json!({ "type": "reset_thread", "thread": thread_key(slug, thread) }));
}

pub fn interrupt(state: &AppState) -> Result<()> {
    write_line(state, &json!({ "type": "interrupt" }));
    Ok(())
}

/// Kills the Node child so it never outlives the app (relevant because minimize-to-tray means
/// the window closing does not end the process; only an explicit Quit should).
pub fn shutdown(state: &AppState) {
    if let Ok(mut guard) = state.claude.sidecar.lock() {
        if let Some(sc) = guard.as_mut() {
            let _ = sc.child.kill();
        }
        *guard = None;
    }
}
