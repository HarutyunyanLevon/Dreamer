//! Bridges the chat panel to `sidecar/claude-sidecar.mjs`, a Node process that talks to the
//! Claude Agent SDK (and so to the user's locally installed, already-logged-in Claude Code).
//! Communication is newline-delimited JSON over the child's stdio. The sidecar's `create_card`
//! tool does not touch files itself: it asks us to, over this same channel, so every card still
//! goes through `storage::Workspace` (one writer, atomic writes, ids stay ULIDs).

use crate::error::{AppError, Result};
use crate::model::{NewCard, Source};
use crate::state::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub struct ClaudeState {
    sidecar: Mutex<Option<Sidecar>>,
    active_slug: Mutex<String>,
}

impl Default for ClaudeState {
    fn default() -> Self {
        ClaudeState { sidecar: Mutex::new(None), active_slug: Mutex::new("inbox".into()) }
    }
}

struct Sidecar {
    child: Child,
    stdin: std::process::ChildStdin,
}

#[derive(Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub version: Option<String>,
}

/// A quick, best-effort check: is a `claude` executable on PATH. Login status is not checked
/// here (there is no cheap, side-effect-free way to ask); a missing login surfaces instead as an
/// `authentication_failed` error on the first real chat turn, which the chat panel shows inline.
pub fn claude_status() -> ClaudeStatus {
    match Command::new("claude").arg("--version").output() {
        Ok(out) if out.status.success() => {
            ClaudeStatus { installed: true, version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()) }
        }
        _ => ClaudeStatus { installed: false, version: None },
    }
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
    let mut cmd = Command::new("node");
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
            let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
            let card = guard.create_card(&slug, new_card)?;
            serde_json::to_value(&card).map_err(|e| AppError::Parse { context: "create_card result".into(), message: e.to_string() })
        }
        other => Err(AppError::Invalid(format!("unknown tool {other:?}"))),
    }
}

/// Sends one chat turn. `context` (a card's title/body/tags, already formatted by the caller) is
/// prepended to `text` so the sidecar stays unaware of Dreamer's card shape entirely.
pub fn send_message(app: &AppHandle, state: &AppState, slug: String, id: String, text: String, context: Option<String>) -> Result<()> {
    ensure_started(app, state)?;
    *state.claude.active_slug.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))? = slug;
    let full_text = match context {
        Some(c) if !c.trim().is_empty() => format!("{c}\n\n---\n\n{text}"),
        _ => text,
    };
    write_line(state, &json!({ "type": "user_message", "id": id, "text": full_text }));
    Ok(())
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
