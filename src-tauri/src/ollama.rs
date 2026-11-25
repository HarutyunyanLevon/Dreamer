//! The local chat model: talks to the Ollama server on this machine (`OLLAMA_HOST`, default
//! `127.0.0.1:11434`).
//!
//! Chat turns themselves don't come through here: the sidecar runs Claude Code against Ollama's
//! Anthropic-compatible `/v1/messages` (per-session `ANTHROPIC_BASE_URL`, see [`base_url`]). This
//! module answers "is Ollama usable?" (server reachable, version >= 0.14, model pulled, tools
//! capability), finds and starts an installed Ollama, picks a model for the GPU, pulls it for the
//! setup screen, and makes the 64k-context variant Dreamer actually runs. Installing Ollama itself
//! is in `ollama_install.rs`.
//!
//! HTTP is a tiny HTTP/1.0 client over a `TcpStream`. HTTP/1.0 means Ollama's Go server never uses
//! chunked encoding: a streamed body (pull progress) is plain NDJSON until the connection closes.
//! It needs no async runtime, so it can run from the sync command threads, and the tests can stand
//! in for Ollama with a `TcpListener`.

use crate::error::{AppError, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// First Ollama release with the Anthropic Messages API (tools and streaming included).
pub const MIN_VERSION: (u32, u32, u32) = (0, 14, 0);
/// Context window of the variant Dreamer creates (threads compact at 40k, see ctx::local_compact_tokens).
pub const NUM_CTX: u64 = 65_536;
/// Ollama's download page, for the manual route ("Get Ollama for Windows").
pub const DOWNLOAD_PAGE: &str = "https://ollama.com/download/windows";
pub const DEFAULT_PORT: u16 = 11434;
/// Inno Setup AppId of Ollama's installer (app/ollama.iss), as its uninstall key is named.
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{44E83376-CE68-45EB-8FC1-393500EB558C}_is1";

// ---------- which model for which GPU ----------

/// One row of the model table: what the setup screen recommends for a GPU with at least
/// `min_vram_gb` of dedicated memory. Checked against the Ollama library on 2026-11-19: every
/// local entry lists the `tools` capability (Qwen 3.5 also `vision` and `thinking`).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub model: &'static str,
    pub label: &'static str,
    pub min_vram_gb: u32,
    /// Download size in bytes (0 for a cloud model: nothing is downloaded).
    pub size: u64,
    pub cloud: bool,
}

const GB: u64 = 1_000_000_000;

/// Biggest first. The first entry is `model::DEFAULT_LOCAL_MODEL`.
pub const MODEL_TIERS: &[ModelChoice] = &[
    // Qwen 3.5 MoE, 35B total / ~3B active, Q4_K_M. Needs ~24 GB to run fully on the GPU.
    ModelChoice { model: "qwen3.5:35b-a3b", label: "Qwen 3.5 35B-A3B (best)", min_vram_gb: 20, size: 22 * GB, cloud: false },
    // Dense 9B (qwen3.5:latest), fits 10-20 GB cards with the 64k context.
    ModelChoice { model: "qwen3.5:9b", label: "Qwen 3.5 9B", min_vram_gb: 10, size: 6_600_000_000, cloud: false },
    // Dense 4B for 6-10 GB cards.
    ModelChoice { model: "qwen3.5:4b", label: "Qwen 3.5 4B", min_vram_gb: 6, size: 3_300_000_000, cloud: false },
];

/// For a weak, missing or unknown GPU: runs on Ollama's servers (needs `ollama signin`; tools +
/// vision, "Low usage" tier in the library).
pub const CLOUD_CHOICE: ModelChoice = ModelChoice { model: "gemma4:cloud", label: "Gemma 4 (Ollama cloud)", min_vram_gb: 0, size: 0, cloud: true };

/// The model for `vram` bytes of dedicated GPU memory (None = no dedicated GPU or unknown).
/// Cards report a little under their nominal size (a "24 GB" card says 23.98 GiB), hence the 5% slack.
pub fn tier_for(vram: Option<u64>) -> ModelChoice {
    let Some(bytes) = vram else { return CLOUD_CHOICE };
    let gib = bytes as f64 / (1u64 << 30) as f64;
    MODEL_TIERS.iter().find(|t| gib >= t.min_vram_gb as f64 * 0.95).copied().unwrap_or(CLOUD_CHOICE)
}

/// Every choice the setup screen's picker offers.
pub fn choices() -> Vec<ModelChoice> {
    MODEL_TIERS.iter().copied().chain(std::iter::once(CLOUD_CHOICE)).collect()
}

// ---------- where the server is (OLLAMA_HOST) ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    /// `host:port` to connect to.
    pub addr: String,
    /// `http://host:port`, for the sidecar's ANTHROPIC_BASE_URL.
    pub base_url: String,
    /// Set when OLLAMA_HOST was there but unusable (the default is used instead).
    pub note: Option<String>,
}

impl Host {
    fn from_parts(host: &str, port: u16) -> Host {
        let addr = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
        Host { base_url: format!("http://{addr}"), addr, note: None }
    }
}

/// Parses OLLAMA_HOST the way Ollama does: `host`, `host:port`, `:port`, `[v6]:port`, with or
/// without `http://`; default host 127.0.0.1, default port 11434. A bind-all address (0.0.0.0, ::)
/// is reached through loopback. Anything else (https, other schemes, junk) falls back to the default
/// with a note the setup screen shows.
pub fn parse_host(raw: Option<&str>) -> Host {
    let default = Host::from_parts("127.0.0.1", DEFAULT_PORT);
    let Some(raw) = raw.map(str::trim).filter(|r| !r.is_empty()) else { return default };
    let bad = |why: &str| Host { note: Some(format!("OLLAMA_HOST is set to \"{raw}\", which Dreamer can't use ({why}), so it looks for Ollama at 127.0.0.1:{DEFAULT_PORT}.")), ..default.clone() };
    let lower = raw.to_ascii_lowercase();
    let rest = if lower.starts_with("http://") {
        &raw[7..]
    } else if lower.starts_with("https://") {
        return bad("Dreamer talks to a local Ollama over plain http");
    } else if raw.contains("://") {
        return bad("only http:// is supported");
    } else {
        raw
    };
    let rest = rest.split('/').next().unwrap_or("");
    let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
        let Some((h, after)) = v6.split_once(']') else { return bad("unclosed [") };
        match after {
            "" => (h, None),
            p if p.starts_with(':') => (h, Some(&p[1..])),
            _ => return bad("unexpected text after ]"),
        }
    } else if rest.matches(':').count() == 1 {
        let (h, p) = rest.split_once(':').unwrap();
        (h, Some(p))
    } else {
        (rest, None) // a bare host, or a bare IPv6 address
    };
    let port = match port {
        None | Some("") => DEFAULT_PORT,
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n > 0 => n,
            _ => return bad("the port isn't a number from 1 to 65535"),
        },
    };
    let host = match host {
        "" | "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        h => h,
    };
    if host.len() > 253 || !host.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c)) || host.starts_with(['-', '.']) {
        return bad("the host name isn't valid");
    }
    Host::from_parts(host, port)
}

/// The server address from this process's OLLAMA_HOST.
pub fn host() -> Host {
    parse_host(std::env::var("OLLAMA_HOST").ok().as_deref())
}

/// What the sidecar uses as ANTHROPIC_BASE_URL for local sessions.
pub fn base_url() -> String {
    host().base_url
}

// ---------- minimal HTTP ----------

struct Resp {
    status: u16,
    body: BufReader<TcpStream>,
}

fn connect(addr: &str, timeout: Duration) -> std::io::Result<TcpStream> {
    let sa = addr.to_socket_addrs()?.next().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad address"))?;
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
    let mut head = format!("{method} {path} HTTP/1.0\r\nHost: {addr}\r\nAccept: application/json\r\nConnection: close\r\n");
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

fn error_text(v: &Value, fallback: &str) -> String {
    v.get("error").and_then(Value::as_str).unwrap_or(fallback).to_string()
}

/// What answers at the address.
#[derive(Debug, PartialEq)]
enum Probe {
    /// Ollama, with its version.
    Up(String),
    /// Nothing listens.
    Down,
    /// Something listens, but it isn't Ollama (no `/api/version` JSON).
    Foreign,
    /// Ollama is there but didn't answer in time (busy loading a model).
    Busy,
}

/// A connect or read that ran out of time (not one that was refused or reset).
fn timed_out(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)
}

/// The one check behind the setup dialog, "Check again", and every chat turn.
fn probe(addr: &str, timeout: Duration) -> Probe {
    // Refused / unreachable = nothing listens. A connect that merely times out is a busy server:
    // Ollama stops accepting for a while when it loads a big model after sitting idle.
    // Windows reports a refused connection only after ~2 s, so a short timeout alone can't tell
    // stopped from busy: a timed-out connect is retried once with a longer limit.
    let first = connect(addr, timeout);
    let outcome = match first {
        Err(e) if timed_out(&e) => connect(addr, timeout.max(Duration::from_secs(3))),
        other => other,
    };
    match outcome {
        Ok(s) => drop(s), // close it before the real request
        Err(e) if timed_out(&e) => return Probe::Busy,
        Err(_) => return Probe::Down,
    }
    match json_call(addr, "GET", "/api/version", None, timeout) {
        Ok((200, v)) => match v.get("version").and_then(Value::as_str) {
            Some(ver) => Probe::Up(ver.to_string()),
            None => Probe::Foreign,
        },
        Err(e) if timed_out(&e) => Probe::Busy,
        _ => Probe::Foreign,
    }
}

fn server_up(addr: &str) -> bool {
    matches!(probe(addr, Duration::from_millis(800)), Probe::Up(_))
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

/// An Ollama cloud model (`gemma4:cloud`, `gemma4:31b-cloud`): runs on Ollama's servers through the
/// local Ollama, after `ollama signin`. Nothing to download, and no 64k copy (the server decides).
pub fn is_cloud(model: &str) -> bool {
    let full = full_name(model);
    let tag = full.rsplit_once(':').map(|(_, t)| t).unwrap_or("");
    tag.eq_ignore_ascii_case("cloud") || tag.to_ascii_lowercase().ends_with("-cloud")
}

/// The model name Dreamer runs: the 64k-context copy (`qwen3.5:35b-a3b` ->
/// `dreamer-qwen3.5:35b-a3b`), or a cloud model itself. A namespaced name (`hf.co/x/y:tag`) is
/// flattened so the prefix stays one name.
pub fn variant_name(base: &str) -> String {
    let full = full_name(base);
    if is_cloud(base) {
        return full;
    }
    let (name, tag) = full.rsplit_once(':').unwrap_or((&full, "latest"));
    format!("dreamer-{}:{tag}", name.replace('/', "-"))
}

/// Whether a model name is one Dreamer can hand to Ollama (letters, digits, `.-_:/`).
pub fn valid_model_name(m: &str) -> bool {
    let m = m.trim();
    !m.is_empty() && m.len() <= 200 && m.chars().all(|c| c.is_ascii_alphanumeric() || "._-:/".contains(c)) && !m.starts_with(['-', '.', '/'])
}

/// An error that means "sign in to Ollama first" (cloud models).
fn is_auth_error(code: u16, msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    code == 401 || code == 403 || m.contains("unauthorized") || m.contains("signin") || m.contains("sign in") || m.contains("not signed")
}

pub const SIGNIN_COMMAND: &str = "ollama signin";

// ---------- finding ollama.exe ----------

/// Where to look for Ollama on disk. `from_process` fills it from this machine; tests build it by hand.
#[derive(Default, Debug)]
pub struct ExeEnv {
    /// The folder (or file) picked with "Locate ollama.exe…" (setting `ollama_path`).
    pub custom: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub program_files: Option<PathBuf>,
    /// This process's PATH, then the current user and machine PATH from the registry (an install
    /// made after Dreamer started is only in the latter).
    pub path: Vec<PathBuf>,
    /// InstallLocation values from Ollama's uninstall key (HKCU, then HKLM).
    pub registry: Vec<PathBuf>,
    /// The scoop root (`SCOOP`, else `~\scoop`).
    pub scoop: Option<PathBuf>,
    /// winget package folders named `Ollama.Ollama_*`, plus winget's Links folder.
    pub winget: Vec<PathBuf>,
}

fn exe_name() -> &'static str {
    if cfg!(windows) { "ollama.exe" } else { "ollama" }
}

/// Every place ollama.exe may be, in the order they are tried: the picked folder first, then the
/// standard per-user and machine installs, PATH, the installer's registry entry, scoop and winget.
/// (`where ollama` runs after these, only when none exists.)
pub fn exe_candidates(env: &ExeEnv) -> Vec<PathBuf> {
    let exe = exe_name();
    let mut c: Vec<PathBuf> = Vec::new();
    if let Some(p) = &env.custom {
        let is_exe = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) || p.file_name().is_some_and(|n| n == "ollama");
        c.push(if is_exe { p.clone() } else { p.join(exe) });
    }
    if let Some(l) = &env.local_app_data {
        c.push(l.join("Programs").join("Ollama").join(exe));
    }
    if let Some(p) = &env.program_files {
        c.push(p.join("Ollama").join(exe));
    }
    c.extend(env.path.iter().map(|d| d.join(exe)));
    c.extend(env.registry.iter().map(|d| d.join(exe)));
    if let Some(s) = &env.scoop {
        c.push(s.join("apps").join("ollama").join("current").join(exe));
        c.push(s.join("shims").join(exe));
    }
    c.extend(env.winget.iter().map(|d| d.join(exe)));
    let mut seen = HashSet::new();
    c.retain(|p| seen.insert(p.to_string_lossy().to_ascii_lowercase()));
    c
}

/// One value from `reg query <key> /v <name>` output (`    Name    REG_SZ    data`).
pub fn parse_reg_value(out: &str, name: &str) -> Option<String> {
    out.lines().find_map(|l| {
        let mut parts = l.trim().splitn(3, "    ");
        let (n, ty, data) = (parts.next()?, parts.next()?.trim(), parts.next()?.trim());
        (n.eq_ignore_ascii_case(name) && ty.starts_with("REG_")).then(|| data.to_string())
    })
}

/// Expands `%VAR%` in a registry PATH (REG_EXPAND_SZ).
fn expand_env(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) => {
                let name = &after[..j];
                out.push_str(&std::env::var(name).unwrap_or_else(|_| format!("%{name}%")));
                rest = &after[j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn reg_query(key: &str, value: &str) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let mut cmd = crate::claude_setup::command(Path::new("reg"));
    cmd.args(["query", key, "/v", value]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_reg_value(&String::from_utf8_lossy(&out.stdout), value)
}

impl ExeEnv {
    pub fn from_process(custom: Option<&Path>) -> ExeEnv {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
        let mut path: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        for key in [r"HKCU\Environment", r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"] {
            if let Some(p) = reg_query(key, "Path") {
                path.extend(expand_env(&p).split(';').filter(|d| !d.trim().is_empty()).map(|d| PathBuf::from(d.trim())));
            }
        }
        let registry = ["HKCU", "HKLM", r"HKLM\SOFTWARE\WOW6432Node"]
            .iter()
            .filter_map(|root| {
                let key = if root.contains("WOW6432Node") { format!(r"{root}\{}", UNINSTALL_KEY.trim_start_matches(r"Software\")) } else { format!(r"{root}\{UNINSTALL_KEY}") };
                reg_query(&key, "InstallLocation")
            })
            .map(|p| PathBuf::from(p.trim_end_matches('\\')))
            .collect();
        let local = var("LOCALAPPDATA");
        let mut winget = Vec::new();
        if let Some(l) = &local {
            let pkgs = l.join("Microsoft").join("WinGet").join("Packages");
            if let Ok(rd) = std::fs::read_dir(&pkgs) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().to_ascii_lowercase().starts_with("ollama.ollama") {
                        winget.push(e.path());
                    }
                }
            }
            winget.push(l.join("Microsoft").join("WinGet").join("Links"));
        }
        ExeEnv {
            custom: custom.map(Path::to_path_buf),
            local_app_data: local,
            program_files: var("ProgramFiles"),
            path,
            registry,
            scoop: var("SCOOP").or_else(|| var("USERPROFILE").map(|h| h.join("scoop"))),
            winget,
        }
    }
}

/// `where ollama` (Windows), the last resort.
fn where_ollama() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let mut cmd = crate::claude_setup::command(Path::new("where"));
    cmd.arg("ollama").stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let out = cmd.output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().map(|l| PathBuf::from(l.trim())).find(|p| p.is_file())
}

/// ollama.exe on this machine, if any (see [`exe_candidates`] for the order).
pub fn find_exe(custom: Option<&Path>) -> Option<PathBuf> {
    exe_candidates(&ExeEnv::from_process(custom)).into_iter().find(|p| p.is_file()).or_else(where_ollama)
}

/// What starts the server: Ollama's tray app next to ollama.exe (as the installer sets it up),
/// else `ollama serve`.
fn launcher_for(exe: &Path) -> (PathBuf, bool) {
    if let Some(app) = exe.parent().map(|d| d.join("ollama app.exe")).filter(|p| p.is_file()) {
        return (app, false);
    }
    (exe.to_path_buf(), true)
}

/// Starts an installed but stopped Ollama and waits up to 20 s for it to answer at `addr`.
/// The child inherits this process's env, so it listens on the same OLLAMA_HOST.
pub fn start_server(addr: &str, custom: Option<&Path>) -> bool {
    let Some(exe) = find_exe(custom) else { return false };
    let (program, serve) = launcher_for(&exe);
    let mut cmd = std::process::Command::new(crate::claude_setup::child_path(&program));
    if serve {
        cmd.arg("serve");
    }
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    crate::claude_setup::hide_window(&mut cmd);
    if cmd.spawn().is_err() {
        return false;
    }
    wait_up(addr, Duration::from_secs(20))
}

pub fn wait_up(addr: &str, limit: Duration) -> bool {
    let until = Instant::now() + limit;
    while Instant::now() < until {
        if server_up(addr) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
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
    /// ollama.exe was found on disk (server may still be stopped).
    pub installed: bool,
    /// Where ollama.exe was found (when the server is down).
    pub exe: Option<String>,
    /// The address checked (`host:port`), and a note when OLLAMA_HOST was unusable.
    pub host: String,
    pub host_note: Option<String>,
    /// Something other than Ollama answers at that address.
    pub foreign: bool,
    /// Ollama didn't answer in time: it is busy (loading the model), not stopped.
    pub busy: bool,
    /// The model from settings.
    pub model: String,
    /// It's an Ollama cloud model.
    pub cloud: bool,
    /// Cloud model, but Ollama isn't signed in (`ollama signin`).
    pub needs_signin: bool,
    /// The cloud model was declined on a weak-GPU PC: chat stays on Claude.
    pub declined: bool,
    /// The base model is pulled (a cloud model: known to Ollama).
    pub pulled: bool,
    /// Its capabilities include "tools" (None: not pulled, unknown).
    pub tools: Option<bool>,
    pub vision: Option<bool>,
    /// The model Dreamer runs: the 64k variant (created on demand), or the cloud model itself.
    pub variant: Option<String>,
    /// Everything needed for a local turn.
    pub ready: bool,
    pub pulling: bool,
    /// Ollama's installer is downloading or running.
    pub installing: bool,
    pub error: Option<String>,
}

/// What a check needs from the settings.
#[derive(Clone, Debug, Default)]
pub struct LocalCfg {
    pub model: String,
    /// The folder picked with "Locate ollama.exe…".
    pub exe_dir: Option<PathBuf>,
    pub cloud_declined: bool,
}

impl LocalCfg {
    pub fn from_settings(s: &crate::model::Settings) -> LocalCfg {
        LocalCfg { model: s.local_model.clone(), exe_dir: (!s.ollama_path.trim().is_empty()).then(|| PathBuf::from(s.ollama_path.trim())), cloud_declined: s.local_cloud_declined }
    }
}

/// Capabilities of an installed model, or None when it isn't pulled.
fn capabilities(addr: &str, model: &str) -> std::io::Result<Option<Vec<String>>> {
    let (code, v) = json_call(addr, "POST", "/api/show", Some(&json!({ "model": model })), Duration::from_secs(5))?;
    if code == 404 {
        return Ok(None);
    }
    if code >= 400 {
        return Err(std::io::Error::other(format!("{code}: {}", error_text(&v, "show failed"))));
    }
    Ok(Some(v.get("capabilities").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()))
}

/// Creates the num_ctx variant from a pulled base (metadata only, quick). A cloud model has none:
/// its context is set by Ollama's servers, so its own name is returned.
fn create_variant(addr: &str, base: &str) -> std::io::Result<String> {
    let name = variant_name(base);
    if is_cloud(base) {
        return Ok(name);
    }
    let body = json!({ "model": name, "from": full_name(base), "parameters": { "num_ctx": NUM_CTX }, "stream": false });
    let (code, v) = json_call(addr, "POST", "/api/create", Some(&body), Duration::from_secs(60))?;
    if code >= 400 {
        return Err(std::io::Error::other(error_text(&v, "create failed")));
    }
    Ok(name)
}

/// A cloud model Ollama doesn't know yet: a non-streamed pull fetches its manifest only (no weights).
fn register_cloud(addr: &str, model: &str) -> std::result::Result<(), (u16, String)> {
    match json_call(addr, "POST", "/api/pull", Some(&json!({ "model": full_name(model), "stream": false })), Duration::from_secs(60)) {
        Ok((c, _)) if c < 400 => Ok(()),
        Ok((c, v)) => Err((c, error_text(&v, "pull failed"))),
        Err(e) => Err((0, e.to_string())),
    }
}

/// One-token request: the only way to learn whether Ollama is signed in for cloud models.
fn cloud_signed_in(addr: &str, model: &str) -> std::result::Result<(), (u16, String)> {
    let body = json!({ "model": full_name(model), "prompt": "ok", "stream": false, "options": { "num_predict": 1 } });
    match json_call(addr, "POST", "/api/generate", Some(&body), Duration::from_secs(45)) {
        Ok((c, v)) if c < 400 && v.get("error").is_none() => Ok(()),
        Ok((c, v)) => Err((c, error_text(&v, "the cloud model didn't answer"))),
        Err(e) => Err((0, e.to_string())),
    }
}

fn busy(mut st: LocalStatus) -> LocalStatus {
    st.busy = true;
    st.installed = true;
    st.error = Some("Ollama didn't answer in time (model loading).".into());
    st
}

/// Full check against a server at `addr`. Creates the 64k variant when the base is there and it
/// isn't. `cloud_ok`: this cloud model already answered once (skips the sign-in probe).
fn check_at(addr: &str, cfg: &LocalCfg, cloud_ok: bool) -> LocalStatus {
    let model = cfg.model.as_str();
    let mut st = LocalStatus { model: model.to_string(), host: addr.to_string(), cloud: is_cloud(model), ..Default::default() };
    match probe(addr, Duration::from_secs(2)) {
        Probe::Up(v) => {
            st.running = true;
            st.installed = true;
            st.version_ok = version_ok(&v);
            st.version = Some(v);
        }
        Probe::Foreign => {
            st.foreign = true;
            st.installed = find_exe(cfg.exe_dir.as_deref()).is_some();
            st.error = Some(format!("Another program is using {addr}, and it isn't Ollama. Close it, or set OLLAMA_HOST to a free port (e.g. 127.0.0.1:11435) and restart Ollama and Dreamer."));
            return st;
        }
        Probe::Down => {
            let exe = find_exe(cfg.exe_dir.as_deref());
            st.installed = exe.is_some();
            st.exe = exe.map(|p| p.display().to_string());
            st.error = Some(if st.installed { "Ollama isn't running.".into() } else { "Ollama isn't installed.".into() });
            return st;
        }
        Probe::Busy => return busy(st),
    }
    if !st.version_ok {
        st.error = Some(format!("Ollama {} is too old; Dreamer needs {}.{} or newer. Update Ollama.", st.version.as_deref().unwrap_or("?"), MIN_VERSION.0, MIN_VERSION.1));
        return st;
    }
    let signin = |st: &mut LocalStatus| {
        st.needs_signin = true;
        st.error = Some(format!("{model} runs on Ollama's servers and needs an Ollama account. Run `{SIGNIN_COMMAND}` in a terminal, then press Check again."));
    };
    let mut caps = capabilities(addr, &full_name(model));
    if st.cloud && matches!(caps, Ok(None)) {
        match register_cloud(addr, model) {
            Ok(()) => caps = capabilities(addr, &full_name(model)),
            Err((c, e)) if is_auth_error(c, &e) => {
                signin(&mut st);
                return st;
            }
            Err((_, e)) => {
                st.error = Some(format!("Ollama couldn't find the cloud model {model}: {e}"));
                return st;
            }
        }
    }
    match caps {
        Err(e) if timed_out(&e) => return busy(st),
        Ok(Some(caps)) => {
            st.pulled = true;
            // A cloud model's details may come without a capabilities list; the library lists tools for it.
            let assumed = st.cloud && caps.is_empty();
            st.tools = Some(assumed || caps.iter().any(|c| c == "tools"));
            st.vision = Some(caps.iter().any(|c| c == "vision"));
        }
        Ok(None) => {
            st.error = Some(format!("Model {model} isn't installed."));
            if cfg.cloud_declined {
                st.declined = true;
                st.error = Some("No local model on this PC: its GPU is too small for one and the cloud model was declined, so chat uses Claude.".into());
            }
            return st;
        }
        Err(e) if st.cloud && is_auth_error(0, &e.to_string()) => {
            signin(&mut st);
            return st;
        }
        Err(e) => {
            st.error = Some(format!("Local model error: couldn't read the model's details ({e})"));
            return st;
        }
    }
    if st.tools != Some(true) {
        st.error = Some(format!("{model} doesn't support tool calls, which Dreamer's chat needs. Pick another model."));
        return st;
    }
    if st.cloud {
        if !cloud_ok {
            match cloud_signed_in(addr, model) {
                Ok(()) => {}
                Err((c, e)) if is_auth_error(c, &e) => {
                    signin(&mut st);
                    return st;
                }
                Err((_, e)) => {
                    st.error = Some(format!("The cloud model {model} didn't answer: {e}"));
                    return st;
                }
            }
        }
        st.variant = Some(variant_name(model));
        st.ready = true;
        return st;
    }
    let variant = variant_name(model);
    let have = matches!(capabilities(addr, &variant), Ok(Some(_)));
    match if have { Ok(variant) } else { create_variant(addr, model) } {
        Ok(v) => st.variant = Some(v),
        Err(e) if timed_out(&e) => return busy(st),
        Err(e) => {
            st.error = Some(format!("Local model error: couldn't set up the 64k-context copy of {model} ({e})"));
            return st;
        }
    }
    st.ready = true;
    st
}

// ---------- state (cache + jobs) ----------

#[derive(Default)]
pub struct OllamaState {
    /// Last full check per model, with when it ran (send_message reuses it for a while).
    cache: Mutex<HashMap<String, (Instant, LocalStatus)>>,
    pull: Mutex<Option<Arc<AtomicBool>>>,
    /// The installer job (download, verify, run, start); its cancel flag.
    pub(crate) install: Mutex<Option<Arc<AtomicBool>>>,
    /// Cloud models that answered once (no sign-in probe on every check).
    cloud_ok: Mutex<HashSet<String>>,
    /// The GPU, detected once per run.
    pub(crate) gpu: Mutex<Option<Option<crate::ollama_install::Gpu>>>,
}

/// How long a chat turn waits for a busy Ollama (loading the model) before falling back to Claude.
const LOAD_WAIT: Duration = Duration::from_secs(60);

/// The OS side of a restart, so tests can run it without touching real processes.
trait RestartIo {
    /// Processes of the Ollama install Dreamer resolved (ollama.exe, ollama app.exe, runners): nothing else.
    fn owned_pids(&self) -> Vec<u32>;
    fn kill(&self, pid: u32) -> std::result::Result<(), String>;
    fn start(&self) -> bool;
}

struct SysIo {
    exe_dir: Option<PathBuf>,
}

/// `Id|Path` lines from Get-Process -> pids whose executable sits in `dir`.
fn pids_in_dir(listing: &str, dir: &Path) -> Vec<u32> {
    let same = |p: &Path| p.parent().is_some_and(|d| d.to_string_lossy().eq_ignore_ascii_case(&dir.to_string_lossy()));
    listing.lines().filter_map(|l| l.trim().split_once('|')).filter(|(_, path)| same(Path::new(path.trim()))).filter_map(|(id, _)| id.trim().parse().ok()).collect()
}

impl RestartIo for SysIo {
    fn owned_pids(&self) -> Vec<u32> {
        let Some(dir) = find_exe(self.exe_dir.as_deref()).and_then(|e| e.parent().map(Path::to_path_buf)) else { return Vec::new() };
        let mut cmd = crate::claude_setup::command(Path::new("powershell"));
        cmd.args(["-NoProfile", "-Command", "Get-Process -Name 'ollama','ollama app' -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id)|$($_.Path)\" }"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        cmd.output().map(|o| pids_in_dir(&String::from_utf8_lossy(&o.stdout), &dir)).unwrap_or_default()
    }

    fn kill(&self, pid: u32) -> std::result::Result<(), String> {
        let mut cmd = crate::claude_setup::command(Path::new("taskkill"));
        cmd.args(["/F", "/PID", &pid.to_string()]).stdin(std::process::Stdio::null());
        let out = cmd.output().map_err(|e| format!("Couldn't stop Ollama: {e}"))?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        if out.status.success() || text.contains("not found") {
            Ok(())
        } else if text.to_ascii_lowercase().contains("access is denied") {
            Err("Couldn't stop Ollama: permission denied. Quit it from the tray icon instead.".into())
        } else {
            Err(format!("Couldn't stop Ollama: {}", text.trim()))
        }
    }

    fn start(&self) -> bool {
        start_server(&host().addr, self.exe_dir.as_deref())
    }
}

/// A full status is reused this long by chat turns; a cheap version ping still runs every turn.
const CACHE_FOR: Duration = Duration::from_secs(60);

impl OllamaState {
    pub fn pulling(&self) -> bool {
        self.pull.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn installing(&self) -> bool {
        self.install.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn status(&self, cfg: &LocalCfg) -> LocalStatus {
        self.status_at(host(), cfg)
    }

    fn status_at(&self, h: Host, cfg: &LocalCfg) -> LocalStatus {
        let cloud_ok = self.cloud_ok.lock().map(|s| s.contains(&cfg.model)).unwrap_or(false);
        let mut st = check_at(&h.addr, cfg, cloud_ok);
        if st.cloud && st.ready {
            if let Ok(mut s) = self.cloud_ok.lock() {
                s.insert(cfg.model.clone());
            }
        }
        st.host_note = h.note;
        st.pulling = self.pulling();
        st.installing = self.installing();
        if let Ok(mut c) = self.cache.lock() {
            c.insert(cfg.model.clone(), (Instant::now(), st.clone()));
        }
        st
    }

    /// "Check again" (and the startup check): starts an installed-but-stopped Ollama first.
    pub fn check_again(&self, cfg: &LocalCfg) -> LocalStatus {
        let h = host();
        if !self.installing() && probe(&h.addr, Duration::from_millis(800)) == Probe::Down {
            start_server(&h.addr, cfg.exe_dir.as_deref());
        }
        if let Ok(mut s) = self.cloud_ok.lock() {
            s.remove(&cfg.model); // re-probe sign-in: the user may just have run `ollama signin`
        }
        self.status(cfg)
    }

    /// For a chat turn: the cached status if recent and the server still answers; else the same
    /// full check the dialog runs. A busy server (loading the model) is waited for, up to
    /// `LOAD_WAIT`; `on_wait` runs once when the wait begins.
    pub fn for_turn(&self, cfg: &LocalCfg, on_wait: &dyn Fn()) -> LocalStatus {
        self.for_turn_at(&host(), cfg, on_wait, LOAD_WAIT)
    }

    fn for_turn_at(&self, h: &Host, cfg: &LocalCfg, on_wait: &dyn Fn(), limit: Duration) -> LocalStatus {
        let cached = self.cache.lock().ok().and_then(|c| c.get(&cfg.model).cloned());
        if let Some((at, st)) = cached {
            if st.ready && at.elapsed() < CACHE_FOR && matches!(probe(&h.addr, Duration::from_millis(700)), Probe::Up(_)) {
                return st;
            }
        }
        let until = Instant::now() + limit;
        let mut st = self.status_at(h.clone(), cfg);
        if st.busy {
            on_wait();
        }
        while st.busy && Instant::now() < until {
            std::thread::sleep(Duration::from_secs(1));
            st = self.status_at(h.clone(), cfg);
        }
        st
    }

    /// "Restart Ollama": stops the Ollama that Dreamer found (never another program), starts it,
    /// and loads the model so the next turn doesn't pay for it. `progress` gets "stopping",
    /// "starting" and "loading". Clears the cached status so the next turn checks fresh.
    pub fn restart(&self, cfg: &LocalCfg, progress: &dyn Fn(&str)) -> std::result::Result<LocalStatus, String> {
        let io = SysIo { exe_dir: cfg.exe_dir.clone() };
        self.restart_with(cfg, &host(), &io, progress)
    }

    fn restart_with(&self, cfg: &LocalCfg, h: &Host, io: &dyn RestartIo, progress: &dyn Fn(&str)) -> std::result::Result<LocalStatus, String> {
        let addr = h.addr.as_str();
        if self.installing() {
            return Err("Ollama is being installed right now.".into());
        }
        self.clear_cache();
        let port = addr.rsplit(':').next().unwrap_or(addr);
        if probe(addr, Duration::from_secs(2)) == Probe::Foreign {
            return Err(format!("Port {port} is used by another program."));
        }
        progress("stopping");
        let pids = io.owned_pids();
        // Something answers (as Ollama or busy) but none of the processes is the Ollama we found.
        if pids.is_empty() && matches!(probe(addr, Duration::from_secs(2)), Probe::Up(_) | Probe::Busy) {
            return Err("Ollama is running from a folder Dreamer didn't find, so it won't stop it. Quit it yourself, or use Locate ollama.exe.".into());
        }
        for pid in pids {
            io.kill(pid)?;
        }
        let gone = Instant::now() + Duration::from_secs(10);
        while Instant::now() < gone && !matches!(probe(addr, Duration::from_millis(500)), Probe::Down) {
            std::thread::sleep(Duration::from_millis(300));
        }
        progress("starting");
        if !io.start() {
            return Err("Ollama didn't start within 20 seconds.".into());
        }
        let st = self.status_at(h.clone(), cfg);
        if !st.ready || st.cloud {
            return Ok(st);
        }
        progress("loading");
        let variant = st.variant.clone().unwrap_or_default();
        let body = json!({ "model": variant, "keep_alive": KEEP_ALIVE });
        match json_call(addr, "POST", "/api/generate", Some(&body), Duration::from_secs(180)) {
            Ok((c, _)) if c < 400 => {}
            Ok((_, v)) => return Err(format!("Ollama started, but the model didn't load: {}", error_text(&v, "request failed"))),
            Err(e) => return Err(format!("Ollama started, but the model didn't load: {e}")),
        }
        self.clear_cache();
        Ok(self.status_at(h.clone(), cfg))
    }

    pub fn clear_cache(&self) {
        if let Ok(mut c) = self.cache.lock() {
            c.clear();
        }
    }

    pub fn cancel_pull(&self) {
        if let Ok(g) = self.pull.lock() {
            if let Some(c) = g.as_ref() {
                c.store(true, Ordering::SeqCst);
            }
        }
    }
}

// ---------- structured calls (the organize pipeline) and keeping the model warm ----------

/** How long Dreamer asks Ollama to keep the chat model loaded after a request of its own. */
pub const KEEP_ALIVE: &str = "30m";

/// Why a structured call failed: the model went silent (a stall) or it errored / returned nonsense.
#[derive(Debug, Clone, PartialEq)]
pub enum LlmError {
    Stalled(String),
    Failed(String),
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmError::Stalled(m) | LlmError::Failed(m) => f.write_str(m),
        }
    }
}

/// Watchdog limits of one structured call.
#[derive(Clone, Copy, Debug)]
pub struct ChatLimits {
    /// Until the first streamed chunk (model load + reading the prompt).
    pub first: Duration,
    /// Between chunks after that.
    pub idle: Duration,
    /// The whole call.
    pub total: Duration,
}

impl Default for ChatLimits {
    fn default() -> Self {
        ChatLimits { first: Duration::from_secs(90), idle: Duration::from_secs(45), total: Duration::from_secs(240) }
    }
}

/// The streamed body of /api/chat: NDJSON lines with `message.content` pieces, then `done`.
/// Returns the whole content. Every read waits at most 1 s, so the limits are checked as it goes.
fn read_chat_stream(r: &mut Resp, limits: &ChatLimits, started: Instant, cancel: &AtomicBool) -> std::result::Result<String, LlmError> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut content = String::new();
    let mut last = Instant::now();
    let mut got_any = false;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(LlmError::Failed("cancelled".into()));
        }
        let now = Instant::now();
        if now.duration_since(started) > limits.total {
            return Err(LlmError::Stalled(format!("the model did not finish within {}s", limits.total.as_secs())));
        }
        if !got_any && now.duration_since(started) > limits.first {
            return Err(LlmError::Stalled(format!("no reply from the local model within {}s", limits.first.as_secs())));
        }
        if got_any && now.duration_since(last) > limits.idle {
            return Err(LlmError::Stalled(format!("the local model went silent for {}s", limits.idle.as_secs())));
        }
        match r.body.read(&mut chunk) {
            Ok(0) => return Err(LlmError::Failed("the local model's server closed the connection".into())),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                while let Some(i) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=i).collect();
                    let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
                    if let Some(e) = v.get("error").and_then(Value::as_str) {
                        return Err(LlmError::Failed(e.to_string()));
                    }
                    let piece = v.pointer("/message/content").and_then(Value::as_str).unwrap_or_default();
                    // Thinking chunks (if a model thinks anyway) count as activity, not content.
                    if !piece.is_empty() || v.pointer("/message/thinking").is_some() {
                        got_any = true;
                        last = Instant::now();
                    }
                    content.push_str(piece);
                    if v.get("done").and_then(Value::as_bool) == Some(true) {
                        return Ok(content);
                    }
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
            Err(e) => return Err(LlmError::Failed(format!("reading from the local model failed: {e}"))),
        }
    }
}

/// One /api/chat call with a JSON-schema `format` (Ollama's structured output: the reply always
/// parses and matches the schema's shape, ids included when they are enums), thinking off, the model
/// kept warm. Streamed, so a silent model is caught by `limits`.
pub fn chat_json(model: &str, system: &str, user: &str, schema: &Value, temperature: f64, limits: &ChatLimits, cancel: &AtomicBool) -> std::result::Result<Value, LlmError> {
    let addr = host().addr;
    let body = json!({
        "model": model,
        "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
        "stream": true,
        "format": schema,
        "think": false,
        "keep_alive": KEEP_ALIVE,
        "options": { "temperature": temperature, "top_p": 0.8, "top_k": 20, "num_predict": 4096 },
    });
    let started = Instant::now();
    let mut r = request(&addr, "POST", "/api/chat", Some(&body), Some(Duration::from_secs(1))).map_err(|e| LlmError::Failed(format!("the local model's server is not reachable ({e})")))?;
    if r.status != 200 {
        let mut text = String::new();
        let _ = r.body.read_to_string(&mut text);
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        return Err(LlmError::Failed(format!("Ollama answered {}: {}", r.status, error_text(&v, "request failed"))));
    }
    let content = read_chat_stream(&mut r, limits, started, cancel)?;
    let trimmed = content.trim();
    serde_json::from_str::<Value>(trimmed).map_err(|e| LlmError::Failed(format!("the reply was not valid JSON ({e}; {} chars)", trimmed.len())))
}

/// Loads `model` (if it isn't) and keeps it loaded for KEEP_ALIVE: an empty /api/generate. Runs on
/// its own thread; never blocks the caller. Chat requests through the Anthropic API reset Ollama's
/// expiry to its default (5 minutes), so this also runs after local turns.
pub fn warm(model: &str) {
    if model.is_empty() || is_cloud(model) {
        return;
    }
    let (addr, model) = (host().addr, model.to_string());
    std::thread::spawn(move || {
        let t = Instant::now();
        let r = json_call(&addr, "POST", "/api/generate", Some(&json!({ "model": model, "keep_alive": KEEP_ALIVE })), Duration::from_secs(180));
        crate::sidecar_log::line(&format!("ollama warm {model}: {} in {}ms", match &r { Ok((c, _)) => format!("HTTP {c}"), Err(e) => format!("failed ({e})") }, t.elapsed().as_millis()));
    });
}

static LAST_WARM: Mutex<Option<Instant>> = Mutex::new(None);

/// Warms the configured local model unless that happened within `gap` (window focus, app start).
pub fn warm_if_stale(app: &AppHandle, gap: Duration) {
    use tauri::Manager;
    let state = app.state::<crate::state::AppState>();
    let model = crate::sidecar::local_variant(&state);
    if model.is_empty() {
        return;
    }
    if let Ok(mut last) = LAST_WARM.lock() {
        if last.is_some_and(|t| t.elapsed() < gap) {
            return;
        }
        *last = Some(Instant::now());
    }
    warm(&model);
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

/// Ollama's pull errors in plain words.
fn describe_pull_error(e: &str) -> String {
    let l = e.to_ascii_lowercase();
    if l.contains("no space") || l.contains("disk full") || l.contains("not enough space") {
        format!("The disk is full, so the model couldn't be downloaded. Free some space (or move Ollama's models folder with OLLAMA_MODELS) and try again. ({e})")
    } else if l.contains("dial tcp") || l.contains("no such host") || l.contains("i/o timeout") || l.contains("connection refused") || l.contains("network") {
        format!("No connection to Ollama's model library. Check the internet connection and try again. ({e})")
    } else if l.contains("file does not exist") || l.contains("manifest unknown") || l.contains("not found") {
        format!("Ollama's library has no model by that name. ({e})")
    } else {
        format!("The model download failed: {e}")
    }
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
        let addr = host().addr;
        let result = (|| -> std::result::Result<(), String> {
            let r = request(&addr, "POST", "/api/pull", Some(&json!({ "model": full_name(&model), "stream": true })), Some(Duration::from_secs(120)))
                .map_err(|e| format!("Couldn't reach Ollama: {e}"))?;
            if r.status >= 400 {
                let mut t = String::new();
                let mut b = r.body;
                let _ = b.read_to_string(&mut t);
                let msg = serde_json::from_str::<Value>(&t).ok().and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string)).unwrap_or(t);
                return Err(describe_pull_error(&msg));
            }
            let mut last_emit = Instant::now() - Duration::from_secs(1);
            let mut ended = false;
            for line in r.body.lines() {
                if cancel.load(Ordering::SeqCst) {
                    return Err("cancelled".into());
                }
                let line = line.map_err(|e| format!("The download was interrupted ({e}). Press Download again to resume where it stopped."))?;
                let Some((status, completed, total)) = parse_pull_line(&line) else { continue };
                if let Some(e) = status.strip_prefix("error: ") {
                    return Err(describe_pull_error(e));
                }
                ended = status == "success";
                // Progress lines arrive many times a second; the UI needs ~5.
                if last_emit.elapsed() >= Duration::from_millis(200) || total == 0 {
                    last_emit = Instant::now();
                    emit(json!({ "type": "progress", "status": status, "completed": completed, "total": total }));
                }
            }
            if !ended {
                return Err("The download was interrupted before it finished. Press Download again to resume where it stopped.".into());
            }
            if !is_cloud(&model) {
                emit(json!({ "type": "progress", "status": "setting up the 64k context", "completed": 0, "total": 0 }));
            }
            create_variant(&addr, &model).map_err(|e| format!("Downloaded, but couldn't set up the 64k-context copy: {e}"))?;
            Ok(())
        })();
        let cancelled = cancel.load(Ordering::SeqCst);
        if let Ok(mut g) = app_state(&app).pull.lock() {
            *g = None;
        }
        app_state(&app).clear_cache();
        match result {
            Ok(()) => emit(json!({ "type": "done", "ok": true, "cancelled": false, "message": "" })),
            Err(e) => emit(json!({ "type": "done", "ok": false, "cancelled": cancelled, "message": if cancelled { "Download cancelled.".to_string() } else { e } })),
        }
    });
    Ok(())
}

// ---------- automatic setup at startup ----------

/// The best already-downloaded model Dreamer's chat can use: supports tool calls, not an embedding
/// model, not one of Dreamer's own 64k copies. Vision first, then the largest.
fn pick_installed(addr: &str) -> Option<String> {
    let (code, v) = json_call(addr, "GET", "/api/tags", None, Duration::from_secs(5)).ok()?;
    if code != 200 {
        return None;
    }
    let mut best: Option<(bool, u64, String)> = None;
    for m in v.get("models").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = m.get("name").or_else(|| m.get("model")).and_then(Value::as_str) else { continue };
        let family = m.pointer("/details/family").and_then(Value::as_str).unwrap_or("");
        // Cloud models are listed too, but are only used when picked (they need sign-in).
        if name.starts_with("dreamer-") || name.contains("embed") || family.contains("bert") || !valid_model_name(name) || is_cloud(name) {
            continue;
        }
        let Ok(Some(caps)) = capabilities(addr, name) else { continue };
        if !caps.iter().any(|c| c == "tools") || caps.iter().any(|c| c == "embedding") {
            continue;
        }
        let key = (caps.iter().any(|c| c == "vision"), m.get("size").and_then(Value::as_u64).unwrap_or(0), name.to_string());
        if best.as_ref().is_none_or(|b| (key.0, key.1) > (b.0, b.1)) {
            best = Some(key);
        }
    }
    best.map(|b| b.2)
}

/// What the startup check settled on.
#[derive(Debug, PartialEq)]
pub enum AutoSetup {
    /// Nothing to do (local chat off, no Ollama, or no usable model).
    Nothing,
    /// The configured model is ready (its 64k copy now exists).
    Ready,
    /// The default model wasn't downloaded; this installed one was chosen instead.
    Switched(String),
}

/// Startup: when local chat is on, start an installed Ollama if it's stopped; if the configured
/// model is the untouched default and isn't downloaded, switch to the best installed model; then
/// run the full check, which creates the 64k copy. A model the user picked is never replaced.
pub fn auto_setup_at(addr: &str, cfg: &LocalCfg, is_default: bool) -> AutoSetup {
    if !server_up(addr) && !start_server(addr, cfg.exe_dir.as_deref()) {
        return AutoSetup::Nothing;
    }
    if is_cloud(&cfg.model) || matches!(capabilities(addr, &full_name(&cfg.model)), Ok(Some(_))) {
        return if check_at(addr, cfg, false).ready { AutoSetup::Ready } else { AutoSetup::Nothing };
    }
    if !is_default {
        return AutoSetup::Nothing;
    }
    match pick_installed(addr) {
        Some(m) if check_at(addr, &LocalCfg { model: m.clone(), ..cfg.clone() }, false).ready => AutoSetup::Switched(m),
        _ => AutoSetup::Nothing,
    }
}

/// Runs the startup check on a background thread; a switch is saved to settings and announced as
/// an `ollama-setup` `detected` event so the chat header refreshes.
pub fn spawn_auto_setup(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        use tauri::Manager;
        let state = app.state::<crate::state::AppState>();
        let Some(settings) = state.ws.lock().ok().and_then(|ws| ws.get_settings().ok()) else { return };
        if !settings.local_chat {
            return;
        }
        let cfg = LocalCfg::from_settings(&settings);
        let is_default = settings.local_model == crate::model::DEFAULT_LOCAL_MODEL;
        let result = auto_setup_at(&host().addr, &cfg, is_default);
        let model = match &result {
            AutoSetup::Nothing => return,
            AutoSetup::Ready => settings.local_model.clone(),
            AutoSetup::Switched(m) => {
                let saved = state.ws.lock().ok().and_then(|ws| ws.update_settings(crate::model::SettingsPatch { local_model: Some(m.clone()), ..Default::default() }).ok());
                if saved.is_none() {
                    return;
                }
                m.clone()
            }
        };
        let st = state.ollama.status(&LocalCfg { model: model.clone(), ..cfg }); // refreshes the cache chat turns read
        // Pre-warm: the first message then doesn't pay the model load (only when the window shows).
        if st.ready && app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false)) {
            warm_if_stale(&app, Duration::from_secs(0));
        }
        let _ = app.emit("ollama-setup", json!({ "type": "detected", "model": model, "switched": matches!(result, AutoSetup::Switched(_)) }));
    });
}

pub(crate) fn app_state(app: &AppHandle) -> &OllamaState {
    use tauri::Manager;
    &app.state::<crate::state::AppState>().inner().ollama
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A fake Ollama: answers each connection by path from `routes` (status, body), in order of arrival.
    pub(crate) fn fake(routes: Vec<(&'static str, u16, String)>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap().to_string();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten() {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut first = String::new();
                if r.read_line(&mut first).unwrap_or(0) == 0 {
                    continue; // a bare connect (probe)
                }
                let mut len = 0usize;
                let mut h = String::new();
                loop {
                    h.clear();
                    r.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() {
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

    fn cfg(model: &str) -> LocalCfg {
        LocalCfg { model: model.into(), ..Default::default() }
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
        assert!(describe_pull_error("write /x: no space left on device").contains("disk is full"));
        assert!(describe_pull_error("dial tcp: lookup registry.ollama.ai: no such host").contains("internet"));
    }

    #[test]
    fn ollama_host_parsing() {
        let ok = |raw: Option<&str>| {
            let h = parse_host(raw);
            assert!(h.note.is_none(), "{raw:?}: {:?}", h.note);
            h.addr
        };
        assert_eq!(ok(None), "127.0.0.1:11434");
        assert_eq!(ok(Some("  ")), "127.0.0.1:11434");
        assert_eq!(ok(Some("0.0.0.0")), "127.0.0.1:11434");
        assert_eq!(ok(Some("0.0.0.0:8080")), "127.0.0.1:8080");
        assert_eq!(ok(Some(":11500")), "127.0.0.1:11500");
        assert_eq!(ok(Some("localhost:9000")), "localhost:9000");
        assert_eq!(ok(Some("http://127.0.0.1:12000")), "127.0.0.1:12000");
        assert_eq!(ok(Some("HTTP://box.lan")), "box.lan:11434");
        assert_eq!(ok(Some("http://192.168.1.5:11434/")), "192.168.1.5:11434");
        assert_eq!(ok(Some("[::1]:7000")), "[::1]:7000");
        assert_eq!(ok(Some("::")), "[::1]:11434");
        assert_eq!(parse_host(Some("127.0.0.1:12000")).base_url, "http://127.0.0.1:12000");
        for bad in ["https://x:1", "ftp://x", "x:notaport", "x:0", "x:70000", "bad host", "[::1"] {
            let h = parse_host(Some(bad));
            assert_eq!(h.addr, "127.0.0.1:11434", "{bad}");
            assert!(h.note.as_deref().is_some_and(|n| n.contains(bad)), "{bad}");
        }
    }

    #[test]
    fn tiers_from_vram() {
        let mib = |n: u64| Some(n << 20);
        assert_eq!(tier_for(mib(24_564)).model, "qwen3.5:35b-a3b"); // RTX 4090
        assert_eq!(tier_for(mib(20_475)).model, "qwen3.5:35b-a3b"); // "20 GB" card
        assert_eq!(tier_for(mib(16_376)).model, "qwen3.5:9b"); // RTX 4080 SUPER
        assert_eq!(tier_for(mib(12_282)).model, "qwen3.5:9b");
        assert_eq!(tier_for(mib(8_188)).model, "qwen3.5:4b");
        assert_eq!(tier_for(mib(6_144)).model, "qwen3.5:4b");
        assert!(tier_for(mib(4_096)).cloud);
        assert!(tier_for(mib(512)).cloud); // integrated graphics
        assert!(tier_for(None).cloud); // no dedicated GPU, or unknown
        assert_eq!(MODEL_TIERS[0].model, crate::model::DEFAULT_LOCAL_MODEL);
        assert!(choices().iter().all(|c| valid_model_name(c.model) && c.cloud == is_cloud(c.model)));
    }

    #[test]
    fn exe_search_order() {
        let env = ExeEnv {
            custom: Some(PathBuf::from(r"D:\Tools\Ollama")),
            local_app_data: Some(PathBuf::from(r"C:\U\AppData\Local")),
            program_files: Some(PathBuf::from(r"C:\Program Files")),
            path: vec![PathBuf::from(r"C:\bin"), PathBuf::from(r"C:\U\AppData\Local\Programs\Ollama")],
            registry: vec![PathBuf::from(r"E:\Apps\Ollama")],
            scoop: Some(PathBuf::from(r"C:\U\scoop")),
            winget: vec![PathBuf::from(r"C:\U\AppData\Local\Microsoft\WinGet\Packages\Ollama.Ollama_x")],
        };
        let c: Vec<String> = exe_candidates(&env).iter().map(|p| p.to_string_lossy().replace('/', "\\")).collect();
        let e = exe_name();
        let want = [
            format!(r"D:\Tools\Ollama\{e}"),
            format!(r"C:\U\AppData\Local\Programs\Ollama\{e}"),
            format!(r"C:\Program Files\Ollama\{e}"),
            format!(r"C:\bin\{e}"),
            // the PATH entry equal to the standard install is not repeated
            format!(r"E:\Apps\Ollama\{e}"),
            format!(r"C:\U\scoop\apps\ollama\current\{e}"),
            format!(r"C:\U\scoop\shims\{e}"),
            format!(r"C:\U\AppData\Local\Microsoft\WinGet\Packages\Ollama.Ollama_x\{e}"),
        ];
        assert_eq!(c, want);
        // A picked file is used as is.
        let c = exe_candidates(&ExeEnv { custom: Some(PathBuf::from(r"D:\x\ollama.exe")), ..Default::default() });
        assert_eq!(c[0], PathBuf::from(r"D:\x\ollama.exe"));
        // Found on disk: the picked folder wins over the standard install.
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b").join("Programs").join("Ollama"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join(e), "").unwrap();
        std::fs::write(b.join(e), "").unwrap();
        let env = ExeEnv { custom: Some(a.clone()), local_app_data: Some(dir.path().join("b")), ..Default::default() };
        assert_eq!(exe_candidates(&env).into_iter().find(|p| p.is_file()), Some(a.join(e)));
        assert_eq!(launcher_for(&a.join(e)), (a.join(e), true));
        std::fs::write(a.join("ollama app.exe"), "").unwrap();
        assert_eq!(launcher_for(&a.join(e)), (a.join("ollama app.exe"), false));
    }

    #[test]
    fn reg_output_parsing() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\...\\{44E83376}_is1\r\n    InstallLocation    REG_SZ    C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\\r\n\r\n";
        assert_eq!(parse_reg_value(out, "InstallLocation").as_deref(), Some(r"C:\Users\u\AppData\Local\Programs\Ollama\"));
        assert_eq!(parse_reg_value(out, "Path"), None);
        let (k, v) = std::env::vars().find(|(k, v)| !k.is_empty() && !k.contains(['%', '=']) && !v.contains('%')).unwrap();
        assert_eq!(expand_env(&format!(r"%{k}%\bin;%NOPE_NOT_SET%;a%")), format!(r"{v}\bin;%NOPE_NOT_SET%;a%"));
    }

    /// A server that accepts connections and never answers (Ollama busy loading a model).
    fn hung() -> (TcpListener, String) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap().to_string();
        (l, addr)
    }

    fn host_of(addr: &str) -> Host {
        Host { addr: addr.into(), base_url: format!("http://{addr}"), note: None }
    }

    #[derive(Default)]
    struct MockIo {
        pids: Vec<u32>,
        killed: std::cell::RefCell<Vec<u32>>,
    }
    impl RestartIo for MockIo {
        fn owned_pids(&self) -> Vec<u32> {
            self.pids.clone()
        }
        fn kill(&self, pid: u32) -> std::result::Result<(), String> {
            self.killed.borrow_mut().push(pid);
            Ok(())
        }
        fn start(&self) -> bool {
            true
        }
    }

    #[test]
    fn slow_load_is_busy_not_not_running() {
        let (_keep, addr) = hung();
        assert_eq!(probe(&addr, Duration::from_millis(300)), Probe::Busy);
        let st = check_at(&addr, &cfg("m:1"), false);
        assert!(st.busy && !st.running && !st.foreign && st.error.unwrap().contains("didn't answer in time"));
        // A closed port is a stopped server.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().to_string();
        assert_eq!(probe(&closed, Duration::from_millis(300)), Probe::Down);
        assert!(!check_at(&closed, &cfg("m:1"), false).busy);
    }

    #[test]
    fn chat_turn_uses_the_dialogs_check_and_waits_while_busy() {
        let ready = fake(vec![
            ("/api/version", 200, r#"{"version":"0.15.0"}"#.into()),
            ("/api/show m:1", 200, r#"{"capabilities":["completion","tools"]}"#.into()),
            ("/api/create", 200, r#"{"status":"success"}"#.into()),
        ]);
        let state = OllamaState::default();
        let turn = state.for_turn_at(&host_of(&ready), &cfg("m:1"), &|| panic!("not busy"), Duration::from_secs(1));
        assert_eq!(turn, state.status_at(host_of(&ready), &cfg("m:1")), "same check, same result");
        let (_keep, hung_addr) = hung();
        let waited = std::cell::Cell::new(0);
        let st = state.for_turn_at(&host_of(&hung_addr), &cfg("m:1"), &|| waited.set(waited.get() + 1), Duration::from_millis(1));
        assert!(st.busy && !st.ready);
        assert_eq!(waited.get(), 1, "the turn is told it is waiting, once");
    }

    #[test]
    fn restart_never_kills_what_is_not_ollama() {
        let other = fake(vec![("/api/version", 200, "<html>hello</html>".into())]);
        let io = MockIo { pids: vec![42], ..Default::default() };
        let err = OllamaState::default().restart_with(&cfg("m:1"), &host_of(&other), &io, &|_| {}).unwrap_err();
        assert!(err.starts_with("Port ") && err.contains("another program"), "{err}");
        assert!(io.killed.borrow().is_empty());
        // Ollama answering but no process of the resolved install: still no kill.
        let up = fake(vec![("/api/version", 200, r#"{"version":"0.15.0"}"#.into())]);
        assert!(OllamaState::default().restart_with(&cfg("m:1"), &host_of(&up), &MockIo::default(), &|_| {}).is_err());
        assert_eq!(pids_in_dir("7|C:\\Ollama\\ollama.exe\n8|C:\\Other\\ollama.exe\n9|C:\\Ollama\\ollama app.exe", Path::new("C:\\Ollama")), vec![7, 9]);
    }

    #[test]
    fn restart_clears_cached_unavailable_and_reports_ready() {
        let state = OllamaState::default();
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().to_string();
        let down = state.status_at(host_of(&closed), &cfg("m:1"));
        assert!(!down.ready && state.cache.lock().unwrap().contains_key("m:1"), "unavailable was cached");
        let ready = fake(vec![
            ("/api/version", 200, r#"{"version":"0.15.0"}"#.into()),
            ("/api/show m:1", 200, r#"{"capabilities":["completion","tools"]}"#.into()),
            ("/api/create", 200, r#"{"status":"success"}"#.into()),
            ("/api/generate", 200, "{}".into()),
        ]);
        let steps = std::cell::RefCell::new(Vec::new());
        let io = MockIo { pids: vec![5], ..Default::default() };
        let st = state.restart_with(&cfg("m:1"), &host_of(&ready), &io, &|s| steps.borrow_mut().push(s.to_string())).unwrap();
        assert!(st.ready);
        assert_eq!(*io.killed.borrow(), vec![5]);
        assert_eq!(*steps.borrow(), vec!["stopping", "starting", "loading"]);
        assert!(state.cache.lock().unwrap().get("m:1").is_some_and(|(_, c)| c.ready), "no stale unavailable left");
    }

    #[test]
    fn missing_server_is_not_ready() {
        // Nothing listens on this port (bound then dropped).
        let addr = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().to_string();
        let st = check_at(&addr, &cfg("qwen3.5:35b-a3b"), false);
        assert!(!st.running && !st.ready && !st.foreign && st.error.is_some());
    }

    #[test]
    fn port_taken_by_something_else() {
        let other = fake(vec![("/api/version", 200, "<html>hello</html>".into())]);
        let st = check_at(&other, &cfg("m:1"), false);
        assert!(st.foreign && !st.running && st.error.unwrap().contains("isn't Ollama"));
    }

    #[test]
    fn old_server_missing_model_and_ready_states() {
        let old = fake(vec![("/api/version", 200, r#"{"version":"0.13.5"}"#.into())]);
        let st = check_at(&old, &cfg("m:1"), false);
        assert!(st.running && !st.version_ok && !st.ready && st.error.unwrap().contains("too old"));

        let missing = fake(vec![("/api/version", 200, r#"{"version":"0.14.1"}"#.into())]);
        let st = check_at(&missing, &cfg("m:1"), false);
        assert!(st.version_ok && !st.pulled && !st.ready && st.error.unwrap().contains("isn't installed"));
        let declined = check_at(&missing, &LocalCfg { cloud_declined: true, ..cfg("m:1") }, false);
        assert!(declined.declined && declined.error.unwrap().contains("uses Claude"));

        let no_tools = fake(vec![("/api/version", 200, r#"{"version":"0.14.1"}"#.into()), ("/api/show m:1", 200, r#"{"capabilities":["completion"]}"#.into())]);
        let st = check_at(&no_tools, &cfg("m:1"), false);
        assert!(st.pulled && st.tools == Some(false) && !st.ready);

        // Variant missing: Dreamer creates it.
        let ready = fake(vec![
            ("/api/version", 200, r#"{"version":"0.15.0"}"#.into()),
            ("/api/show m:1", 200, r#"{"capabilities":["completion","tools","vision"]}"#.into()),
            ("/api/create", 200, r#"{"status":"success"}"#.into()),
        ]);
        let st = check_at(&ready, &cfg("m:1"), false);
        assert!(st.ready, "{:?}", st.error);
        assert_eq!((st.tools, st.vision, st.variant.as_deref()), (Some(true), Some(true), Some("dreamer-m:1")));
    }

    #[test]
    fn cloud_models() {
        assert!(is_cloud("gemma4:cloud") && is_cloud("gemma4:31b-cloud") && is_cloud("GLM-5.3:Cloud"));
        assert!(!is_cloud("qwen3.5:9b") && !is_cloud("cloud") && !is_cloud("cloudy:1b"));
        assert_eq!(variant_name("gemma4:cloud"), "gemma4:cloud");

        // Known and signed in: ready without a 64k copy (no /api/create route: it would 404).
        let ok = fake(vec![
            ("/api/version", 200, r#"{"version":"0.40.16"}"#.into()),
            ("/api/show gemma4:cloud", 200, r#"{"capabilities":["completion","tools","vision"],"remote_host":"https://ollama.com:443"}"#.into()),
            ("/api/generate", 200, r#"{"response":"ok","done":true}"#.into()),
        ]);
        let st = check_at(&ok, &cfg("gemma4:cloud"), false);
        assert!(st.ready && st.cloud && !st.needs_signin, "{:?}", st.error);
        assert_eq!(st.variant.as_deref(), Some("gemma4:cloud"));
        assert_eq!(create_variant(&ok, "gemma4:cloud").unwrap(), "gemma4:cloud");

        // Not signed in: the one-token probe says 401.
        let anon = fake(vec![
            ("/api/version", 200, r#"{"version":"0.40.16"}"#.into()),
            ("/api/show gemma4:cloud", 200, r#"{"capabilities":[]}"#.into()),
            ("/api/generate", 401, r#"{"error":"unauthorized","signin_url":"https://ollama.com/connect?x"}"#.into()),
        ]);
        let st = check_at(&anon, &cfg("gemma4:cloud"), false);
        assert!(st.needs_signin && !st.ready && st.tools == Some(true) && st.error.unwrap().contains("ollama signin"));
        // Already verified this run: no probe.
        assert!(check_at(&anon, &cfg("gemma4:cloud"), true).ready);

        // Unknown to Ollama, and the manifest fetch needs sign-in.
        let unknown = fake(vec![("/api/version", 200, r#"{"version":"0.40.16"}"#.into()), ("/api/pull", 401, r#"{"error":"unauthorized"}"#.into())]);
        let st = check_at(&unknown, &cfg("gemma4:cloud"), false);
        assert!(st.needs_signin && !st.pulled);
    }

    #[test]
    fn auto_setup_picks_best_installed_model_only_for_the_default() {
        let routes = || {
            vec![
                ("/api/version", 200, r#"{"version":"0.15.0"}"#.to_string()),
                (
                    "/api/tags",
                    200,
                    r#"{"models":[{"name":"dreamer-big:1","size":900},{"name":"nomic-embed-text:latest","size":50,"details":{"family":"nomic-bert"}},{"name":"small:1","size":10},{"name":"big:1","size":100},{"name":"chat-only:1","size":500},{"name":"gemma4:cloud","size":400}]}"#.to_string(),
                ),
                ("/api/show small:1", 200, r#"{"capabilities":["completion","tools"]}"#.to_string()),
                ("/api/show big:1", 200, r#"{"capabilities":["completion","tools"]}"#.to_string()),
                ("/api/show chat-only:1", 200, r#"{"capabilities":["completion"]}"#.to_string()),
                ("/api/show gemma4:cloud", 200, r#"{"capabilities":["completion","tools","vision"]}"#.to_string()),
                ("/api/create", 200, r#"{"status":"success"}"#.to_string()),
            ]
        };
        assert_eq!(auto_setup_at(&fake(routes()), &cfg("qwen3.5:35b-a3b"), true), AutoSetup::Switched("big:1".into()));
        assert_eq!(auto_setup_at(&fake(routes()), &cfg("mine:7b"), false), AutoSetup::Nothing);
        assert_eq!(auto_setup_at(&fake(routes()), &cfg("small:1"), false), AutoSetup::Ready);
    }
}
