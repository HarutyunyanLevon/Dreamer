//! Reliability harness (see docs/reliability-report.md and scripts/reliability/run.mjs).
//!
//! Drives the real chat pipeline headlessly: the real sidecar (sidecar/claude-sidecar.mjs), the
//! real Rust tool handlers and validators, the real Ollama / Claude Code. It stands in for the chat
//! panel: it calls `sidecar::send_message` like the `claude_send` command does, listens to the same
//! `claude-event` stream, keeps the thread files the way useClaudeChat does, and classifies how
//! each turn ended. Everything runs on a temp copy of a workspace; the original is never written.
//!
//! Run: `cargo run --bin reliability -- --scenarios S1,S2 --runs 10` (from src-tauri), or
//! `node scripts/reliability/run.mjs` from the repo root.
//!
//! Fault hooks used by the scenarios (inert unless set): DREAMER_FAULT_TOOL_DELAY (Rust, here),
//! DREAMER_FAKE_LOCAL_URL / DREAMER_FAKE_CLAUDE_URL (sidecar: point Claude Code at the fake
//! Anthropic server below).

use crate::model::{Canvas, Pos, SettingsPatch};
use crate::sidecar::{self, Turn};
use crate::state::AppState;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Listener, Manager};

// ---------------------------------------------------------------------------------------------
// Fault hooks (called from the app code; no-ops unless the harness set them)
// ---------------------------------------------------------------------------------------------

/// DREAMER_FAULT_TOOL_DELAY="<tool>:<ms>": the Rust reply to that sidecar tool request comes late.
pub fn fault_tool_delay(tool: &str) {
    let Ok(spec) = std::env::var("DREAMER_FAULT_TOOL_DELAY") else { return };
    if let Some((t, ms)) = spec.split_once(':') {
        if t == tool || t == "*" {
            if let Ok(ms) = ms.parse::<u64>() {
                std::thread::sleep(Duration::from_millis(ms));
            }
        }
    }
}

fn set_env(k: &str, v: Option<&str>) {
    // The harness is the only thread touching these, between scenarios.
    unsafe {
        match v {
            Some(v) => std::env::set_var(k, v),
            None => std::env::remove_var(k),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// A fake Anthropic Messages server (stall / error tests without real model or Claude usage)
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FakeMode {
    /// Accepts the request and never answers.
    Silent,
    /// Starts streaming (message_start + a little text), then goes quiet forever.
    StallMid,
    /// Starts streaming, then drops the connection (a crashed server).
    DropMid,
    /// Answers HTTP 500 every time.
    Error500,
    /// Streams a complete short answer.
    Ok,
}

pub struct FakeServer {
    pub url: String,
    stop: Arc<AtomicBool>,
    pub requests: Arc<Mutex<u32>>,
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn sse(out: &mut TcpStream, event: &str, data: Value) -> std::io::Result<()> {
    write!(out, "event: {event}\ndata: {data}\n\n")?;
    out.flush()
}

fn fake_conn(mut s: TcpStream, mode: FakeMode, stop: Arc<AtomicBool>, requests: Arc<Mutex<u32>>) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let mut r = BufReader::new(s.try_clone().expect("clone"));
    let mut len = 0usize;
    let mut first = String::new();
    if r.read_line(&mut first).unwrap_or(0) == 0 {
        return;
    }
    loop {
        let mut l = String::new();
        if r.read_line(&mut l).unwrap_or(0) == 0 || l == "\r\n" || l == "\n" {
            break;
        }
        if let Some(v) = l.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; len];
    let _ = r.read_exact(&mut body);
    if !first.contains("/v1/messages") || first.contains("count_tokens") {
        let _ = write!(s, "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
    }
    *requests.lock().unwrap() += 1;
    // HARNESS_DUMP_DIR: keep the request's shape (what Claude Code sends to the model server).
    if let Some(dir) = std::env::var_os("HARNESS_DUMP_DIR") {
        if let Ok(v) = serde_json::from_slice::<Value>(&body) {
            let tools: Vec<String> = v.get("tools").and_then(Value::as_array).map(|a| a.iter().filter_map(|t| t.get("name").and_then(Value::as_str)).map(str::to_string).collect()).unwrap_or_default();
            let shape = json!({
                "path": first.trim(), "model": v.get("model"), "max_tokens": v.get("max_tokens"), "temperature": v.get("temperature"),
                "thinking": v.get("thinking"), "stream": v.get("stream"), "tools": tools, "toolsChars": v.get("tools").map(|t| t.to_string().len()),
                "systemChars": v.get("system").map(|t| t.to_string().len()), "messagesChars": v.get("messages").map(|t| t.to_string().len()),
                "keys": v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()),
            });
            let n = *requests.lock().unwrap();
            let _ = std::fs::write(PathBuf::from(dir).join(format!("request-{n}.json")), serde_json::to_string_pretty(&shape).unwrap());
        }
    }
    let hold = |stop: &AtomicBool| {
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
        }
    };
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n";
    let start = |s: &mut TcpStream| -> std::io::Result<()> {
        s.write_all(head.as_bytes())?;
        sse(s, "message_start", json!({"type":"message_start","message":{"id":"msg_fake","type":"message","role":"assistant","model":"fake","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}))?;
        sse(s, "content_block_start", json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}))?;
        sse(s, "content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial "}}))
    };
    match mode {
        FakeMode::Silent => hold(&stop),
        FakeMode::StallMid => {
            let _ = start(&mut s);
            hold(&stop);
        }
        FakeMode::DropMid => {
            let _ = start(&mut s);
            std::thread::sleep(Duration::from_millis(300));
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
        FakeMode::Error500 => {
            let b = json!({"type":"error","error":{"type":"api_error","message":"fake server error"}}).to_string();
            let _ = write!(s, "HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}", b.len());
        }
        FakeMode::Ok => {
            let _ = (|| -> std::io::Result<()> {
                start(&mut s)?;
                sse(&mut s, "content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer from the fake server."}}))?;
                sse(&mut s, "content_block_stop", json!({"type":"content_block_stop","index":0}))?;
                sse(&mut s, "message_delta", json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":6}}))?;
                sse(&mut s, "message_stop", json!({"type":"message_stop"}))
            })();
        }
    }
}

pub fn fake_server(mode: FakeMode) -> FakeServer {
    let l = TcpListener::bind("127.0.0.1:0").expect("bind fake server");
    let url = format!("http://{}", l.local_addr().unwrap());
    l.set_nonblocking(true).ok();
    let stop = Arc::new(AtomicBool::new(false));
    let requests = Arc::new(Mutex::new(0));
    let (st, rq) = (stop.clone(), requests.clone());
    std::thread::spawn(move || {
        while !st.load(Ordering::SeqCst) {
            match l.accept() {
                Ok((s, _)) => {
                    s.set_nonblocking(false).ok();
                    let (st, rq) = (st.clone(), rq.clone());
                    std::thread::spawn(move || fake_conn(s, mode, st, rq));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    });
    FakeServer { url, stop, requests }
}

// ---------------------------------------------------------------------------------------------
// The workspace copy
// ---------------------------------------------------------------------------------------------

fn copy_dir(from: &Path, to: &Path, skip: &[&str]) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let name = e.file_name();
        if skip.iter().any(|s| name.to_string_lossy() == *s) {
            continue;
        }
        let (src, dst) = (e.path(), to.join(&name));
        if e.file_type()?.is_dir() {
            copy_dir(&src, &dst, &[])?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// The S3 fixture: every card of the project (trashed ones restored) on ONE canvas, scattered,
/// with no folders, two of them pinned. That is the unorganized ~40-card case organize is for.
fn build_flat_fixture(dir: &Path) -> std::io::Result<usize> {
    let trash = dir.join("trash");
    if trash.is_dir() {
        for e in std::fs::read_dir(&trash)? {
            let e = e?;
            if e.path().extension().is_some_and(|x| x == "md") {
                std::fs::rename(e.path(), dir.join("cards").join(e.file_name()))?;
            }
        }
    }
    let mut ids: Vec<String> = std::fs::read_dir(dir.join("cards"))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".md") && !n.contains(".proposal"))
        .map(|n| n.trim_end_matches(".md").to_string())
        .collect();
    ids.sort();
    let _ = std::fs::remove_dir_all(dir.join("canvases"));
    std::fs::write(dir.join("folders.json"), "{\"folders\": []}")?;
    let mut canvas = Canvas::default();
    // A deterministic mess: a loose diagonal scatter with overlaps, the way a brainstorm looks.
    for (i, id) in ids.iter().enumerate() {
        let (x, y) = (((i * 397) % 2600) as f64, ((i * 233) % 1700) as f64);
        canvas.cards.insert(id.clone(), Pos { x, y, w: None, h: None, z: Some(i as i64), back: false, pinned: i == 3 || i == 17 });
    }
    std::fs::write(dir.join("canvas.json"), serde_json::to_string_pretty(&canvas).unwrap())?;
    Ok(ids.len())
}

// ---------------------------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum End {
    Done,
    Empty,
    Error,
    /// The app itself ended the turn as stalled (watchdog).
    Stalled,
    /// The harness stopped the turn on purpose (S5).
    Interrupted,
    /// Nothing ended the turn within the harness cap: an infinite spinner in the app.
    Spinner,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct TurnResult {
    pub id: String,
    pub end: End,
    pub backend: Option<String>,
    pub model: Option<String>,
    /// From the send to the first event after "route" (ms).
    pub ttfe_ms: Option<u64>,
    pub total_ms: u64,
    pub last_event: Option<(u64, String)>,
    pub text_chars: usize,
    pub fallback: Option<String>,
    pub end_reason: Option<String>,
    pub error: Option<String>,
    pub tools: Vec<String>,
    pub compacted: bool,
    pub retried_local: bool,
    /// Events for this turn that arrived after it had ended (they would land on a dead message).
    pub late_events: usize,
    /// Events for some other, earlier turn that arrived while this one ran.
    pub foreign_events: usize,
    pub plan: Option<Value>,
    pub question: bool,
    #[serde(skip)]
    pub text: String,
}

#[derive(Default, Clone)]
pub struct TurnOpts {
    pub thread: String,
    pub text: String,
    pub folder: Option<String>,
    pub think: bool,
    pub retry_with_claude: bool,
    pub organize: Option<(String, Option<crate::router::Backend>)>,
    pub organize_extra: Option<Value>,
}

#[derive(Default)]
struct ThreadState {
    session: Option<String>,
    local_session: Option<String>,
    messages: Vec<Value>,
}

pub struct Driver {
    pub app: AppHandle,
    pub slug: String,
    rx: Receiver<(Instant, Value)>,
    threads: HashMap<String, ThreadState>,
    seq: u64,
    /// Ids of turns that already ended (late events for them are counted, not acted on).
    ended: BTreeSet<String>,
    pub cap: Duration,
}

/// What a scenario's fault hook may do when an event of the running turn arrives.
pub enum Act {
    None,
    /// Stop the turn the way the Stop button does (soft interrupt; the UI frees the turn at once).
    Interrupt,
}

fn event_turn(v: &Value) -> Option<String> {
    v.get("id").and_then(Value::as_str).or_else(|| v.get("turnId").and_then(Value::as_str)).map(str::to_string)
}

impl Driver {
    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    pub fn reset_thread(&mut self, thread: &str) {
        sidecar::reset_thread(&self.state(), &self.slug, thread);
        let _ = self.state().ws.lock().unwrap().reset_chat(&self.slug, thread);
        self.threads.remove(thread);
    }

    fn save_thread(&self, thread: &str) {
        let Some(t) = self.threads.get(thread) else { return };
        let data = json!({ "version": 1, "sessionId": t.session, "localSessionId": t.local_session, "messages": t.messages });
        let _ = self.state().ws.lock().unwrap().save_chat(&self.slug, thread, &data);
    }

    /// One turn, start to end. `hook` sees every event of the turn (ms since send, event).
    pub fn turn(&mut self, o: &TurnOpts, mut hook: impl FnMut(u64, &Value, &mut Driver) -> Act) -> TurnResult {
        self.seq += 1;
        let id = format!("h{}-{}", std::process::id(), self.seq);
        let t = self.threads.entry(o.thread.clone()).or_default();
        let (resume, resume_local) = (t.session.clone(), t.local_session.clone());
        t.messages.push(json!({ "id": format!("{id}-u"), "role": "user", "text": o.text }));
        let turn = Turn {
            slug: self.slug.clone(),
            id: id.clone(),
            text: o.text.clone(),
            context: None,
            thread: o.thread.clone(),
            folder: o.folder.clone(),
            resume,
            web: false,
            selection: Vec::new(),
            memory: false,
            question: None,
            think: o.think,
            pin: None,
            resume_local,
            retry_with_claude: o.retry_with_claude,
            organize: o.organize.clone(),
            organize_instruction: o.organize.as_ref().map(|_| String::new()),
            organize_prior: o.organize_extra.clone(),
            organize_rest: o.organize_extra.is_some(),
            artifact: None,
            recap_from: None,
        };
        let started = Instant::now();
        let ms = |at: Instant| at.saturating_duration_since(started).as_millis() as u64;
        let mut r = TurnResult {
            id: id.clone(),
            end: End::Spinner,
            backend: None,
            model: None,
            ttfe_ms: None,
            total_ms: 0,
            last_event: None,
            text_chars: 0,
            fallback: None,
            end_reason: None,
            error: None,
            tools: Vec::new(),
            compacted: false,
            retried_local: false,
            late_events: 0,
            foreign_events: 0,
            plan: None,
            question: false,
            text: String::new(),
        };
        // send_message may block (Ollama readiness check, sidecar spawn): off this thread, like a Tauri command.
        let app = self.app.clone();
        let send = std::thread::spawn(move || sidecar::send_message(&app, &app.state::<AppState>(), turn));
        let mut send = Some(send);
        let mut interrupted_at: Option<Instant> = None;
        loop {
            if let Some(h) = send.as_ref().filter(|h| h.is_finished()) {
                let _ = h;
                if let Err(e) = send.take().unwrap().join().unwrap_or(Ok(())) {
                    r.end = End::Error;
                    r.error = Some(format!("send failed: {e}"));
                    break;
                }
            }
            if started.elapsed() > self.cap {
                r.end = End::Spinner;
                break;
            }
            // After a Stop, the UI is done with the turn; we only wait a moment for its tail.
            if let Some(at) = interrupted_at {
                if at.elapsed() > Duration::from_secs(3) {
                    r.end = End::Interrupted;
                    break;
                }
            }
            let (at, v) = match self.rx.recv_timeout(Duration::from_millis(200)) {
                Ok(x) => x,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            let kind = v.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
            if kind == "sidecar_exit" {
                let ids: Vec<String> = v.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
                if ids.contains(&id) {
                    r.end = End::Error;
                    r.error = Some(format!("sidecar exit (code {})", v.get("code").cloned().unwrap_or(Value::Null)));
                    r.last_event = Some((ms(at), kind));
                    break;
                }
                continue;
            }
            let Some(tid) = event_turn(&v) else { continue };
            if tid != id {
                if self.ended.contains(&tid) {
                    r.foreign_events += 1;
                }
                continue;
            }
            if matches!(kind.as_str(), "alive" | "turn_ended") {
                continue;
            }
            if kind != "route" && kind != "stderr" && r.ttfe_ms.is_none() {
                r.ttfe_ms = Some(ms(at));
            }
            r.last_event = Some((ms(at), kind.clone()));
            match kind.as_str() {
                "route" => {
                    r.backend = v.get("backend").and_then(Value::as_str).map(str::to_string);
                    r.model = v.get("model").and_then(Value::as_str).map(str::to_string);
                }
                "delta" => r.text.push_str(v.get("text").and_then(Value::as_str).unwrap_or_default()),
                "step" => {
                    if let Some(s) = v.get("step") {
                        if s.get("kind").and_then(Value::as_str) == Some("tool") && s.get("status").and_then(Value::as_str) != Some("running") {
                            let name = s.get("tool").and_then(Value::as_str).unwrap_or("?").to_string();
                            let st = s.get("status").and_then(Value::as_str).unwrap_or("?");
                            r.tools.push(format!("{name}:{st}:{}ms", s.get("endedAt").and_then(Value::as_u64).unwrap_or(0).saturating_sub(s.get("startedAt").and_then(Value::as_u64).unwrap_or(0))));
                        }
                        if s.get("tool").and_then(Value::as_str) == Some("local_retry") {
                            r.retried_local = true;
                        }
                    }
                }
                "compacted" => r.compacted = true,
                "question" => r.question = true,
                "organize_proposal" => r.plan = v.get("plan").cloned(),
                "model_note" => {
                    if v.get("localRetry").and_then(Value::as_bool) == Some(true) {
                        r.retried_local = true;
                    }
                }
                "message_done" => {
                    let text = v.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
                    if !text.is_empty() {
                        r.text = text;
                    }
                    r.fallback = v.get("fallback").and_then(Value::as_str).map(str::to_string);
                    r.end_reason = v.get("endReason").and_then(Value::as_str).map(str::to_string);
                    if v.get("localRetried").and_then(Value::as_bool) == Some(true) {
                        r.retried_local = true;
                    }
                    if let Some(b) = v.get("backend").and_then(Value::as_str) {
                        r.backend = Some(b.to_string());
                    }
                    let is_err = v.get("isError").and_then(Value::as_bool) == Some(true);
                    r.end = if r.end_reason.as_deref() == Some("stalled") {
                        End::Stalled
                    } else if is_err {
                        End::Error
                    } else if r.text.trim().is_empty() && !r.question && r.plan.is_none() {
                        End::Empty
                    } else {
                        End::Done
                    };
                    // The thread file, as the chat panel keeps it.
                    let escalated = v.get("escalated").and_then(Value::as_bool) == Some(true);
                    if let (Some(sid), false) = (v.get("sessionId").and_then(Value::as_str), escalated) {
                        let t = self.threads.entry(o.thread.clone()).or_default();
                        if v.get("backend").and_then(Value::as_str) == Some("local") {
                            t.local_session = Some(sid.to_string());
                        } else {
                            t.session = Some(sid.to_string());
                        }
                    }
                    break;
                }
                "error" => {
                    r.error = v.get("message").and_then(Value::as_str).map(str::to_string);
                    r.end_reason = v.get("endReason").and_then(Value::as_str).map(str::to_string);
                    r.end = if r.end_reason.as_deref() == Some("stalled") { End::Stalled } else { End::Error };
                    break;
                }
                _ => {}
            }
            if interrupted_at.is_none() {
                if let Act::Interrupt = hook(ms(at), &v, self) {
                    let _ = sidecar::interrupt(&self.state(), false);
                    interrupted_at = Some(Instant::now());
                }
            }
        }
        if r.end == End::Spinner {
            // Clean up so the next scenario starts from a clear state (the user would press Stop).
            let _ = sidecar::interrupt(&self.state(), true);
        }
        r.total_ms = started.elapsed().as_millis() as u64;
        r.text_chars = r.text.chars().count();
        // Late tail: events of this turn after its end.
        let tail_until = Instant::now() + Duration::from_millis(1500);
        while let Some(left) = tail_until.checked_duration_since(Instant::now()) {
            match self.rx.recv_timeout(left) {
                Ok((_, v)) => {
                    if event_turn(&v).as_deref() == Some(id.as_str()) && !matches!(v.get("type").and_then(Value::as_str), Some("memory_progress" | "stderr")) {
                        r.late_events += 1;
                    }
                }
                Err(_) => break,
            }
        }
        if let Some(h) = send.take() {
            let _ = h.join();
        }
        self.ended.insert(id.clone());
        let t = self.threads.entry(o.thread.clone()).or_default();
        t.messages.push(json!({ "id": id, "role": "claude", "text": r.text, "isError": !matches!(r.end, End::Done) }));
        self.save_thread(&o.thread);
        r
    }

    /// Cards in the project, by title (ghosts included).
    fn card_titles(&self) -> Vec<(String, bool)> {
        self.state().ws.lock().unwrap().load_project(&self.slug).map(|p| p.cards.iter().map(|c| (c.meta.title.clone(), c.meta.ghost)).collect()).unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------------------------
// Ollama helpers
// ---------------------------------------------------------------------------------------------

fn ollama_addr() -> String {
    crate::ollama::base_url().trim_start_matches("http://").trim_end_matches('/').to_string()
}

fn http(method: &str, path: &str, body: Option<Value>, timeout: Duration) -> Option<Value> {
    let addr = ollama_addr();
    let mut s = TcpStream::connect(&addr).ok()?;
    s.set_read_timeout(Some(timeout)).ok();
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    write!(s, "{method} {path} HTTP/1.0\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()).ok()?;
    let mut text = String::new();
    s.read_to_string(&mut text).ok()?;
    let body = text.split_once("\r\n\r\n").map(|x| x.1).unwrap_or_default();
    serde_json::from_str(body).ok()
}

pub fn ollama_ps() -> Value {
    http("GET", "/api/ps", None, Duration::from_secs(5)).unwrap_or(Value::Null)
}

/// Unloads every loaded model (keep_alive 0), then waits until /api/ps is empty.
fn unload_models() {
    let ps = ollama_ps();
    for m in ps.get("models").and_then(Value::as_array).cloned().unwrap_or_default() {
        if let Some(name) = m.get("name").and_then(Value::as_str) {
            let _ = http("POST", "/api/generate", Some(json!({ "model": name, "keep_alive": 0 })), Duration::from_secs(30));
        }
    }
    let until = Instant::now() + Duration::from_secs(30);
    while Instant::now() < until && ollama_ps().get("models").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn kill_ollama() {
    let _ = std::process::Command::new("taskkill").args(["/F", "/IM", "ollama.exe"]).output();
}

fn restart_ollama() {
    let addr = ollama_addr();
    if crate::ollama::wait_up(&addr, Duration::from_millis(500)) {
        return;
    }
    crate::ollama::start_server(&addr, None);
    crate::ollama::wait_up(&addr, Duration::from_secs(60));
}

/// Kills the Claude Code processes the sidecar started (a crashed child).
fn kill_claude_children(state: &AppState) -> usize {
    let Some(pid) = sidecar::sidecar_pid(state) else { return 0 };
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("Get-CimInstance Win32_Process -Filter 'ParentProcessId={pid}' | ForEach-Object {{ $_.ProcessId }}")])
        .output();
    let pids: Vec<String> = out.map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().map(str::to_string).collect()).unwrap_or_default();
    for p in &pids {
        let _ = std::process::Command::new("taskkill").args(["/F", "/T", "/PID", p]).output();
    }
    pids.len()
}

// ---------------------------------------------------------------------------------------------
// Organize plan checks (S3)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Default, serde::Serialize)]
pub struct PlanCheck {
    pub ok: bool,
    pub cards: usize,
    pub pinned: usize,
    pub covered: usize,
    pub frames: usize,
    pub retags: usize,
    pub folder_ops: usize,
    pub overlaps: Option<usize>,
    pub unplaced: usize,
    pub problems: Vec<String>,
}

const CARD_W: f64 = 236.0;
const CARD_H: f64 = 150.0;

/// A plan for the open folder: every non-pinned card covered, frames, retags, a tidy layout and no
/// folder ops. `positions` (explicit placement) is checked for overlaps when the plan has it.
pub fn check_plan(state: &AppState, slug: &str, folder: Option<&str>, plan: &Value) -> PlanCheck {
    let mut c = PlanCheck::default();
    let Ok(p) = state.ws.lock().unwrap().load_project(slug) else {
        c.problems.push("project unreadable".into());
        return c;
    };
    let canvas = match folder {
        Some(f) => p.canvases.get(f).cloned().unwrap_or_default(),
        None => p.canvas.clone(),
    };
    let live: BTreeSet<&str> = p.cards.iter().filter(|x| !x.meta.ghost).map(|x| x.meta.id.as_str()).collect();
    let on: Vec<(&String, &Pos)> = canvas.cards.iter().filter(|(id, _)| live.contains(id.as_str())).collect();
    c.cards = on.len();
    c.pinned = on.iter().filter(|(_, p)| p.pinned).count();
    let ops = plan.get("ops").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut covered: BTreeSet<String> = BTreeSet::new();
    let mut placed: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    let folder_ids: BTreeSet<&str> = p.folders.iter().map(|f| f.id.as_str()).collect();
    for op in &ops {
        let kind = op.get("op").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "create_folder" => c.folder_ops += 1,
            "move" => c.folder_ops += 1,
            "rename" if op.get("id").and_then(Value::as_str).is_some_and(|i| folder_ids.contains(i)) => c.folder_ops += 1,
            "create_frame" => c.frames += 1,
            "retag" => c.retags += 1,
            "arrange" => {
                for id in op.get("ids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                    covered.insert(id.to_string());
                }
            }
            "place" => {
                for (id, xy) in op.get("positions").and_then(Value::as_object).into_iter().flatten() {
                    covered.insert(id.clone());
                    if let (Some(x), Some(y)) = (xy.get("x").and_then(Value::as_f64), xy.get("y").and_then(Value::as_f64)) {
                        placed.insert(id.clone(), (x, y));
                    }
                }
            }
            _ => {}
        }
    }
    let need: Vec<&String> = on.iter().filter(|(_, p)| !p.pinned).map(|(id, _)| *id).collect();
    c.covered = need.iter().filter(|id| covered.contains(id.as_str())).count();
    c.unplaced = plan.get("unplaced").and_then(Value::as_array).map_or(0, Vec::len);
    if !placed.is_empty() {
        let size = |id: &str| canvas.cards.get(id).map(|p| (p.w.unwrap_or(CARD_W), p.h.unwrap_or(CARD_H))).unwrap_or((CARD_W, CARD_H));
        let mut rects: Vec<(f64, f64, f64, f64)> = placed.iter().map(|(id, (x, y))| {
            let (w, h) = size(id);
            (*x, *y, w, h)
        }).collect();
        // Pinned cards keep their place and count as obstacles.
        for (id, pp) in &on {
            if pp.pinned {
                let (w, h) = size(id);
                rects.push((pp.x, pp.y, w, h));
            }
        }
        let mut n = 0;
        for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                let (a, b) = (rects[i], rects[j]);
                if a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3 {
                    n += 1;
                }
            }
        }
        c.overlaps = Some(n);
    }
    if c.covered < need.len() {
        c.problems.push(format!("{} of {} non-pinned cards not covered", need.len() - c.covered, need.len()));
    }
    if c.frames == 0 {
        c.problems.push("no frames".into());
    }
    if c.retags == 0 {
        c.problems.push("no retags".into());
    }
    if c.folder_ops > 0 {
        c.problems.push(format!("{} folder ops", c.folder_ops));
    }
    match c.overlaps {
        Some(n) if n > 0 => c.problems.push(format!("{n} overlapping card pairs")),
        None => c.problems.push("no explicit layout (arrange only)".into()),
        _ => {}
    }
    c.ok = c.problems.is_empty();
    c
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct RunRecord {
    pub scenario: String,
    pub run: usize,
    pub ok: bool,
    pub note: String,
    pub turns: Vec<TurnResult>,
    pub plan_check: Option<PlanCheck>,
    pub claude_turns: usize,
}

fn rec(scenario: &str, run: usize, ok: bool, note: impl Into<String>, turns: Vec<TurnResult>) -> RunRecord {
    let claude_turns = turns.iter().filter(|t| t.backend.as_deref() == Some("claude")).count();
    RunRecord { scenario: scenario.into(), run, ok, note: note.into(), turns, plan_check: None, claude_turns }
}

fn plain(thread: &str, text: &str) -> TurnOpts {
    TurnOpts { thread: thread.into(), text: text.into(), ..Default::default() }
}

const SHORT_Q: &str = "In one or two sentences: what is this project about?";

fn s1(d: &mut Driver, run: usize) -> RunRecord {
    d.reset_thread("project");
    let t = d.turn(&plain("project", SHORT_Q), |_, _, _| Act::None);
    let ok = t.end == End::Done && t.backend.as_deref() == Some("local");
    rec("S1", run, ok, format!("{:?}", t.end), vec![t])
}

fn s2(d: &mut Driver, run: usize) -> RunRecord {
    d.reset_thread("project");
    let title = format!("Harness probe {run}-{}", std::process::id());
    let text = format!("Create a card titled \"{title}\" with a one-line body about the music of a fishing boss fight.");
    let t = d.turn(&plain("project", &text), |_, _, _| Act::None);
    let made = d.card_titles().iter().any(|(t, ghost)| t == &title && *ghost);
    let ok = t.end == End::Done && made;
    rec("S2", run, ok, format!("{:?} card_created={made}", t.end), vec![t])
}

fn organize_opts(folder: Option<String>) -> TurnOpts {
    TurnOpts {
        thread: "project".into(),
        text: "/organize (scope: the whole project): organize it into a clear structure. Call list_tree with scope \"folder\", then propose_organize once with the whole plan.".into(),
        folder,
        organize: Some(("folder".into(), None)),
        ..Default::default()
    }
}

fn s3(d: &mut Driver, run: usize, slug: &str) -> RunRecord {
    let prev = std::mem::replace(&mut d.slug, slug.to_string());
    d.reset_thread("project");
    let t = d.turn(&organize_opts(None), |_, _, _| Act::None);
    let check = t.plan.as_ref().map(|p| check_plan(&d.state(), &d.slug, None, p));
    d.slug = prev;
    let ok = t.end == End::Done && check.as_ref().is_some_and(|c| c.ok);
    let note = format!("{:?} {}", t.end, check.as_ref().map(|c| c.problems.join("; ")).unwrap_or_else(|| "no plan".into()));
    let mut r = rec("S3", run, ok, note, vec![t]);
    r.plan_check = check;
    r
}

fn s4(d: &mut Driver, run: usize) -> RunRecord {
    d.reset_thread("project");
    unload_models();
    let t = d.turn(&plain("project", SHORT_Q), |_, _, _| Act::None);
    let ok = t.end == End::Done;
    rec("S4", run, ok, format!("{:?} (model unloaded first)", t.end), vec![t])
}

fn s5(d: &mut Driver, run: usize) -> RunRecord {
    d.reset_thread("project");
    let ask = "List five short ideas for side activities in this game, one line each.";
    let first = d.turn(&plain("project", ask), |ms, v, _| {
        // Stop as soon as text streams, or after 20 s of anything else.
        if v.get("type").and_then(Value::as_str) == Some("delta") || ms > 20_000 { Act::Interrupt } else { Act::None }
    });
    // Retry: the chat drops the stopped reply and sends the same turn again.
    let second = d.turn(&plain("project", ask), |_, _, _| Act::None);
    let ok = second.end == End::Done && second.foreign_events == 0;
    let note = format!("first={:?} retry={:?} foreign_events={}", first.end, second.end, second.foreign_events);
    rec("S5", run, ok, note, vec![first, second])
}

fn s6(d: &mut Driver, run: usize) -> RunRecord {
    d.reset_thread("project");
    // A low compaction budget so a short thread crosses it (the real one is 50k tokens).
    let _ = d.state().ws.lock().unwrap().update_settings(SettingsPatch { compact_tokens: Some(9_000), ..Default::default() });
    let asks = [
        "Summarize the core loop of this game in three sentences.",
        "What are the two biggest open design questions? One sentence each.",
        "Suggest one concrete way to make the early game more tense. Two sentences.",
        "Which card should I work on next, and why? Two sentences.",
        "Restate the single most important decision so far in one sentence.",
    ];
    let mut turns = Vec::new();
    for a in asks {
        let t = d.turn(&plain("project", a), |_, _, _| Act::None);
        let stop = t.end != End::Done;
        turns.push(t);
        if stop {
            break;
        }
    }
    let _ = d.state().ws.lock().unwrap().update_settings(SettingsPatch { compact_tokens: Some(50_000), ..Default::default() });
    let compacted = turns.iter().any(|t| t.compacted);
    let ok = turns.len() == asks.len() && turns.iter().all(|t| t.end == End::Done) && compacted;
    let note = format!("{} turns, compacted={compacted}, ends={:?}", turns.len(), turns.iter().map(|t| format!("{:?}", t.end)).collect::<Vec<_>>());
    rec("S6", run, ok, note, turns)
}

/// S7: Claude smoke tests (real Claude, small model, short prompts).
fn s7(d: &mut Driver, run: usize, part: &str) -> RunRecord {
    d.reset_thread("project");
    match part {
        "chat" => {
            let _ = d.state().ws.lock().unwrap().update_settings(SettingsPatch { local_chat: Some(false), ..Default::default() });
            let t = d.turn(&plain("project", "Reply with exactly: OK."), |_, _, _| Act::None);
            let _ = d.state().ws.lock().unwrap().update_settings(SettingsPatch { local_chat: Some(true), ..Default::default() });
            let ok = t.end == End::Done && t.backend.as_deref() == Some("claude");
            rec("S7-chat", run, ok, format!("{:?}", t.end), vec![t])
        }
        "think" => {
            let a = d.turn(&plain("project", "Name one fish from this project's cards, in a few words."), |_, _, _| Act::None);
            let mut o = plain("project", "Think harder: in one sentence, what is the riskiest assumption in this design?");
            o.think = true;
            let b = d.turn(&o, |_, _, _| Act::None);
            let ok = b.end == End::Done && b.backend.as_deref() == Some("claude");
            rec("S7-think", run, ok, format!("local={:?} think={:?}", a.end, b.end), vec![a, b])
        }
        _ => {
            // A forced local failure (the local model's server answers 500), then the user's click.
            let fake = fake_server(FakeMode::Error500);
            sidecar::shutdown(&d.state());
            set_env("DREAMER_FAKE_LOCAL_URL", Some(&fake.url));
            let a = d.turn(&plain("project", SHORT_Q), |_, _, _| Act::None);
            sidecar::shutdown(&d.state());
            set_env("DREAMER_FAKE_LOCAL_URL", None);
            let mut o = plain("project", SHORT_Q);
            o.retry_with_claude = true;
            let b = d.turn(&o, |_, _, _| Act::None);
            let failed_clearly = matches!(a.end, End::Error | End::Empty | End::Stalled) && a.fallback.is_some();
            let ok = failed_clearly && b.end == End::Done && b.backend.as_deref() == Some("claude");
            rec("S7-retry", run, ok, format!("local={:?} fallback={:?} claude={:?}", a.end, a.fallback, b.end), vec![a, b])
        }
    }
}

/// S8: fault injection. Each one must end in a clear state (any end but Spinner) within the cap.
fn s8(d: &mut Driver, run: usize, fault: &str) -> RunRecord {
    d.reset_thread("project");
    let name = format!("S8-{fault}");
    let clear = |t: &TurnResult| t.end != End::Spinner;
    match fault {
        "kill-ollama" => {
            let t = d.turn(&plain("project", "List three ideas for boss arenas, one line each."), |_, v, _| {
                if v.get("type").and_then(Value::as_str) != Some("route") {
                    kill_ollama();
                }
                Act::None
            });
            restart_ollama();
            let ok = clear(&t);
            rec(&name, run, ok, format!("{:?} err={:?}", t.end, t.error), vec![t])
        }
        "tool-delay" => {
            set_env("DREAMER_FAULT_TOOL_DELAY", Some("create_card:20000"));
            let title = format!("Delayed probe {run}");
            let t = d.turn(&plain("project", &format!("Create a card titled \"{title}\" with a one-line body.")), |_, _, _| Act::None);
            set_env("DREAMER_FAULT_TOOL_DELAY", None);
            let ok = clear(&t);
            rec(&name, run, ok, format!("{:?} tools={:?}", t.end, t.tools), vec![t])
        }
        "kill-claude-code" => {
            let mut killed = 0;
            let t = d.turn(&plain("project", SHORT_Q), |ms, v, d| {
                if killed == 0 && (v.get("type").and_then(Value::as_str) != Some("route") || ms > 3000) {
                    std::thread::sleep(Duration::from_millis(500));
                    killed = kill_claude_children(&d.state());
                }
                Act::None
            });
            let ok = clear(&t);
            rec(&name, run, ok, format!("{:?} killed={killed} err={:?}", t.end, t.error), vec![t])
        }
        "silent-local" | "stall-local" | "silent-claude" | "error-claude" => {
            let mode = match fault {
                "silent-local" | "silent-claude" => FakeMode::Silent,
                "stall-local" => FakeMode::StallMid,
                _ => FakeMode::Error500,
            };
            let fake = fake_server(mode);
            let var = if fault.ends_with("claude") { "DREAMER_FAKE_CLAUDE_URL" } else { "DREAMER_FAKE_LOCAL_URL" };
            sidecar::shutdown(&d.state());
            set_env(var, Some(&fake.url));
            let mut o = plain("project", SHORT_Q);
            if fault.ends_with("claude") {
                o.retry_with_claude = true;
            }
            let t = d.turn(&o, |_, _, _| Act::None);
            sidecar::shutdown(&d.state());
            set_env(var, None);
            let ok = clear(&t);
            let reqs = *fake.requests.lock().unwrap();
            rec(&name, run, ok, format!("{:?} reason={:?} fake_requests={reqs}", t.end, t.end_reason), vec![t])
        }
        other => rec(&name, run, false, format!("unknown fault {other}"), vec![]),
    }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

fn pct(mut v: Vec<u64>, p: f64) -> Option<u64> {
    if v.is_empty() {
        return None;
    }
    v.sort();
    let i = ((v.len() as f64 - 1.0) * p).round() as usize;
    Some(v[i])
}

fn fmt_s(v: Option<u64>) -> String {
    v.map(|ms| format!("{:.1}s", ms as f64 / 1000.0)).unwrap_or_else(|| "-".into())
}

pub fn summary(records: &[RunRecord], label: &str) -> String {
    let mut by: BTreeMap<String, Vec<&RunRecord>> = BTreeMap::new();
    for r in records {
        by.entry(r.scenario.clone()).or_default().push(r);
    }
    let mut out = format!("### {label}\n\n| Scenario | Success | TTFE median | TTFE p95 | Turn median | Turn p95 | End reasons (all turns) | Spinners |\n|---|---|---|---|---|---|---|---|\n");
    for (s, rs) in &by {
        let ok = rs.iter().filter(|r| r.ok).count();
        let turns: Vec<&TurnResult> = rs.iter().flat_map(|r| r.turns.iter()).collect();
        let ttfe: Vec<u64> = turns.iter().filter_map(|t| t.ttfe_ms).collect();
        let total: Vec<u64> = turns.iter().map(|t| t.total_ms).collect();
        let mut ends: BTreeMap<String, usize> = BTreeMap::new();
        for t in &turns {
            let mut k = format!("{:?}", t.end).to_lowercase();
            if let Some(f) = &t.fallback {
                k.push_str(&format!("/{f}"));
            }
            if t.retried_local {
                k.push_str("+retry");
            }
            *ends.entry(k).or_default() += 1;
        }
        let spinners = turns.iter().filter(|t| t.end == End::Spinner).count();
        let ends = ends.iter().map(|(k, n)| format!("{k} {n}")).collect::<Vec<_>>().join(", ");
        out.push_str(&format!("| {s} | {ok}/{} | {} | {} | {} | {} | {ends} | {spinners} |\n", rs.len(), fmt_s(pct(ttfe.clone(), 0.5)), fmt_s(pct(ttfe, 0.95)), fmt_s(pct(total.clone(), 0.5)), fmt_s(pct(total, 0.95))));
    }
    let claude: usize = records.iter().map(|r| r.claude_turns).sum();
    out.push_str(&format!("\nReal Claude turns used: {claude}\n"));
    out
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

struct Args {
    scenarios: Vec<String>,
    runs: usize,
    out: PathBuf,
    source: PathBuf,
    project: String,
    cap: Duration,
    label: String,
}

fn parse_args() -> Args {
    let mut a = Args {
        scenarios: "S1,S2,S3,S4,S5,S6".split(',').map(str::to_string).collect(),
        runs: 10,
        out: std::env::temp_dir().join(format!("dreamer-reliability-{}", chrono::Utc::now().format("%Y%m%d-%H%M%S"))),
        source: crate::state::default_root(),
        project: "colonizeearth".into(),
        cap: Duration::from_secs(600),
        label: "run".into(),
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let v = args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() {
            "--scenarios" => a.scenarios = v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
            "--runs" => a.runs = v.parse().unwrap_or(10),
            "--out" => a.out = PathBuf::from(v),
            "--source" => a.source = PathBuf::from(v),
            "--project" => a.project = v,
            "--cap" => a.cap = Duration::from_secs(v.parse().unwrap_or(600)),
            "--label" => a.label = v,
            _ => {
                i += 1;
                continue;
            }
        }
        i += 2;
    }
    a
}

/// Runs of each scenario: local ones as asked; Claude ones (S7) twice; faults (S8) a few times.
fn runs_of(s: &str, runs: usize) -> usize {
    if s.starts_with("S7") {
        runs.min(2)
    } else if s.starts_with("S8") {
        runs.min(3)
    } else {
        runs
    }
}

pub fn main() {
    let a = parse_args();
    std::fs::create_dir_all(&a.out).expect("create the output folder");
    set_env("DREAMER_LOG_DIR", Some(&a.out.join("logs").display().to_string()));
    let root = a.out.join("workspace");
    // Copy the workspace (settings + the one project), never touching the original.
    let src_root = a.source.canonicalize().unwrap_or(a.source.clone());
    assert!(root.canonicalize().map_or(true, |r| r != src_root), "refusing to run on the original workspace");
    let src = a.source.join("projects").join(&a.project);
    let dst = root.join("projects").join(&a.project);
    copy_dir(&src, &dst, &["chats"]).expect("copy the project");
    std::fs::copy(a.source.join("workspace.json"), root.join("workspace.json")).expect("copy workspace.json");
    let flat = format!("{}-flat", a.project);
    copy_dir(&src, &root.join("projects").join(&flat), &["chats"]).expect("copy the project for S3");
    let n_flat = build_flat_fixture(&root.join("projects").join(&flat)).expect("S3 fixture");
    let state = AppState::headless(root.clone()).expect("open the workspace copy");
    {
        let ws = state.ws.lock().unwrap();
        // Claude usage stays small: Haiku for chat, Sonnet for Think; no memory passes (turns send memory=false).
        let _ = ws.update_settings(SettingsPatch { model_chat: Some("haiku".into()), model_fast: Some("haiku".into()), model_deep: Some("sonnet".into()), model_memory: Some("haiku".into()), local_chat: Some(true), compact_tokens: Some(50_000), ..Default::default() });
    }
    let app = tauri::Builder::default().build(crate::context()).expect("build the headless app");
    app.manage(state);
    let handle = app.handle().clone();
    let (tx, rx) = channel::<(Instant, Value)>();
    let tx = Mutex::new(tx);
    handle.listen_any("claude-event", move |e| {
        if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
            let _ = tx.lock().unwrap().send((Instant::now(), v));
        }
    });
    let mut d = Driver { app: handle.clone(), slug: a.project.clone(), rx, threads: HashMap::new(), seq: 0, ended: BTreeSet::new(), cap: a.cap };
    let settings = d.state().ws.lock().unwrap().get_settings().unwrap_or_default();
    let local = d.state().ollama.check_again(&crate::ollama::LocalCfg::from_settings(&settings));
    let header = json!({
        "label": a.label, "out": a.out, "project": a.project, "flatCards": n_flat,
        "localModel": settings.local_model, "variant": local.variant, "localReady": local.ready, "localError": local.error,
        "ollamaPs": ollama_ps(), "numCtx": crate::ollama::NUM_CTX,
    });
    println!("[harness] {header}");
    std::fs::write(a.out.join("setup.json"), serde_json::to_string_pretty(&header).unwrap()).ok();
    let results = a.out.join("results.jsonl");
    let mut records: Vec<RunRecord> = Vec::new();
    for s in &a.scenarios {
        for run in 1..=runs_of(s, a.runs) {
            let t0 = Instant::now();
            let r = match s.as_str() {
                "S1" => s1(&mut d, run),
                "S2" => s2(&mut d, run),
                "S3" => s3(&mut d, run, &flat),
                "S4" => s4(&mut d, run),
                "S5" => s5(&mut d, run),
                "S6" => s6(&mut d, run),
                "S7-chat" => s7(&mut d, run, "chat"),
                "S7-think" => s7(&mut d, run, "think"),
                "S7-retry" => s7(&mut d, run, "retry"),
                x if x.starts_with("S8-") => s8(&mut d, run, &x[3..]),
                other => rec(other, run, false, "unknown scenario", vec![]),
            };
            println!("[harness] {} #{run}: {} ({:.0}s) {}", r.scenario, if r.ok { "PASS" } else { "FAIL" }, t0.elapsed().as_secs_f64(), r.note);
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&results) {
                let _ = writeln!(f, "{}", serde_json::to_string(&r).unwrap_or_default());
            }
            records.push(r);
        }
    }
    let table = summary(&records, &a.label);
    println!("\n{table}");
    std::fs::write(a.out.join("summary.md"), &table).ok();
    sidecar::shutdown(&d.state());
    drop(app);
}
