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
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// stderr lines kept for the "Show details" of a crash.
const STDERR_TAIL: usize = 20;

pub struct ClaudeState {
    sidecar: Mutex<Option<Sidecar>>,
    /// Bumped on every spawn: a reader thread only acts on the sidecar it was started for.
    generation: AtomicU64,
    /// Set on the first spawn, so paths without an AppHandle (write_line, shutdown) can still report.
    app: OnceLock<AppHandle>,
    active_slug: Mutex<String>,
    /// Card ids selected on the canvas at the last turn (list_cards scope "selection").
    selection: Mutex<Vec<String>>,
    /// The folder open on the canvas at the last turn: Claude's new cards land there.
    folder: Mutex<Option<String>>,
    pub setup: crate::claude_setup::SetupState,
    /// The running handoff session (gap check or generation), if any. See handoff.rs.
    pub handoff: Mutex<Option<crate::handoff::Job>>,
    /// Turns in flight: the project snapshot to record once Claude has answered (by turn id).
    pending_ctx: Mutex<std::collections::HashMap<String, PendingCtx>>,
    /// Memory passes (one per project at a time). See memory.rs.
    pub memory: Mutex<crate::memory::Queue>,
    /// Router hysteresis per thread key. See router.rs.
    router: Mutex<std::collections::HashMap<String, crate::router::RouterState>>,
}

struct PendingCtx {
    /// The sidecar generation this turn was sent to; it fails with that sidecar.
    generation: u64,
    slug: String,
    thread: String,
    ctx: crate::ctx::Ctx,
    /// What the memory pass needs once Claude has answered (None: a fixed chip command, no pass).
    memory: Option<MemoryTurn>,
    /// A one-turn Claude visit from a local thread: its fresh session's tokens and context
    /// snapshot are not the thread's, so they aren't recorded.
    escalated: bool,
}

struct MemoryTurn {
    user: String,
    question: Option<String>,
}

impl ClaudeState {
    /// (project, thread) of a turn that is still in flight.
    pub fn pending_ctx_of(&self, turn: &str) -> Option<(String, String)> {
        self.pending_ctx.lock().ok()?.get(turn).map(|p| (p.slug.clone(), p.thread.clone()))
    }
}

impl Default for ClaudeState {
    fn default() -> Self {
        ClaudeState { sidecar: Mutex::new(None), generation: AtomicU64::new(0), app: OnceLock::new(), active_slug: Mutex::new("inbox".into()), selection: Mutex::new(Vec::new()), folder: Mutex::new(None), setup: Default::default(), handoff: Mutex::new(None), pending_ctx: Default::default(), memory: Default::default(), router: Default::default() }
    }
}

struct Sidecar {
    child: Child,
    stdin: std::process::ChildStdin,
    /// The sidecar and every Claude Code process it starts; ends them all on quit, and Windows
    /// ends them by itself if Dreamer dies without quitting (see proc_guard.rs).
    tree: crate::proc_guard::TreeGuard,
    generation: u64,
    /// Last STDERR_TAIL stderr lines, and whether the stderr reader has reached EOF.
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stderr_done: Arc<AtomicBool>,
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
    // Dev only: the repo's `sidecar/` folder (uses the repo's node_modules).
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar").join("claude-sidecar.mjs");
        if dev.is_file() {
            return Ok(dev);
        }
    }
    // Release: `src-tauri/sidecar-dist` (script + its own node_modules, built by
    // scripts/build-sidecar.mjs) shipped as the `sidecar` resource.
    if let Ok(dir) = app.path().resource_dir() {
        let res = dir.join("sidecar").join("claude-sidecar.mjs");
        if res.is_file() {
            return Ok(res);
        }
    }
    Err(AppError::Invalid("the Claude sidecar script is missing from this build".into()))
}

pub(crate) fn ensure_started(app: &AppHandle, state: &AppState) -> Result<()> {
    let mut guard = state.claude.sidecar.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))?;
    if guard.is_some() {
        return Ok(());
    }
    let script = claude_setup::child_path(&sidecar_script_path(app)?);
    // Imports resolve from the script's location (dev: walks up to the repo's node_modules;
    // release: the bundled `sidecar/node_modules`). Release cwd = the sidecar's own folder; dev
    // keeps the repo root so Claude Code finds the transcripts of threads started in dev.
    let dir = script.parent();
    let cwd = if cfg!(debug_assertions) { dir.and_then(|p| p.parent()) } else { dir }.map(claude_setup::child_path);
    // Resolve Node the same way as `claude` (a GUI-launched app may not inherit the terminal's PATH).
    let node = claude_setup::resolve(Tool::Node).unwrap_or_else(|| PathBuf::from("node"));
    let mut cmd = claude_setup::command(&node);
    cmd.arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // The release sidecar ships without the SDK's bundled binary; it runs the user's Claude Code.
    if let Some(exe) = claude_setup::claude_executable() {
        cmd.env("DREAMER_CLAUDE_EXE", claude_setup::child_path(&exe));
    }
    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }
    // SpriteCook (artifact images): the server URL and the key from the OS credential store. The
    // sidecar strips the key from every Claude Code process's env; it only goes into the MCP header.
    if let Ok(settings) = state.ws.lock().map_err(|_| ()).and_then(|ws| ws.get_settings().map_err(|_| ())) {
        cmd.env("DREAMER_SPRITECOOK_URL", &settings.spritecook_url);
        cmd.env("DREAMER_CREDIT_CAP", settings.credit_cap.to_string());
    }
    match crate::credentials::spritecook_key() {
        Some(k) => cmd.env("DREAMER_SPRITECOOK_KEY", k),
        None => cmd.env_remove("DREAMER_SPRITECOOK_KEY"),
    };
    let _ = state.claude.app.set(app.clone());
    let generation = state.claude.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let exe = claude_setup::claude_executable();
    crate::sidecar_log::line(&format!(
        "spawn #{generation}: node={} script={} claude={} cwd={}",
        node.display(),
        script.display(),
        exe.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "(SDK default)".into()),
        cwd.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "(inherited)".into()),
    ));
    let mut child = cmd.spawn().map_err(|e| {
        crate::sidecar_log::line(&format!("spawn #{generation} failed: {e}"));
        AppError::io("spawn the Claude sidecar (is Node.js installed?)", e)
    })?;
    crate::sidecar_log::line(&format!("spawn #{generation}: pid {}", child.id()));
    // Adopt it before it can start anything (it only starts Claude Code on the first message).
    let tree = crate::proc_guard::TreeGuard::adopt(&child);
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL)));
    let stderr_done = Arc::new(AtomicBool::new(false));

    let out_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            match serde_json::from_str::<Value>(&line) {
                Ok(msg) => {
                    // Token counts and thinking text stream many lines per turn: not worth a log line each.
                    if !matches!(msg.get("type").and_then(Value::as_str), Some("usage" | "thinking_delta")) {
                        crate::sidecar_log::line(&format!("<- #{generation} {}", crate::sidecar_log::summary(&msg)));
                    }
                    handle_sidecar_message(&out_app, msg);
                }
                Err(_) => crate::sidecar_log::line(&format!("<- #{generation} non-JSON stdout line ({} bytes)", line.len())),
            }
        }
        // EOF: the sidecar exited, crashed or closed stdout. Either way it can't answer any more.
        on_exit(&out_app, generation, "stdout closed", None);
    });
    let err_app = app.clone();
    let (tail, done) = (stderr_tail.clone(), stderr_done.clone());
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
            eprintln!("[claude-sidecar] {line}");
            crate::sidecar_log::line(&format!("stderr #{generation}: {line}"));
            if let Ok(mut t) = tail.lock() {
                if t.len() == STDERR_TAIL {
                    t.pop_front();
                }
                t.push_back(line.clone());
            }
            let _ = err_app.emit("claude-event", json!({ "type": "stderr", "message": line }));
        }
        done.store(true, Ordering::SeqCst);
    });
    // Belt and braces for the EOF check: a process can die while something else holds its stdout
    // open. Polls the exit status of this generation until it is gone.
    let mon_app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let state = mon_app.state::<AppState>();
        let exited = match state.claude.sidecar.lock() {
            Ok(mut g) => match g.as_mut() {
                Some(sc) if sc.generation == generation => matches!(sc.child.try_wait(), Ok(Some(_))),
                _ => return,
            },
            Err(_) => return,
        };
        if exited {
            on_exit(&mon_app, generation, "process exited", None);
            return;
        }
    });

    *guard = Some(Sidecar { child, stdin, tree, generation, stderr_tail, stderr_done });
    Ok(())
}

/// Message types worth resending to a respawned sidecar after a broken pipe: each starts work on
/// its own. (A tool_response, interrupt or reset means nothing to a fresh process.)
fn resendable(value: &Value) -> Option<String> {
    let kind = value.get("type").and_then(Value::as_str)?;
    let id = match kind {
        "user_message" => value.get("id"),
        "oneshot_start" | "memory_start" => value.get("job"),
        _ => None,
    }?;
    id.as_str().map(str::to_string)
}

enum WriteError {
    NotRunning,
    Broken(u64, std::io::Error),
}

fn try_write(state: &AppState, value: &Value) -> std::result::Result<u64, WriteError> {
    let mut guard = state.claude.sidecar.lock().map_err(|_| WriteError::NotRunning)?;
    let sc = guard.as_mut().ok_or(WriteError::NotRunning)?;
    let r = writeln!(sc.stdin, "{value}").and_then(|_| sc.stdin.flush());
    r.map(|_| sc.generation).map_err(|e| WriteError::Broken(sc.generation, e))
}

/// Sends one protocol line. A broken pipe means the sidecar is gone: that is handled as an exit
/// (in-flight work fails visibly), and a message that starts work is resent once to a fresh sidecar.
pub(crate) fn write_line(state: &AppState, value: &Value) {
    let summary = crate::sidecar_log::summary(value);
    match try_write(state, value) {
        Ok(generation) => crate::sidecar_log::line(&format!("-> #{generation} {summary}")),
        Err(WriteError::NotRunning) => crate::sidecar_log::line(&format!("-> (no sidecar) dropped {summary}")),
        Err(WriteError::Broken(generation, e)) => {
            crate::sidecar_log::line(&format!("-> #{generation} write failed ({e}): {summary}"));
            let Some(app) = state.claude.app.get().cloned() else { return };
            let resend = resendable(value);
            on_exit(&app, generation, "write failed", resend.as_deref());
            let Some(id) = resend else { return };
            let retried = ensure_started(&app, state).map_err(|e| e.to_string()).and_then(|_| match try_write(state, value) {
                Ok(g) => Ok(g),
                Err(WriteError::Broken(_, e)) => Err(e.to_string()),
                Err(WriteError::NotRunning) => Err("not running".into()),
            });
            match retried {
                Ok(g) => {
                    crate::sidecar_log::line(&format!("-> #{g} resent {summary}"));
                    if let Ok(mut pending) = state.claude.pending_ctx.lock() {
                        if let Some(p) = pending.get_mut(&id) {
                            p.generation = g;
                        }
                    }
                }
                Err(e) => {
                    crate::sidecar_log::line(&format!("resend of {summary} failed: {e}"));
                    // A fresh sidecar that broke too is an exit of its own.
                    let g = state.claude.generation.load(Ordering::SeqCst);
                    if g != generation {
                        on_exit(&app, g, "resend failed", None);
                    }
                    // Then fail what was kept for the resend (still filed under the old generation).
                    fail_in_flight(&app, generation, None, &[format!("Resend after a broken pipe failed: {e}")], None, false);
                }
            }
        }
    }
}

/// The sidecar of `generation` is gone (EOF, exit, or broken pipe). Runs once per generation:
/// clears it so the next send respawns, logs the exit code, and fails everything it was running.
/// `keep`: a turn or job id about to be resent to a fresh sidecar; it is not failed.
fn on_exit(app: &AppHandle, generation: u64, reason: &str, keep: Option<&str>) {
    let state = app.state::<AppState>();
    let taken = {
        let Ok(mut g) = state.claude.sidecar.lock() else { return };
        if g.as_ref().is_some_and(|sc| sc.generation == generation) { g.take() } else { None }
    };
    let Some(mut sc) = taken else { return }; // already handled, or stopped on purpose (shutdown)
    // Give a dying process a moment to report its code; one that is somehow still alive is ended.
    let deadline = Instant::now() + Duration::from_secs(2);
    let code = loop {
        match sc.child.try_wait() {
            Ok(Some(st)) => break st.code(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = sc.child.kill();
                break sc.child.wait().ok().and_then(|s| s.code());
            }
        }
    };
    sc.tree.kill_all();
    // The last stderr lines usually say why; let the reader drain them first.
    let deadline = Instant::now() + Duration::from_secs(1);
    while !sc.stderr_done.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    let tail: Vec<String> = sc.stderr_tail.lock().map(|t| t.iter().cloned().collect()).unwrap_or_default();
    crate::sidecar_log::line(&format!("exit #{generation}: code {} ({reason})", code.map(|c| c.to_string()).unwrap_or_else(|| "none".into())));
    fail_in_flight(app, generation, code, &tail, keep, false);
}

/// Fails the chat turns, handoff session and memory passes that were running on a sidecar that is
/// gone, so nothing waits forever. `restarted`: the app stopped it on purpose (not a crash).
fn fail_in_flight(app: &AppHandle, generation: u64, code: Option<i32>, tail: &[String], keep: Option<&str>, restarted: bool) {
    let state = app.state::<AppState>();
    let ids: Vec<String> = match state.claude.pending_ctx.lock() {
        Ok(mut pending) => {
            let ids: Vec<String> = pending.iter().filter(|(id, p)| p.generation == generation && Some(id.as_str()) != keep).map(|(id, _)| id.clone()).collect();
            for id in &ids {
                pending.remove(id);
            }
            ids
        }
        Err(_) => Vec::new(),
    };
    if restarted && ids.is_empty() {
        return;
    }
    crate::sidecar_log::line(&format!("failing #{generation}: {} turn(s) in flight", ids.len()));
    let _ = app.emit("claude-event", json!({ "type": "sidecar_exit", "code": code, "lastStderr": tail, "ids": ids, "keep": keep, "restarted": restarted }));
    if restarted {
        return;
    }
    // Handoff and memory are locked by their own callers while they write; finish them off-thread.
    let (app, keep, code) = (app.clone(), keep.map(str::to_string), code);
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let what = format!("Claude's helper stopped (code {}).", code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into()));
        let handoff = state.claude.handoff.lock().ok().and_then(|g| g.as_ref().map(|j| j.id.clone()));
        if let Some(job) = handoff.filter(|j| Some(j) != keep.as_ref()) {
            crate::handoff::finish(&app, &state, &json!({ "type": "oneshot_done", "job": job, "ok": false, "error": what }));
        }
        for job in crate::memory::running_jobs(&state) {
            if Some(&job) != keep.as_ref() {
                crate::memory::on_done(&app, &job, false);
            }
        }
    });
}

fn handle_sidecar_message(app: &AppHandle, msg: Value) {
    match msg.get("type").and_then(Value::as_str) {
        Some("memory_result") => {
            crate::memory::on_result(&app.state::<AppState>(), msg.get("job").and_then(Value::as_str).unwrap_or_default(), msg.get("result").cloned().unwrap_or(Value::Null));
            return;
        }
        Some("memory_done") => {
            let (app, job, ok) = (app.clone(), msg.get("job").and_then(Value::as_str).unwrap_or_default().to_string(), msg.get("ok").and_then(Value::as_bool).unwrap_or(false));
            std::thread::spawn(move || crate::memory::on_done(&app, &job, ok));
            return;
        }
        // Live activity of a one-shot job (handoff session or memory pass): routed to its own view.
        Some("step" | "usage" | "thinking_delta") if msg.get("job").is_some() => {
            route_job_activity(app, msg);
            return;
        }
        _ => {}
    }
    if msg.get("type").and_then(Value::as_str) == Some("tool_request") {
        let state = app.state::<AppState>();
        let req_id = msg.get("reqId").and_then(Value::as_str).unwrap_or_default().to_string();
        let tool = msg.get("tool").and_then(Value::as_str).unwrap_or_default();
        let input = msg.get("input").cloned().unwrap_or(Value::Null);
        // Artifact tools write into the artifact of the turn's thread (a download may take a while,
        // so they run off the thread that reads the sidecar's output).
        if tool.starts_with("artifact_") {
            let (app, tool, input) = (app.clone(), tool.to_string(), input);
            std::thread::spawn(move || {
                let state = app.state::<AppState>();
                let turn = input.get("turn").and_then(Value::as_str).unwrap_or_default();
                let result = match state.claude.pending_ctx_of(turn) {
                    Some((slug, thread)) if thread != "project" => crate::artifacts::run_tool(&state, &slug, &thread, &tool, &input),
                    _ => Err(AppError::Invalid("this turn is not an artifact turn".into())),
                };
                let reply = match result {
                    Ok(result) => json!({ "type": "tool_response", "reqId": req_id, "result": result }),
                    Err(e) => json!({ "type": "tool_response", "reqId": req_id, "error": e.to_string() }),
                };
                write_line(&state, &reply);
            });
            return;
        }
        let result = if tool.starts_with("handoff_") {
            crate::handoff::run_tool(app, &state, tool, input)
        } else if matches!(tool, "remember" | "forget") {
            crate::memory::run_tool(app, &state, tool, input)
        } else {
            run_tool(&state, tool, input)
        };
        let reply = match result {
            Ok(result) => json!({ "type": "tool_response", "reqId": req_id, "result": result }),
            Err(e) => json!({ "type": "tool_response", "reqId": req_id, "error": e.to_string() }),
        };
        write_line(&state, &reply);
        return;
    }
    if msg.get("type").and_then(Value::as_str) == Some("oneshot_done") {
        // Writing a version copies files: keep that off the thread that streams chat replies.
        let app = app.clone();
        std::thread::spawn(move || crate::handoff::finish(&app, &app.state::<AppState>(), &msg));
        return;
    }
    record_turn_result(app, &msg);
    let _ = app.emit("claude-event", msg);
}

/// A handoff job's steps/usage go to the handoff panel (handoff-event); a memory pass's usage becomes
/// the "Updating memory…" line under the chat turn it follows (claude-event memory_progress).
fn route_job_activity(app: &AppHandle, msg: Value) {
    let state = app.state::<AppState>();
    let job = msg.get("job").and_then(Value::as_str).unwrap_or_default().to_string();
    let is_handoff = state.claude.handoff.lock().ok().and_then(|g| g.as_ref().map(|j| j.id == job)).unwrap_or(false);
    if is_handoff {
        crate::handoff::emit(app, &job, msg);
        return;
    }
    if msg.get("type").and_then(Value::as_str) != Some("usage") {
        return;
    }
    if let Some(turn) = crate::memory::turn_of(&state, &job) {
        let n = |k: &str| msg.get(k).and_then(Value::as_u64).unwrap_or(0);
        let input = n("input") + n("cacheRead") + n("cacheCreate");
        let _ = app.emit("claude-event", json!({ "type": "memory_progress", "id": turn, "active": true, "input": input, "output": n("output") }));
    }
}

/// Keeps the thread file's Rust-owned fields in step with what the sidecar reports: token usage and
/// the context snapshot after an answered turn, the summary after a compaction.
fn record_turn_result(app: &AppHandle, msg: &Value) {
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or_default();
    if !matches!(kind, "message_done" | "error" | "compacted") {
        return;
    }
    let Some(id) = msg.get("id").and_then(Value::as_str) else { return };
    let state = app.state::<AppState>();
    let mut memory_turn = None;
    let target = {
        let Ok(mut pending) = state.claude.pending_ctx.lock() else { return };
        if kind == "compacted" {
            pending.get(id).map(|p| (p.slug.clone(), p.thread.clone(), None, p.escalated))
        } else {
            pending.remove(id).map(|p| {
                memory_turn = p.memory;
                (p.slug, p.thread, Some(p.ctx), p.escalated)
            })
        }
    };
    let Some((slug, thread, ctx, escalated)) = target else { return };
    // The memory pass runs after the answer is in: never during it, never blocking the chat.
    if kind == "message_done" && msg.get("isError").and_then(Value::as_bool) != Some(true) {
        if let Some(m) = &memory_turn {
            let reply = msg.get("text").and_then(Value::as_str).unwrap_or_default();
            let (app, id, slug, thread, user, reply, question) = (app.clone(), id.to_string(), slug.clone(), thread.clone(), m.user.clone(), reply.to_string(), m.question.clone());
            std::thread::spawn(move || {
                let info = crate::memory::TurnInfo { slug: &slug, thread: &thread, turn: &id, user: &user, reply: &reply, question: question.as_deref() };
                crate::memory::after_turn(&app, &app.state::<AppState>(), info);
            });
        }
    }
    if escalated {
        return;
    }
    let Ok(ws) = state.ws.lock() else { return };
    let _ = ws.update_chat(&slug, &thread, |f| match kind {
        "compacted" => {
            f.insert("summary".into(), msg.get("summary").cloned().unwrap_or(Value::Null));
            f.insert("last_input_tokens".into(), json!(0));
        }
        "message_done" => {
            if let Some(n) = msg.get("inputTokens").and_then(Value::as_u64) {
                f.insert("last_input_tokens".into(), json!(n));
            }
            if let Some(n) = msg.get("contextWindow").and_then(Value::as_u64).filter(|n| *n > 0) {
                f.insert("context_window".into(), json!(n));
            }
            if msg.get("isError").and_then(Value::as_bool) != Some(true) {
                if let Some(c) = ctx.and_then(|c| serde_json::to_value(c).ok()) {
                    f.insert("ctx".into(), c);
                }
            }
        }
        _ => {}
    });
}

/// What read_card says about an attachment (no file contents; view_attachment has those).
fn attachment_summary(a: &crate::model::Attachment) -> Value {
    use crate::model::Attachment;
    match a {
        Attachment::Image { id, caption, .. } => json!({ "id": id, "type": "image", "caption": caption }),
        Attachment::Clip { id, url, title, caption, excerpt, .. } => {
            json!({ "id": id, "type": "clip", "caption": caption, "title": title, "url": url, "has_excerpt": excerpt.is_some() })
        }
    }
}

/// Longest side Claude gets an image at (larger ones are downscaled by the API anyway).
const MAX_IMAGE_SIDE: u32 = 1568;

/// Decodes an image, shrinks it to MAX_IMAGE_SIDE on its long side, and re-encodes it
/// (JPEG for opaque images, PNG when it has transparency). Returns (mime, base64).
fn downscale_for_claude(bytes: &[u8]) -> Result<(&'static str, String)> {
    use base64::Engine;
    use image::{GenericImageView, ImageFormat};
    let img = image::load_from_memory(bytes).map_err(|e| AppError::Invalid(format!("can't read this image: {e}")))?;
    let (w, h) = img.dimensions();
    let img = if w.max(h) > MAX_IMAGE_SIDE { img.resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, image::imageops::FilterType::Triangle) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    let mime = if img.color().has_alpha() {
        img.write_to(&mut out, ImageFormat::Png).map_err(|e| AppError::Invalid(format!("encode image: {e}")))?;
        "image/png"
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
            .encode_image(&img.to_rgb8())
            .map_err(|e| AppError::Invalid(format!("encode image: {e}")))?;
        "image/jpeg"
    };
    Ok((mime, base64::engine::general_purpose::STANDARD.encode(out.into_inner())))
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
                // Claude may make plain cards, stickies and checklists (e.g. a /critique list).
                kind: input
                    .get("kind")
                    .cloned()
                    .and_then(|v| serde_json::from_value::<crate::model::CardKind>(v).ok())
                    .filter(|k| matches!(k, crate::model::CardKind::Card | crate::model::CardKind::Sticky | crate::model::CardKind::Checklist)),
                items: input.get("items").cloned().and_then(|v| serde_json::from_value(v).ok()),
                folder: state.claude.folder.lock().ok().and_then(|f| f.clone()),
                ..Default::default()
            };
            let card = {
                let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
                // The folder may be gone since the turn started: then the card lands at the root.
                let mut new_card = new_card;
                new_card.folder = new_card.folder.filter(|f| guard.folders(&slug).is_ok_and(|l| l.iter().any(|x| &x.id == f)));
                guard.create_card(&slug, new_card)?
            };
            // Don't wait for the watcher's debounce: a search right after this should see it.
            if let Ok(mut idx) = state.search.lock() {
                idx.mark_dirty(Some(&slug));
            }
            to_json(&card, "create_card result")
        }
        // A merge is only a ghost: the originals are moved to Trash by the UI when the user Keeps it.
        "merge_cards" => {
            use crate::model::{Link, Stage};
            let slug = active_slug(state)?;
            let ids: Vec<String> = input.get("ids").cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
            let mut uniq: Vec<String> = Vec::new();
            for id in ids {
                crate::storage::check_id(&id)?;
                if !uniq.contains(&id) {
                    uniq.push(id);
                }
            }
            if uniq.len() < 2 {
                return Err(AppError::Invalid("merge_cards needs at least 2 distinct card ids".into()));
            }
            let card = {
                let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
                let project = guard.load_project(&slug)?;
                let rank = |s: Stage| match s {
                    Stage::Mist => 0,
                    Stage::Reverie => 1,
                    Stage::Lucid => 2,
                    Stage::Dream => 3,
                };
                let mut stage = Stage::Mist;
                let mut links: Vec<Link> = Vec::new();
                let mut atts: Vec<&[crate::model::Attachment]> = Vec::new();
                let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
                // The merge lands on the canvas of the first original that has a place.
                let mut folder: Option<Option<String>> = None;
                for id in &uniq {
                    let c = project.cards.iter().find(|c| &c.meta.id == id).ok_or_else(|| AppError::NotFound(format!("card {id} in the open project")))?;
                    atts.push(&c.meta.attachments);
                    if rank(c.meta.stage) > rank(stage) {
                        stage = c.meta.stage;
                    }
                    for l in &c.meta.links {
                        if !uniq.contains(&l.to) && !links.iter().any(|x| x.to == l.to) {
                            links.push(l.clone());
                        }
                    }
                    let on = std::iter::once((None, &project.canvas)).chain(project.canvases.iter().map(|(k, c)| (Some(k.clone()), c))).find_map(|(k, c)| c.cards.get(id).map(|p| (k, *p)));
                    if let Some((k, p)) = on {
                        if folder.is_none() {
                            folder = Some(k.clone());
                        }
                        if folder.as_ref() == Some(&k) {
                            sx += p.x;
                            sy += p.y;
                            n += 1.0;
                        }
                    }
                }
                let new_card = NewCard {
                    title: input.get("title").and_then(Value::as_str).map(str::to_string),
                    body: input.get("body").and_then(Value::as_str).map(str::to_string),
                    tags: input.get("tags").cloned().and_then(|v| serde_json::from_value(v).ok()),
                    stage: Some(stage),
                    links: Some(links),
                    source: Some(Source::Claude),
                    ghost: Some(true),
                    merged_from: Some(uniq),
                    // Concatenated in the given card order, deduped by path/url.
                    attachments: Some(crate::model::merge_attachments(atts)),
                    x: (n > 0.0).then(|| sx / n),
                    y: (n > 0.0).then(|| sy / n),
                    folder: folder.flatten(),
                    ..Default::default()
                };
                guard.create_card(&slug, new_card)?
            };
            if let Ok(mut idx) = state.search.lock() {
                idx.mark_dirty(Some(&slug));
            }
            to_json(&card, "merge_cards result")
        }
        // ---- read-only retrieval tools: nothing below writes to disk ----
        "search_cards" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or_default();
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
            let project = match input.get("scope").and_then(Value::as_str) {
                Some("project") => Some(active_slug(state)?),
                _ => None,
            };
            let mut hits = state.with_search(|idx| idx.search(query, project.as_deref(), limit.min(25)))?;
            if let Ok(ws) = state.ws.lock() {
                ws.annotate_hits(&mut hits);
            }
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
                v["kind"] = to_json(&card.meta.kind, "kind")?;
                // A summary only; view_attachment shows an image or a clip's saved text.
                v["attachments"] = Value::Array(card.meta.attachments.iter().map(attachment_summary).collect());
                // No data: URIs, no raw HTML, nothing over the cap: attachments are referred to by id.
                crate::ctx::claude_json(&mut v);
                Ok(v)
            })?
        }
        "list_cards" => {
            let slug = active_slug(state)?;
            let selection = state.claude.selection.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))?.clone();
            let only_selection = input.get("scope").and_then(Value::as_str) == Some("selection");
            if only_selection && selection.is_empty() {
                return Err(AppError::Invalid("nothing is selected on the canvas; use scope \"project\"".into()));
            }
            let (frames, folder_of) = {
                let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
                (ws.card_frames(&slug)?, ws.card_folder_paths(&slug).unwrap_or_default())
            };
            let mut cards = state.with_search(|idx| idx.overview(&slug).map(|(_, c)| c).unwrap_or_default())?;
            cards.retain(|c| !c.ghost && (!only_selection || selection.contains(&c.id)));
            cards.sort_by(|a, b| b.updated.cmp(&a.updated));
            let out: Vec<Value> = cards
                .iter()
                .map(|c| json!({ "id": c.id, "kind": c.kind, "title": c.title, "stage": c.stage, "tags": c.tags, "frame": frames.get(&c.id), "folder": folder_of.get(&c.id) }))
                .collect();
            Ok(Value::Array(out))
        }
        "list_related" => {
            let id = input.get("id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(id)?;
            let related = state.with_search(|idx| idx.related(id, 20))?.ok_or_else(|| AppError::NotFound(format!("card {id}")))?;
            to_json(&related, "related cards")
        }
        // Only *proposes* a link: validated here, then shown in the UI as a dashed ghost link the
        // user must Keep. Nothing is written to any card file.
        "list_tree" => crate::organize::list_tree(state, &active_slug(state)?, state.claude.folder.lock().ok().and_then(|f| f.clone()), &input),
        // Only *proposes* a reorganization: checked in full here, previewed and applied by the UI.
        "propose_organize" => crate::organize::propose_organize(state, &active_slug(state)?, state.claude.folder.lock().ok().and_then(|f| f.clone()), &input),
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
        // Read-only: one attachment for Claude to look at. Images come back downscaled as base64;
        // clips as the page excerpt saved when the clip was made.
        "view_attachment" => {
            let id = input.get("card_id").and_then(Value::as_str).unwrap_or_default();
            let att_id = input.get("attachment_id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(id)?;
            view_attachment(state, &active_slug(state)?, id, att_id)
        }
        // Only *proposes* changes: validated, then saved as cards/<id>.proposal.json (never the
        // card file). The card shows a badge; the user keeps or dismisses it in a diff view.
        "propose_edit" => {
            let id = input.get("card_id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(id)?;
            let slug = active_slug(state)?;
            let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
            let card = guard.read_card(&slug, id)?;
            let mut p = serde_json::Map::new();
            for k in ["title", "body"] {
                if let Some(v) = input.get(k).and_then(Value::as_str) {
                    p.insert(k.into(), json!(v));
                }
            }
            if let Some(t) = input.get("tags").filter(|v| !v.is_null()) {
                let tags: Vec<String> = serde_json::from_value(t.clone()).map_err(|_| AppError::Invalid("tags must be a list of strings".into()))?;
                p.insert("tags".into(), json!(tags));
            }
            if let Some(st) = input.get("stage").filter(|v| !v.is_null()) {
                let stage: crate::model::Stage = serde_json::from_value(st.clone()).map_err(|_| AppError::Invalid("stage must be mist, reverie, lucid or dream".into()))?;
                p.insert("stage".into(), json!(stage));
            }
            if let Some(caps) = input.get("captions").and_then(Value::as_object).filter(|m| !m.is_empty()) {
                for (att, c) in caps {
                    if !card.meta.attachments.iter().any(|a| a.id() == att) {
                        return Err(AppError::NotFound(format!("attachment {att} on card {id}")));
                    }
                    if !c.is_string() {
                        return Err(AppError::Invalid("each caption must be a string".into()));
                    }
                }
                p.insert("captions".into(), Value::Object(caps.clone()));
            }
            if p.is_empty() {
                return Err(AppError::Invalid("propose_edit needs at least one of title, body, tags, stage, captions".into()));
            }
            p.insert("reason".into(), json!(input.get("reason").and_then(Value::as_str).unwrap_or_default()));
            p.insert("created".into(), json!(crate::storage::now()));
            guard.write_proposal(&slug, id, &Value::Object(p))?;
            drop(guard);
            if let Ok(mut idx) = state.search.lock() {
                idx.mark_dirty(Some(&slug));
            }
            Ok(json!({ "slug": slug, "title": card.meta.title }))
        }
        other => Err(AppError::Invalid(format!("unknown tool {other:?}"))),
    }
}


/// One attachment for Claude to look at: an image downscaled to base64, or a clip's saved excerpt.
/// Read-only. Shared by the chat's and the handoff session's view_attachment.
pub(crate) fn view_attachment(state: &AppState, slug: &str, id: &str, att_id: &str) -> Result<Value> {
    use crate::model::Attachment;
    let (att, bytes) = {
        let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let card = guard.read_card(slug, id)?;
        let att = card.meta.attachments.iter().find(|a| a.id() == att_id).cloned().ok_or_else(|| AppError::NotFound(format!("attachment {att_id} on card {id}")))?;
        let file = match &att {
            Attachment::Image { path, .. } => Some(path.clone()),
            Attachment::Clip { excerpt, .. } => excerpt.clone(),
        };
        let bytes = file.map(|f| guard.read_project_file(slug, &f)).transpose();
        (att, bytes)
    };
    match att {
        Attachment::Image { caption, .. } => {
            let (mime, data) = downscale_for_claude(&bytes?.unwrap_or_default())?;
            Ok(json!({ "kind": "image", "caption": caption, "mime": mime, "data": data }))
        }
        Attachment::Clip { url, title, caption, .. } => {
            let text = match bytes {
                Ok(Some(b)) => crate::ctx::claude_text(&String::from_utf8_lossy(&b)),
                _ => "no excerpt".into(),
            };
            Ok(json!({ "kind": "clip", "url": url, "title": title, "caption": caption, "text": text }))
        }
    }
}

/// Most chars of the folder block; one card's body inside the open folder.
const FOLDER_CTX_MAX: usize = 24_000;
const FOLDER_CARD_MAX: usize = 2_000;

/// The folder tree and where every card lives; inside a folder, that folder's cards in full and
/// every other card as title + folder path. Returns (block, shape) where `shape` changes only
/// when the tree, the open folder or a card's folder does (so edits alone don't resend it).
fn folder_context(folders: &[crate::model::Folder], of_card: &std::collections::HashMap<String, String>, open: Option<&str>, bodies: &[crate::model::Card], cards: &[crate::search::OverviewCard]) -> (String, String) {
    let paths = crate::storage::Workspace::folder_paths(folders);
    let path_of = |id: &str| of_card.get(id).and_then(|f| paths.get(f)).cloned().unwrap_or_else(|| "project root".into());
    let kept: Vec<&crate::search::OverviewCard> = cards.iter().filter(|c| !c.ghost).collect();
    let mut out = String::from("[Folders]");
    fn walk(out: &mut String, folders: &[crate::model::Folder], parent: Option<&str>, depth: usize, of_card: &std::collections::HashMap<String, String>) {
        for f in folders.iter().filter(|f| f.parent.as_deref() == parent) {
            let n = of_card.values().filter(|x| **x == f.id).count();
            let title = if f.title.trim().is_empty() { "Untitled folder" } else { f.title.trim() };
            out.push_str(&format!("\n{}- {title} ({n} card{})", "  ".repeat(depth), if n == 1 { "" } else { "s" }));
            walk(out, folders, Some(&f.id), depth + 1, of_card);
        }
    }
    walk(&mut out, folders, None, 0, of_card);
    let mut shape: Vec<String> = folders.iter().map(|f| format!("{}<{}:{}", f.id, f.parent.as_deref().unwrap_or(""), f.title)).collect();
    let mut placed: Vec<String> = of_card.iter().map(|(c, f)| format!("{c}@{f}")).collect();
    placed.sort();
    shape.extend(placed);
    shape.push(format!("open={}", open.unwrap_or("")));
    match open.and_then(|o| paths.get(o).map(|p| (o, p))) {
        Some((open_id, path)) => {
            out.push_str(&format!("\n\n[Open folder] {path}: the user is working inside this folder. Its cards in full:"));
            for c in bodies.iter().filter(|c| !c.meta.ghost) {
                let stage = serde_json::to_value(c.meta.stage).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
                let body = if c.body.trim().is_empty() { "(no notes yet)".to_string() } else { crate::ctx::cap_for_claude(&crate::ctx::clean_for_claude(&c.body), FOLDER_CARD_MAX) };
                let tags = if c.meta.tags.is_empty() { String::new() } else { format!(" · tags: {}", c.meta.tags.join(", ")) };
                out.push_str(&format!("\n\n- {} · \"{}\" · {stage}{tags}\n{body}", c.meta.id, c.meta.title.trim()));
            }
            out.push_str("\n\nOther cards (id · title · folder):");
            for c in kept.iter().filter(|c| of_card.get(&c.id).map(String::as_str) != Some(open_id)) {
                out.push_str(&format!("\n- {} · \"{}\" · {}", c.id, c.title.trim(), path_of(&c.id)));
            }
        }
        None => {
            out.push_str("\n\nCards inside folders (id · title · folder):");
            for c in kept.iter().filter(|c| of_card.contains_key(&c.id)) {
                out.push_str(&format!("\n- {} · \"{}\" · {}", c.id, c.title.trim(), path_of(&c.id)));
            }
        }
    }
    (crate::ctx::cap_for_claude(&out, FOLDER_CTX_MAX), shape.join("\n"))
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
    /// The folder open on the canvas (None = the project root).
    pub folder: Option<String>,
    /// Claude session id saved in that thread's file, to resume the conversation.
    pub resume: Option<String>,
    /// This turn may use WebSearch / WebFetch (the chat's globe toggle).
    pub web: bool,
    /// Card ids selected on the canvas.
    pub selection: Vec<String>,
    /// Run the memory pass after this turn (false for fixed chip commands like /expand).
    pub memory: bool,
    /// The question this turn's text answers (a grill-me choice), for the memory pass.
    pub question: Option<String>,
    /// "Think" is on for this message: deep model and a thinking budget.
    pub think: bool,
    /// A tier the user pinned in the chat header (beats the router).
    pub pin: Option<crate::router::Tier>,
    /// The thread's local-model session id (separate from `resume`, its Claude session).
    pub resume_local: Option<String>,
    /// "Retry with Claude" on a failed local turn.
    pub retry_with_claude: bool,
    /// An organize turn: scope "folder" | "project", and a backend the user forced ("Redo with
    /// Claude" / "Redo locally"); None = by the number of cards in scope.
    pub organize: Option<(String, Option<crate::router::Backend>)>,
    /// An artifact turn (create, regenerate, a suggestion chip, feedback in the artifact's thread):
    /// the artifact id (= its card id). Always runs on Claude, with SpriteCook and the artifact tools.
    pub artifact: Option<String>,
    /// The chat thread an artifact request came from (escalate_artifact): its recap goes along.
    pub recap_from: Option<String>,
}

/// Messages of a local thread an escalated Claude turn sees verbatim (besides the recap).
const ESCALATION_RECENT: usize = 6;
pub const RECAP_SLOT: &str = "{{RECAP}}";

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
    *state.claude.selection.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))? = turn.selection.clone();
    *state.claude.folder.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))? = turn.folder.clone();
    let (settings, frames, file, memory, card, folder_info) = {
        let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let card = if turn.thread == "project" { None } else { ws.read_card(&turn.slug, &turn.thread).ok() };
        let folders = ws.folders(&turn.slug).unwrap_or_default();
        let info = (!folders.is_empty()).then(|| {
            let of_card = ws.card_folders(&turn.slug).unwrap_or_default();
            let open = turn.folder.as_deref().filter(|f| folders.iter().any(|x| x.id == *f)).map(str::to_string);
            let bodies: Vec<crate::model::Card> = match &open {
                Some(f) => of_card.iter().filter(|(_, x)| *x == f).filter_map(|(id, _)| ws.read_card(&turn.slug, id).ok()).collect(),
                None => Vec::new(),
            };
            (folders, of_card, open, bodies)
        });
        (ws.get_settings().unwrap_or_default(), ws.card_frames(&turn.slug).unwrap_or_default(), ws.load_chat(&turn.slug, &turn.thread).unwrap_or(Value::Null), ws.read_memory(&turn.slug), card, info)
    };
    let cards = state.with_search(|idx| idx.overview(&turn.slug)).ok().flatten().map(|(name, mut cards)| {
        for c in &mut cards {
            c.frame = frames.get(&c.id).cloned();
        }
        (name, cards)
    });
    let folder_ctx = folder_info.as_ref().map(|(folders, of_card, open, bodies)| folder_context(folders, of_card, open.as_deref(), bodies, cards.as_ref().map(|c| c.1.as_slice()).unwrap_or(&[])));

    // What Claude has seen already (the snapshot saved with the thread) vs. the project now.
    let prev: Option<crate::ctx::Ctx> = file.get("ctx").and_then(|c| serde_json::from_value(c.clone()).ok());
    let mark = card.as_ref().map(|c| crate::ctx::CardMark { id: c.meta.id.clone(), updated: c.meta.updated.clone() });
    let now = crate::ctx::snapshot(cards.as_ref().map(|c| c.1.as_slice()).unwrap_or(&[]), memory.as_deref(), mark);
    // A thread with no snapshot yet (older files) just sends the user's words: a delta against
    // nothing would call every card new.
    let mut now = now;
    now.folders = folder_ctx.as_ref().map(|(_, shape)| crate::ctx::hash(shape)).unwrap_or_default();
    let block = prev.as_ref().and_then(|p| crate::ctx::delta(p, &now, memory.as_deref(), card.as_ref()));
    // Moving between folders (or reshaping them) re-sends the folder block in a live session.
    let folder_moved = prev.as_ref().is_some_and(|p| p.folders != now.folders);
    let block = match (block, folder_moved.then(|| folder_ctx.as_ref().map(|(b, _)| b.clone())).flatten()) {
        (Some(b), Some(f)) => Some(format!("{b}

{f}")),
        (b, f) => b.or(f),
    };

    // An artifact turn starts with the artifact block (it changes every turn, so both texts carry it).
    let mut turn = turn;
    if let Some(a) = turn.artifact.clone() {
        let block = {
            let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
            crate::artifacts::context_block(&ws, &turn.slug, &a, settings.credit_cap, crate::credentials::spritecook_key().is_some())?
        };
        turn.text = format!("{block}\n\n---\n\n{}", turn.text);
    }
    // Which tier, then which backend (router.rs). Local chat asks Ollama whether it's usable
    // (a cached check plus one version ping); Claude-only setups never touch it.
    let key = thread_key(&turn.slug, &turn.thread);
    let tier = {
        let mut map = state.claude.router.lock().map_err(|_| AppError::Invalid("router lock poisoned".into()))?;
        crate::router::route(map.entry(key.clone()).or_default(), &turn.text, turn.think, turn.pin, settings.model_router)
    };
    let local = settings.local_chat.then(|| state.ollama.for_turn(&settings.local_model));
    let local_ready = local.as_ref().is_some_and(|l| l.ready);
    let mut route = crate::router::backend(tier, turn.web, turn.retry_with_claude, settings.local_chat, local_ready);
    // Artifacts always run on Claude, in the artifact thread's own (resumable) Claude session.
    if turn.artifact.is_some() {
        route = crate::router::Route { backend: crate::router::Backend::Claude, escalated: false, reason: None };
    }
    // Organize: small scopes on the local model, big ones (or "Redo with Claude") on Claude.
    let mut route_note: Option<String> = None;
    if let Some((scope, forced)) = &turn.organize {
        use crate::router::{Backend, Reason, Route};
        let n = crate::organize::scope_count(state, &turn.slug, turn.folder.as_deref(), scope).unwrap_or(0);
        let big = n > crate::organize::LOCAL_MAX_CARDS;
        match forced {
            Some(Backend::Claude) if route.backend == Backend::Local => route = Route { backend: Backend::Claude, escalated: true, reason: Some(Reason::Retry) },
            Some(Backend::Local) if route.backend == Backend::Claude && settings.local_chat && local_ready => route = Route { backend: Backend::Local, escalated: false, reason: None },
            None if big && route.backend == Backend::Local => route = Route { backend: Backend::Claude, escalated: true, reason: Some(Reason::Size) },
            None if big && route.reason.is_none() => route.reason = Some(Reason::Size),
            _ => {}
        }
        if route.reason == Some(Reason::Size) {
            route_note = Some(format!("{n} cards in scope (over {})", crate::organize::LOCAL_MAX_CARDS));
        }
    }
    let is_local = route.backend == crate::router::Backend::Local;
    let local_model = local.as_ref().and_then(|l| l.variant.clone()).unwrap_or_default();

    // The first message of a session (or one whose session could not be resumed, or that follows a
    // compaction) carries everything instead; the sidecar picks. A local thread compacts by 64k
    // (its context window), and a thread that has history but no local session yet (it ran on
    // Claude before) starts its local session from a summary of that history.
    let messages = file.get("messages").and_then(Value::as_array).map_or(0, Vec::len);
    let compact = if route.escalated {
        false
    } else if is_local {
        crate::ctx::should_compact(&file, crate::ctx::local_compact_tokens(settings.compact_tokens)) || (turn.resume_local.is_none() && messages >= 2)
    } else {
        crate::ctx::should_compact(&file, settings.compact_tokens)
    };
    // Related cards for this message (retrieval replaces the full card list). A card Claude already
    // got in this session is skipped unless it changed since; after a compaction, in a session
    // without history, or in an escalation's fresh session everything counts as unseen.
    let seen: std::collections::BTreeMap<String, String> = if compact || route.escalated { Default::default() } else { prev.as_ref().map(|p| p.sent.clone()).unwrap_or_default() };
    let card_id = card.as_ref().map(|c| c.meta.id.clone());
    let retrieved = state.with_search(|idx| idx.retrieve(&turn.slug, card_id.as_deref(), &turn.text)).unwrap_or_default();
    let fresh: Vec<crate::search::Retrieved> = retrieved.into_iter().filter(|r| seen.get(&r.id) != Some(&r.updated)).collect();
    now.sent = seen;
    for r in &fresh {
        now.sent.insert(r.id.clone(), r.updated.clone());
    }
    let related_block = (!fresh.is_empty()).then(|| crate::search::format_related(&fresh));

    // Constant-ish parts first, per-message parts last (cache-friendly); the system prompt itself never changes.
    let mut parts: Vec<String> = Vec::new();
    let memory_part = memory.as_deref().map(|m| format!("[Project memory]\n{}", crate::ctx::cap_chars(m, crate::ctx::MEMORY_MAX_CHARS)));
    if let Some(m) = &memory_part {
        parts.push(m.clone());
    }
    let digest = cards.as_ref().map(|(name, cs)| crate::search::project_digest(name, cs));
    if let Some(d) = &digest {
        parts.push(d.clone());
    }
    if let Some((f, _)) = &folder_ctx {
        parts.push(f.clone());
    }
    let card_ctx = turn.context.as_deref().filter(|c| !c.trim().is_empty()).map(|c| crate::ctx::cap_for_claude(&crate::ctx::clean_for_claude(c), crate::ctx::MAX_CARD_CHARS));
    if let Some(c) = &card_ctx {
        parts.push(format!("[This card]\n{c}"));
    }
    // An escalation gets the local model's recap of the thread (the sidecar writes it into the
    // slot) plus the last few messages, never the whole transcript.
    let transcript = crate::ctx::transcript(&file);
    let mut recap_job = route.escalated && local_ready && !transcript.trim().is_empty();
    // An artifact requested from a chat thread: that thread's recap (local model) and last messages.
    let source = turn.recap_from.as_deref().filter(|t| *t != turn.thread).and_then(|t| state.ws.lock().ok().and_then(|ws| ws.load_chat(&turn.slug, t).ok()));
    let source_transcript = source.as_ref().map(crate::ctx::transcript).filter(|t| !t.trim().is_empty());
    if let Some(src) = &source {
        let recap = source_transcript.is_some() && local_ready;
        if recap {
            parts.push(format!("[Recap of the conversation that asked for this]
{RECAP_SLOT}"));
            recap_job = true;
        }
        if let Some(r) = crate::ctx::recent_turns(src, ESCALATION_RECENT) {
            parts.push(format!("[Last messages of that conversation]
{r}"));
        }
    }
    let earlier = if route.escalated {
        recap_job.then(|| RECAP_SLOT.to_string())
    } else if compact {
        Some(crate::ctx::SUMMARY_SLOT.to_string())
    } else {
        file.get("summary").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string)
    };
    if let Some(s) = earlier {
        parts.push(format!("{}\n{s}", if route.escalated { "[Recap of this thread so far]" } else { "[Earlier in this thread]" }));
    }
    if route.escalated {
        if let Some(r) = crate::ctx::recent_turns(&file, ESCALATION_RECENT) {
            parts.push(format!("[Last messages in this thread]\n{r}"));
        }
    }
    if let Some(r) = &related_block {
        parts.push(r.clone());
    }
    let full_text = if parts.is_empty() { turn.text.clone() } else { format!("{}\n\n---\n\n{}", parts.join("\n\n"), turn.text) };
    // A live session gets the change block plus the related cards; the full text above is for a
    // new one. An escalation always opens a fresh session, so it always sends the full text.
    let delta_block = match (block, related_block.clone()) {
        (Some(b), Some(r)) => Some(format!("{b}\n\n{r}")),
        (b, r) => b.or(r),
    };
    let delta_text = if route.escalated { full_text.clone() } else { crate::ctx::with_block(delta_block, &turn.text) };

    // Sizes only, never content: what each part of this turn weighs (chars), for diagnosing context bloat.
    let n = |o: Option<&String>| o.map_or(0, |s| s.chars().count());
    crate::sidecar_log::line(&format!(
        "send_message {} thread={} resume={} compact={} chars: memory={} digest={} this_card={} (raw {}) related={} ({} cards) earlier={} user={} delta_block={} | text={} fullText={}",
        turn.id,
        key,
        if is_local { turn.resume_local.is_some() } else { turn.resume.is_some() },
        compact,
        n(memory_part.as_ref()),
        n(digest.as_ref()),
        n(card_ctx.as_ref()),
        turn.context.as_deref().map_or(0, |c| c.chars().count()),
        n(related_block.as_ref()),
        fresh.len(),
        file.get("summary").and_then(Value::as_str).map_or(0, |s| s.chars().count()),
        turn.text.chars().count(),
        delta_text.chars().count().saturating_sub(turn.text.chars().count()),
        delta_text.chars().count(),
        full_text.chars().count(),
    ));
    if let Ok(mut pending) = state.claude.pending_ctx.lock() {
        let generation = state.claude.generation.load(Ordering::SeqCst);
        pending.insert(
            turn.id.clone(),
            PendingCtx { generation, slug: turn.slug.clone(), thread: turn.thread.clone(), ctx: now, memory: turn.memory.then(|| MemoryTurn { user: turn.text.clone(), question: turn.question.clone() }), escalated: route.escalated },
        );
    }
    let model: String = if is_local {
        local_model.clone()
    } else if turn.artifact.is_some() {
        if turn.think { settings.model_deep.clone() } else { settings.model_chat.clone() }
    } else if route.escalated && tier != crate::router::Tier::Deep {
        // Web, or Retry with Claude, from a local thread: the main Claude model.
        settings.model_chat.clone()
    } else {
        match tier {
            crate::router::Tier::Fast => settings.model_fast.clone(),
            crate::router::Tier::Main => settings.model_chat.clone(),
            crate::router::Tier::Deep => settings.model_deep.clone(),
        }
    };
    let backend = if is_local { "local" } else { "claude" };
    crate::sidecar_log::line(&format!(
        "route {} tier={} backend={backend} model={model} escalated={} reason={:?} pinned={} think={}",
        turn.id,
        tier.as_str(),
        route.escalated,
        route.reason,
        turn.pin.is_some(),
        turn.think
    ));
    // The chat shows where the turn runs before anything streams (and why, when it isn't local).
    let shown_model = if is_local { settings.local_model.clone() } else { model.clone() };
    let _ = app.emit("claude-event", json!({ "type": "route", "id": turn.id, "backend": backend, "model": shown_model, "escalated": route.escalated, "reason": route.reason, "note": route_note.or_else(|| (route.reason == Some(crate::router::Reason::Unavailable)).then(|| local.as_ref().and_then(|l| l.error.clone())).flatten()) }));
    let resume = if is_local {
        turn.resume_local.clone()
    } else if route.escalated {
        None
    } else {
        turn.resume.clone()
    };
    let mut msg = json!({
        "type": "user_message", "id": turn.id, "text": delta_text, "fullText": full_text,
        "thread": key, "resume": resume, "model": model, "web": turn.web && !is_local, "tier": tier.as_str(),
        "think": turn.think && !is_local, "backend": backend, "escalated": route.escalated
    });
    if is_local {
        let vision = local.as_ref().and_then(|l| l.vision).unwrap_or(false);
        msg["local"] = json!({ "baseUrl": crate::ollama::BASE_URL, "vision": vision });
    }
    // A router-picked fast Claude turn that fails or comes back empty is retried once on the main
    // model. Never for local turns: those offer "Retry with Claude" instead.
    if !is_local && !route.escalated && tier == crate::router::Tier::Fast && turn.pin.is_none() && turn.artifact.is_none() {
        msg["retryModel"] = json!(settings.model_chat);
    }
    if compact {
        // A local thread is summarized by the local model.
        let model = if is_local { local_model.clone() } else { settings.model_memory.clone() };
        msg["compact"] = json!({ "transcript": transcript, "model": model, "local": is_local });
    }
    if recap_job {
        let t = source_transcript.clone().unwrap_or_else(|| transcript.clone());
        msg["recap"] = json!({ "transcript": t, "model": local_model, "baseUrl": crate::ollama::BASE_URL });
    }
    if let Some(a) = &turn.artifact {
        msg["artifact"] = json!({ "id": a, "cap": settings.credit_cap, "spritecookUrl": settings.spritecook_url });
    }
    write_line(state, &msg);
    Ok(())
}

/// Drops the sidecar's live session for one thread (after "Reset chat"). No-op when the
/// sidecar isn't running: a fresh start has no sessions anyway.
pub fn reset_thread(state: &AppState, slug: &str, thread: &str) {
    if let Ok(mut map) = state.claude.router.lock() {
        map.remove(&thread_key(slug, thread));
    }
    write_line(state, &json!({ "type": "reset_thread", "thread": thread_key(slug, thread) }));
}

/// `hard`: also close the thread's Claude session (Retry after a stall); its next message resumes it.
pub fn interrupt(state: &AppState, hard: bool) -> Result<()> {
    write_line(state, &json!({ "type": "interrupt", "hard": hard }));
    Ok(())
}

/// Kills the Node child so it never outlives the app (relevant because minimize-to-tray means
/// the window closing does not end the process; only an explicit Quit should).
pub fn shutdown(state: &AppState) {
    let stopped = match state.claude.sidecar.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    };
    let Some(mut sc) = stopped else { return };
    // The whole tree: the sidecar and the Claude Code processes it started.
    sc.tree.kill_all();
    let _ = sc.child.kill();
    let _ = sc.child.wait();
    crate::sidecar_log::line(&format!("stopped #{} by the app", sc.generation));
    // A turn still waiting on it would otherwise wait forever: fail it (Retry starts a new sidecar).
    if let Some(app) = state.claude.app.get() {
        fail_in_flight(app, sc.generation, None, &["Dreamer restarted Claude's helper (for example after a sign-in) while this reply was in progress.".into()], None, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn images_are_downscaled_to_the_long_side_limit() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(3000, 1000).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let (mime, data) = downscale_for_claude(png.get_ref()).unwrap();
        assert_eq!(mime, "image/jpeg", "opaque images go as JPEG");
        let out = image::load_from_memory(&base64::engine::general_purpose::STANDARD.decode(data).unwrap()).unwrap();
        assert_eq!((out.width(), out.height()), (MAX_IMAGE_SIDE, 523));

        let mut small = std::io::Cursor::new(Vec::new());
        image::RgbaImage::new(40, 20).write_to(&mut small, image::ImageFormat::Png).unwrap();
        let (mime, data) = downscale_for_claude(small.get_ref()).unwrap();
        assert_eq!(mime, "image/png", "transparency keeps PNG");
        assert_eq!(image::load_from_memory(&base64::engine::general_purpose::STANDARD.decode(data).unwrap()).unwrap().width(), 40, "small images keep their size");
        assert!(downscale_for_claude(b"not an image").is_err());
    }
}
