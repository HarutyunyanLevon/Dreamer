//! The local chat model: talks to the Ollama server on this machine (`http://localhost:11434`).
//!
//! Chat turns themselves don't come through here: the sidecar runs Claude Code against Ollama's
//! Anthropic-compatible `/v1/messages` (per-session `ANTHROPIC_BASE_URL`). This module only
//! answers "is Ollama usable?" (server reachable, version >= 0.14, model pulled, tools capability),
//! pulls the model for the setup screen, and makes the 64k-context variant Dreamer actually runs.
//!
//! HTTP is a tiny HTTP/1.0 client over a `TcpStream` to localhost. HTTP/1.0 means Ollama's Go
//! server never uses chunked encoding: a streamed body (pull progress) is plain NDJSON until the
//! connection closes. It needs no async runtime, so it can run from the sync command threads, and
//! the tests can stand in for Ollama with a `TcpListener`.

use crate::error::{AppError, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const BASE_URL: &str = "http://localhost:11434";
const ADDR: &str = "127.0.0.1:11434";
/// First Ollama release with the Anthropic Messages API (tools and streaming included).
pub const MIN_VERSION: (u32, u32, u32) = (0, 14, 0);
/// Context window of the variant Dreamer creates (threads compact at 64k, see ctx::local_compact_tokens).
pub const NUM_CTX: u64 = 65_536;
pub const INSTALLER_URL: &str = "https://ollama.com/download/windows";

// ---------- minimal HTTP ----------

struct Resp {
    status: u16,
    body: BufReader<TcpStream>,
}

fn connect(addr: &str, timeout: Duration) -> std::io::Result<TcpStream> {
    let sa: SocketAddr = addr.parse().map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad address"))?;
    let s = TcpStream::connect_timeout(&sa, timeout)?;
    s.set_nodelay(true).ok();
    Ok(s)
}

/// Sends one request and reads the status line and headers. `read_timeout` bounds every read
/// (None for a long streamed body such as a pull).
fn request(addr: &str, method: &str, path: &str, body: Option<&Value>, read_timeout: Option<Duration>) -> std::io::Result<Resp> {
    let mut s = connect(addr, Duration::from_millis(800))?;
    s.set_read_timeout(read_timeout)?;
    s.set_write_timeout(Some(Duration::from_secs(5)))?;
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let mut head = format!("{method} {path} HTTP/1.0\r\nHost: localhost\r\nAccept: application/json\r\nConnection: close\r\n");
    if body.is_some() {
        head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", payload.len()));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes())?;
    s.write_all(payload.as_bytes())?;
    s.flush()?;
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line)?;
    let status = line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "not an HTTP response"))?;
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
    }
    Ok(Resp { status, body: r })
}

fn json_call(addr: &str, method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> std::io::Result<(u16, Value)> {
    let mut r = request(addr, method, path, body, Some(timeout))?;
    let mut text = String::new();
    r.body.read_to_string(&mut text)?;
    Ok((r.status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

// ---------- pure helpers ----------

/// "0.14.2" / "0.14.0-rc1" -> (0, 14, 2) / (0, 14, 0).
pub fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let core = v.trim().trim_start_matches('v').split(['-', '+', ' ']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u32>());
    let major = it.next()?.ok()?;
    let minor = it.next().unwrap_or(Ok(0)).ok()?;
    let patch = it.next().unwrap_or(Ok(0)).ok()?;
    Some((major, minor, patch))
}

pub fn version_ok(v: &str) -> bool {
    parse_version(v).is_some_and(|p| p >= MIN_VERSION)
}

/// Adds Ollama's implicit `:latest` so names compare equal to what /api/tags lists.
pub fn full_name(model: &str) -> String {
    let m = model.trim();
    let last = m.rsplit('/').next().unwrap_or(m);
    if last.contains(':') { m.to_string() } else { format!("{m}:latest") }
}

/// The 64k-context copy Dreamer runs: `qwen3.5:35b-a3b` -> `dreamer-qwen3.5:35b-a3b`.
/// A namespaced name (`hf.co/x/y:tag`) is flattened so the prefix stays one name.
pub fn variant_name(base: &str) -> String {
    let full = full_name(base);
    let (name, tag) = full.rsplit_once(':').unwrap_or((&full, "latest"));
    format!("dreamer-{}:{tag}", name.replace('/', "-"))
}

/// Whether a model name is one Dreamer can hand to Ollama (letters, digits, `.-_:/`).
pub fn valid_model_name(m: &str) -> bool {
    let m = m.trim();
    !m.is_empty() && m.len() <= 200 && m.chars().all(|c| c.is_ascii_alphanumeric() || "._-:/".contains(c)) && !m.starts_with(['-', '.', '/'])
}

// ---------- status ----------

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    /// Server answered /api/version.
    pub running: bool,
    pub version: Option<String>,
    /// Version is at least MIN_VERSION.
    pub version_ok: bool,
    /// ollama.exe exists in a known install folder (server may still be stopped).
    pub installed: bool,
    /// The model from settings.
    pub model: String,
    /// The base model is pulled.
    pub pulled: bool,
    /// Its capabilities include "tools" (None: not pulled, unknown).
    pub tools: Option<bool>,
    pub vision: Option<bool>,
    /// The 64k variant exists (created on demand when missing).
    pub variant: Option<String>,
    /// Everything needed for a local turn.
    pub ready: bool,
    pub pulling: bool,
    pub error: Option<String>,
}

fn installed_on_disk() -> bool {
    let mut c: Vec<std::path::PathBuf> = Vec::new();
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        c.push(std::path::PathBuf::from(l).join("Programs").join("Ollama").join("ollama.exe"));
    }
    if let Some(p) = std::env::var_os("ProgramFiles") {
        c.push(std::path::PathBuf::from(p).join("Ollama").join("ollama.exe"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            c.push(d.join(if cfg!(windows) { "ollama.exe" } else { "ollama" }));
        }
    }
    c.iter().any(|p| p.is_file())
}

/// Capabilities of an installed model, or None when it isn't pulled.
fn capabilities(addr: &str, model: &str) -> std::io::Result<Option<Vec<String>>> {
    let (code, v) = json_call(addr, "POST", "/api/show", Some(&json!({ "model": model })), Duration::from_secs(5))?;
    if code == 404 {
        return Ok(None);
    }
    if code >= 400 {
        return Err(std::io::Error::other(v.get("error").and_then(Value::as_str).unwrap_or("show failed").to_string()));
    }
    Ok(Some(v.get("capabilities").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()))
}

/// Creates the num_ctx variant from a pulled base (metadata only, quick).
fn create_variant(addr: &str, base: &str) -> std::io::Result<String> {
    let name = variant_name(base);
    let body = json!({ "model": name, "from": full_name(base), "parameters": { "num_ctx": NUM_CTX }, "stream": false });
    let (code, v) = json_call(addr, "POST", "/api/create", Some(&body), Duration::from_secs(60))?;
    if code >= 400 {
        return Err(std::io::Error::other(v.get("error").and_then(Value::as_str).unwrap_or("create failed").to_string()));
    }
    Ok(name)
}

/// Full check against a server at `addr`. Creates the 64k variant when the base is there and it isn't.
fn check_at(addr: &str, model: &str) -> LocalStatus {
    let mut st = LocalStatus { model: model.to_string(), ..Default::default() };
    match json_call(addr, "GET", "/api/version", None, Duration::from_secs(2)) {
        Ok((200, v)) => {
            st.running = true;
            st.installed = true;
            st.version = v.get("version").and_then(Value::as_str).map(str::to_string);
            st.version_ok = st.version.as_deref().is_some_and(version_ok);
        }
        _ => {
            st.installed = installed_on_disk();
            st.error = Some(if st.installed { "Ollama is installed but not running. Start Ollama from the Start menu.".into() } else { "Ollama isn't installed.".into() });
            return st;
        }
    }
    if !st.version_ok {
        st.error = Some(format!("Ollama {} is too old; Dreamer needs {}.{} or newer. Update Ollama.", st.version.as_deref().unwrap_or("?"), MIN_VERSION.0, MIN_VERSION.1));
        return st;
    }
    match capabilities(addr, &full_name(model)) {
        Ok(Some(caps)) => {
            st.pulled = true;
            st.tools = Some(caps.iter().any(|c| c == "tools"));
            st.vision = Some(caps.iter().any(|c| c == "vision"));
        }
        Ok(None) => {
            st.error = Some(format!("The model {model} isn't downloaded yet."));
            return st;
        }
        Err(e) => {
            st.error = Some(format!("Couldn't read the model's details: {e}"));
            return st;
        }
    }
    if st.tools != Some(true) {
        st.error = Some(format!("{model} doesn't support tool calls, which Dreamer's chat needs. Pick another model."));
        return st;
    }
    let variant = variant_name(model);
    let have = matches!(capabilities(addr, &variant), Ok(Some(_)));
    match if have { Ok(variant) } else { create_variant(addr, model) } {
        Ok(v) => st.variant = Some(v),
        Err(e) => {
            st.error = Some(format!("Couldn't set up the 64k-context copy of {model}: {e}"));
            return st;
        }
    }
    st.ready = true;
    st
}

// ---------- state (cache + pull job) ----------

#[derive(Default)]
pub struct OllamaState {
    /// Last full check per model, with when it ran (send_message reuses it for a while).
    cache: Mutex<HashMap<String, (Instant, LocalStatus)>>,
    pull: Mutex<Option<Arc<AtomicBool>>>,
}

/// A full status is reused this long by chat turns; a cheap version ping still runs every turn.
const CACHE_FOR: Duration = Duration::from_secs(60);

impl OllamaState {
    pub fn pulling(&self) -> bool {
        self.pull.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn status(&self, model: &str) -> LocalStatus {
        let mut st = check_at(ADDR, model);
        st.pulling = self.pulling();
        if let Ok(mut c) = self.cache.lock() {
            c.insert(model.to_string(), (Instant::now(), st.clone()));
        }
        st
    }

    /// For a chat turn: the cached status if recent and the server still answers; else a fresh check.
    pub fn for_turn(&self, model: &str) -> LocalStatus {
        let cached = self.cache.lock().ok().and_then(|c| c.get(model).cloned());
        if let Some((at, st)) = cached {
            if st.ready && at.elapsed() < CACHE_FOR {
                let alive = matches!(json_call(ADDR, "GET", "/api/version", None, Duration::from_millis(700)), Ok((200, _)));
                if alive {
                    return st;
                }
            }
        }
        self.status(model)
    }

    pub fn cancel_pull(&self) {
        if let Ok(g) = self.pull.lock() {
            if let Some(c) = g.as_ref() {
                c.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// One pull progress line -> (status text, completed, total).
pub fn parse_pull_line(line: &str) -> Option<(String, u64, u64)> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if let Some(e) = v.get("error").and_then(Value::as_str) {
        return Some((format!("error: {e}"), 0, 0));
    }
    let status = v.get("status").and_then(Value::as_str)?.to_string();
    let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    Some((status, n("completed"), n("total")))
}

/// Pulls `model` in the background, streaming `ollama-setup` events:
/// `{type:"progress", status, completed, total}` then `{type:"done", ok, cancelled, message}`.
/// On success the 64k variant is created too.
pub fn start_pull(app: &AppHandle, state: &OllamaState, model: &str) -> Result<()> {
    if !valid_model_name(model) {
        return Err(AppError::Invalid(format!("\"{model}\" isn't a valid Ollama model name")));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut g = state.pull.lock().map_err(|_| AppError::Invalid("ollama lock poisoned".into()))?;
        if g.is_some() {
            return Err(AppError::Invalid("A model download is already running.".into()));
        }
        *g = Some(cancel.clone());
    }
    let (app, model) = (app.clone(), model.to_string());
    std::thread::spawn(move || {
        let emit = |v: Value| {
            let _ = app.emit("ollama-setup", v);
        };
        let result = (|| -> std::result::Result<(), String> {
            let r = request(ADDR, "POST", "/api/pull", Some(&json!({ "model": full_name(&model), "stream": true })), Some(Duration::from_secs(120)))
                .map_err(|e| format!("Couldn't reach Ollama: {e}"))?;
            if r.status >= 400 {
                let mut t = String::new();
                let mut b = r.body;
                let _ = b.read_to_string(&mut t);
                let msg = serde_json::from_str::<Value>(&t).ok().and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string)).unwrap_or(t);
                return Err(format!("Ollama refused the download: {msg}"));
            }
            let mut last_emit = Instant::now() - Duration::from_secs(1);
            for line in r.body.lines() {
                if cancel.load(Ordering::SeqCst) {
                    return Err("cancelled".into());
                }
                let line = line.map_err(|e| format!("The download stopped: {e}"))?;
                let Some((status, completed, total)) = parse_pull_line(&line) else { continue };
                if let Some(e) = status.strip_prefix("error: ") {
                    return Err(format!("Ollama: {e}"));
                }
                // Progress lines arrive many times a second; the UI needs ~5.
                if last_emit.elapsed() >= Duration::from_millis(200) || total == 0 {
                    last_emit = Instant::now();
                    emit(json!({ "type": "progress", "status": status, "completed": completed, "total": total }));
                }
            }
            emit(json!({ "type": "progress", "status": "setting up the 64k context", "completed": 0, "total": 0 }));
            create_variant(ADDR, &model).map_err(|e| format!("Downloaded, but couldn't set up the 64k-context copy: {e}"))?;
            Ok(())
        })();
        let cancelled = cancel.load(Ordering::SeqCst);
        if let Ok(mut g) = app_state(&app).pull.lock() {
            *g = None;
        }
        if let Ok(mut c) = app_state(&app).cache.lock() {
            c.clear();
        }
        match result {
            Ok(()) => emit(json!({ "type": "done", "ok": true, "cancelled": false, "message": "" })),
            Err(e) => emit(json!({ "type": "done", "ok": false, "cancelled": cancelled, "message": if cancelled { "Download cancelled.".to_string() } else { e } })),
        }
    });
    Ok(())
}

fn app_state(app: &AppHandle) -> &OllamaState {
    use tauri::Manager;
    &app.state::<crate::state::AppState>().inner().ollama
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A fake Ollama: answers each connection by path from `routes` (status, body), in order of arrival.
    fn fake(routes: Vec<(&'static str, u16, String)>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap().to_string();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten() {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut first = String::new();
                r.read_line(&mut first).unwrap();
                let mut len = 0usize;
                let mut h = String::new();
                loop {
                    h.clear();
                    r.read_line(&mut h).unwrap();
                    if h == "\r\n" {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; len];
                r.read_exact(&mut body).unwrap();
                let path = first.split_whitespace().nth(1).unwrap_or("").to_string();
                let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let key = format!("{path} {}", req.get("model").and_then(Value::as_str).unwrap_or(""));
                let (code, resp) = routes.iter().find(|(k, _, _)| key.trim() == *k || path == *k).map(|(_, c, b)| (*c, b.clone())).unwrap_or((404, r#"{"error":"not found"}"#.into()));
                let _ = write!(s, "HTTP/1.0 {code} X\r\nContent-Type: application/json\r\n\r\n{resp}");
            }
        });
        addr
    }

    #[test]
    fn versions_and_names() {
        assert_eq!(parse_version("0.14.2"), Some((0, 14, 2)));
        assert_eq!(parse_version("0.14.0-rc1"), Some((0, 14, 0)));
        assert!(version_ok("0.14.0") && version_ok("1.0") && !version_ok("0.13.9") && !version_ok("garbage"));
        assert_eq!(full_name("qwen3.5"), "qwen3.5:latest");
        assert_eq!(variant_name("qwen3.5:35b-a3b"), "dreamer-qwen3.5:35b-a3b");
        assert_eq!(variant_name("hf.co/a/b"), "dreamer-hf.co-a-b:latest");
        assert!(valid_model_name("qwen3.5:35b-a3b") && !valid_model_name("a b") && !valid_model_name("") && !valid_model_name("-x"));
        assert_eq!(parse_pull_line(r#"{"status":"pulling abc","completed":5,"total":10}"#), Some(("pulling abc".into(), 5, 10)));
        assert_eq!(parse_pull_line(r#"{"error":"no space"}"#).unwrap().0, "error: no space");
    }

    #[test]
    fn missing_server_is_not_ready() {
        // Nothing listens on this port (bound then dropped).
        let addr = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().to_string();
        let st = check_at(&addr, "qwen3.5:35b-a3b");
        assert!(!st.running && !st.ready && st.error.is_some());
    }

    #[test]
    fn old_server_missing_model_and_ready_states() {
        let old = fake(vec![("/api/version", 200, r#"{"version":"0.13.5"}"#.into())]);
        let st = check_at(&old, "m:1");
        assert!(st.running && !st.version_ok && !st.ready && st.error.unwrap().contains("too old"));

        let missing = fake(vec![("/api/version", 200, r#"{"version":"0.14.1"}"#.into())]);
        let st = check_at(&missing, "m:1");
        assert!(st.version_ok && !st.pulled && !st.ready && st.error.unwrap().contains("isn't downloaded"));

        let no_tools = fake(vec![("/api/version", 200, r#"{"version":"0.14.1"}"#.into()), ("/api/show m:1", 200, r#"{"capabilities":["completion"]}"#.into())]);
        let st = check_at(&no_tools, "m:1");
        assert!(st.pulled && st.tools == Some(false) && !st.ready);

        // Variant missing: Dreamer creates it.
        let ready = fake(vec![
            ("/api/version", 200, r#"{"version":"0.15.0"}"#.into()),
            ("/api/show m:1", 200, r#"{"capabilities":["completion","tools","vision"]}"#.into()),
            ("/api/create", 200, r#"{"status":"success"}"#.into()),
        ]);
        let st = check_at(&ready, "m:1");
        assert!(st.ready, "{:?}", st.error);
        assert_eq!((st.tools, st.vision, st.variant.as_deref()), (Some(true), Some(true), Some("dreamer-m:1")));
    }
}
