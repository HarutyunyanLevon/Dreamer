//! In-app Claude Code setup: finding the `claude` executable, asking it whether the user is
//! signed in, and running `npm install -g @anthropic-ai/claude-code` / `claude auth login` as
//! child processes whose output streams into the chat panel's setup screen.
//!
//! Dreamer never sees or stores a credential. Sign-in is Claude Code's own browser OAuth flow
//! (`claude auth login`), and the credential stays wherever Claude Code keeps it.
//!
//! The pure parts (candidate paths, status parsing, error wording) are separate from process
//! spawning so they can be unit-tested without a real install.

use crate::error::{AppError, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const INSTALL_PACKAGE: &str = "@anthropic-ai/claude-code";
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);

// ---------- executable resolution ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Claude,
    Npm,
    Node,
}

/// The environment the resolver looks at. Captured once from the real process, or built by hand
/// in tests. A GUI-launched app may have a shorter PATH than the user's terminal, which is why
/// the well-known install folders are searched as well.
#[derive(Clone, Debug, Default)]
pub struct SearchEnv {
    pub windows: bool,
    pub path: Option<OsString>,
    pub appdata: Option<PathBuf>,
    pub userprofile: Option<PathBuf>,
    pub program_files: Option<PathBuf>,
    pub program_files_x86: Option<PathBuf>,
}

impl SearchEnv {
    pub fn from_process() -> Self {
        let p = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        SearchEnv {
            windows: cfg!(windows),
            path: std::env::var_os("PATH"),
            appdata: p("APPDATA"),
            userprofile: p("USERPROFILE").or_else(|| p("HOME")),
            program_files: p("ProgramFiles"),
            program_files_x86: p("ProgramFiles(x86)"),
        }
    }
}

/// Every place `tool` might live, in priority order: PATH first (respects the user's own
/// setup), then well-known install folders. On Windows only `.exe` and `.cmd` are listed,
/// because `std::process::Command` can run those directly (it cannot run `.ps1` or the
/// extensionless shell shim npm also writes).
pub fn candidate_paths(tool: Tool, env: &SearchEnv) -> Vec<PathBuf> {
    let names: &[&str] = match (tool, env.windows) {
        (Tool::Claude, true) => &["claude.exe", "claude.cmd"],
        (Tool::Npm, true) => &["npm.cmd", "npm.exe"],
        (Tool::Node, true) => &["node.exe"],
        (Tool::Claude, false) => &["claude"],
        (Tool::Npm, false) => &["npm"],
        (Tool::Node, false) => &["node"],
    };
    let mut out = Vec::new();
    if let Some(path) = &env.path {
        for dir in std::env::split_paths(path) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            for n in names {
                out.push(dir.join(n));
            }
        }
    }
    let mut extra_dirs: Vec<PathBuf> = Vec::new();
    if env.windows {
        match tool {
            Tool::Claude => {
                // Native installer (`irm https://claude.ai/install.ps1 | iex`).
                if let Some(home) = &env.userprofile {
                    extra_dirs.push(home.join(".local").join("bin"));
                }
                // `npm install -g` with the default prefix.
                if let Some(appdata) = &env.appdata {
                    extra_dirs.push(appdata.join("npm"));
                }
            }
            Tool::Npm | Tool::Node => {
                for pf in [&env.program_files, &env.program_files_x86].into_iter().flatten() {
                    extra_dirs.push(pf.join("nodejs"));
                }
                if tool == Tool::Npm {
                    if let Some(appdata) = &env.appdata {
                        extra_dirs.push(appdata.join("npm"));
                    }
                }
            }
        }
    } else {
        if let Some(home) = &env.userprofile {
            if tool == Tool::Claude {
                extra_dirs.push(home.join(".local").join("bin"));
                extra_dirs.push(home.join(".claude").join("local"));
            }
            extra_dirs.push(home.join(".npm-global").join("bin"));
        }
        extra_dirs.push(PathBuf::from("/usr/local/bin"));
        extra_dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    for dir in extra_dirs {
        for n in names {
            let c = dir.join(n);
            if !out.contains(&c) {
                out.push(c);
            }
        }
    }
    out
}

pub fn resolve_with(tool: Tool, env: &SearchEnv, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidate_paths(tool, env).into_iter().find(|p| exists(p))
}

pub fn resolve(tool: Tool) -> Option<PathBuf> {
    resolve_with(tool, &SearchEnv::from_process(), |p| p.is_file())
}

/// A one-line description of where we looked, for the "not found" message.
pub fn searched_locations(tool: Tool, windows: bool) -> &'static str {
    match (tool, windows) {
        (Tool::Claude, true) => r"PATH, %USERPROFILE%\.local\bin (native installer) and %APPDATA%\npm (npm install)",
        (Tool::Claude, false) => "PATH, ~/.local/bin, ~/.claude/local, ~/.npm-global/bin, /usr/local/bin and /opt/homebrew/bin",
        (Tool::Npm | Tool::Node, true) => r"PATH and %ProgramFiles%\nodejs",
        (Tool::Npm | Tool::Node, false) => "PATH, /usr/local/bin and /opt/homebrew/bin",
    }
}

/// PATH for children: the folders of the tools we resolved go first, so e.g. `claude.cmd`
/// (which calls `node`) works even when the app's own PATH lacks the Node.js folder.
fn child_path(extra: &[&Path]) -> OsString {
    let mut dirs: Vec<PathBuf> = extra.iter().filter_map(|p| p.parent().map(Path::to_path_buf)).collect();
    if let Some(node) = resolve(Tool::Node) {
        if let Some(d) = node.parent() {
            dirs.push(d.to_path_buf());
        }
    }
    if let Some(cur) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&cur));
    }
    dirs.dedup();
    std::env::join_paths(dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// Builds a Command that never flashes a console window on Windows (Dreamer is a GUI app; in
/// release builds every console child would otherwise pop up its own black window).
pub fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", child_path(&[program]));
    hide_window(&mut cmd);
    cmd
}

#[cfg(windows)]
pub fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_window(_cmd: &mut Command) {}

// ---------- output parsing ----------

/// Removes ANSI escape sequences (colors, cursor moves) so CLI output reads cleanly in the panel.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    // CSI: parameters, then one final byte in @..~
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    // OSC: until BEL or ESC \
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// `claude --version` prints e.g. `2.1.322 (Claude Code)`.
pub fn parse_version(stdout: &str) -> Option<String> {
    let line = strip_ansi(stdout).lines().map(str::trim).find(|l| !l.is_empty())?.to_string();
    Some(line)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthInfo {
    pub logged_in: bool,
    pub auth_method: Option<String>,
}

/// Parses `claude auth status` (JSON by default: `{"loggedIn": true, "authMethod": "claude.ai", ...}`).
/// Falls back to the human-readable text form. `None` means "couldn't tell", which the UI treats
/// as "probably fine" rather than blocking the chat on a parsing problem.
pub fn parse_auth_status(stdout: &str) -> Option<AuthInfo> {
    let clean = strip_ansi(stdout);
    if let Some(start) = clean.find('{') {
        if let Some(end) = clean.rfind('}') {
            if let Ok(v) = serde_json::from_str::<Value>(&clean[start..=end]) {
                if let Some(logged_in) = v.get("loggedIn").and_then(Value::as_bool) {
                    let auth_method = v.get("authMethod").and_then(Value::as_str).filter(|s| !s.is_empty() && *s != "none").map(str::to_string);
                    return Some(AuthInfo { logged_in, auth_method });
                }
            }
        }
    }
    let lower = clean.to_lowercase();
    if ["not logged in", "not signed in", "logged out", "not authenticated"].iter().any(|p| lower.contains(p)) {
        return Some(AuthInfo { logged_in: false, auth_method: None });
    }
    if ["logged in", "signed in"].iter().any(|p| lower.contains(p)) {
        return Some(AuthInfo { logged_in: true, auth_method: None });
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Install,
    Login,
}

const NETWORK_MARKERS: &[&str] =
    &["enotfound", "eai_again", "econnrefused", "econnreset", "etimedout", "getaddrinfo", "network", "fetch failed", "socket hang up", "unable to connect", "could not resolve"];

/// Turns a failed job's output into one sentence a person can act on.
pub fn describe_failure(kind: JobKind, output: &str) -> String {
    let lower = strip_ansi(output).to_lowercase();
    if NETWORK_MARKERS.iter().any(|m| lower.contains(m)) {
        return "Couldn't reach the internet. Check your connection (or proxy/VPN) and try again.".into();
    }
    match kind {
        JobKind::Install => {
            if lower.contains("eacces") || lower.contains("eperm") || lower.contains("permission denied") {
                return "npm doesn't have permission to install global packages here. Try again from an administrator terminal, or set a user npm prefix.".into();
            }
            if lower.contains("engine") && lower.contains("node") {
                return "Your Node.js version is too old for Claude Code. Update Node.js from nodejs.org and try again.".into();
            }
        }
        JobKind::Login => {
            if lower.contains("cancel") || lower.contains("denied") || lower.contains("aborted") {
                return "Sign-in was cancelled.".into();
            }
            if lower.contains("timed out") || lower.contains("timeout") {
                return "Sign-in timed out waiting for the browser. Try again.".into();
            }
        }
    }
    let last = strip_ansi(output).lines().map(str::trim).filter(|l| !l.is_empty()).last().map(str::to_string);
    let what = match kind {
        JobKind::Install => "Install didn't finish",
        JobKind::Login => "Sign-in didn't finish",
    };
    match last {
        Some(l) => format!("{what}: {l}"),
        None => format!("{what}."),
    }
}

/// Picks a sign-in URL out of a line of `claude auth login` output, so the panel can offer it
/// as a fallback if the browser did not open by itself. Only Anthropic hosts are accepted.
pub fn find_login_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..].chars().take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'' && *c != '>').collect();
    is_anthropic_url(&url).then_some(url)
}

pub fn is_anthropic_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").split(':').next().unwrap_or("").to_ascii_lowercase();
    ["claude.ai", "claude.com", "anthropic.com"].iter().any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

// ---------- status ----------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub installed: bool,
    pub version: Option<String>,
    /// Full path of the `claude` executable that was found.
    pub path: Option<String>,
    /// `None` when the login state could not be determined (e.g. an old Claude Code without
    /// `auth status`); the UI then lets the chat try rather than blocking it.
    pub logged_in: Option<bool>,
    pub auth_method: Option<String>,
    /// A human-readable explanation when something is missing or broken.
    pub error: Option<String>,
    /// Which setup job is running right now, if any.
    pub job: Option<JobKind>,
}

/// Runs a command to completion with a timeout, capturing stdout+stderr.
fn run_capture(mut cmd: Command, timeout: Duration) -> std::io::Result<(bool, String, String)> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut so = child.stdout.take().expect("piped stdout");
    let mut se = child.stderr.take().expect("piped stderr");
    let t1 = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = so.read_to_string(&mut s);
        s
    });
    let t2 = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = se.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break Some(st);
        }
        if start.elapsed() > timeout {
            kill_tree(&mut child);
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let out = t1.join().unwrap_or_default();
    let err = t2.join().unwrap_or_default();
    match status {
        Some(st) => Ok((st.success(), out, err)),
        None => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out")),
    }
}

pub fn check_status() -> ClaudeStatus {
    let Some(path) = resolve(Tool::Claude) else {
        return ClaudeStatus {
            error: Some(format!("Claude Code was not found. Looked in {}.", searched_locations(Tool::Claude, cfg!(windows)))),
            ..Default::default()
        };
    };
    let path_str = path.display().to_string();
    let mut v = command(&path);
    v.arg("--version");
    let version = match run_capture(v, STATUS_TIMEOUT) {
        Ok((true, out, _)) => parse_version(&out),
        Ok((false, out, err)) => {
            let detail = parse_version(&err).or_else(|| parse_version(&out)).unwrap_or_else(|| "it exited with an error".into());
            return ClaudeStatus { path: Some(path_str.clone()), error: Some(format!("Found {path_str}, but it failed to run: {detail}")), ..Default::default() };
        }
        Err(e) => {
            return ClaudeStatus { path: Some(path_str.clone()), error: Some(format!("Found {path_str}, but it could not be started: {e}")), ..Default::default() };
        }
    };
    let mut s = command(&path);
    s.args(["auth", "status", "--json"]);
    let auth = match run_capture(s, STATUS_TIMEOUT) {
        // A signed-out status may exit non-zero; parse either stream regardless.
        Ok((_, out, err)) => parse_auth_status(&out).or_else(|| parse_auth_status(&err)),
        Err(_) => None,
    };
    ClaudeStatus {
        installed: true,
        version,
        path: Some(path_str),
        logged_in: auth.as_ref().map(|a| a.logged_in),
        auth_method: auth.and_then(|a| a.auth_method),
        error: None,
        job: None,
    }
}

// ---------- jobs (install / login) ----------

#[derive(Default)]
pub struct SetupState {
    job: Arc<Mutex<Option<RunningJob>>>,
    /// Last observed "ready" (installed and signed in); used to restart the sidecar when it flips.
    last_ready: Mutex<Option<bool>>,
}

struct RunningJob {
    kind: JobKind,
    cancel: Arc<AtomicBool>,
}

impl SetupState {
    pub fn running(&self) -> Option<JobKind> {
        self.job.lock().ok().and_then(|g| g.as_ref().map(|j| j.kind))
    }

    /// Records readiness; returns true when it just changed from not-ready to ready.
    pub fn note_ready(&self, ready: bool) -> bool {
        let Ok(mut last) = self.last_ready.lock() else { return false };
        let became_ready = ready && *last != Some(true) && last.is_some();
        *last = Some(ready);
        became_ready
    }

    pub fn cancel(&self) {
        if let Ok(g) = self.job.lock() {
            if let Some(j) = g.as_ref() {
                j.cancel.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// Kills a child and, on Windows, its whole process tree (`claude.cmd`/`npm.cmd` run under
/// `cmd.exe`, so killing only the direct child would leave Node running).
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut tk = Command::new("taskkill");
        tk.args(["/PID", &child.id().to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut tk);
        let _ = tk.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("claude-setup", payload);
}

/// Spawns a job and streams its output as `claude-setup` events:
/// `{type:"output", kind, line}`, `{type:"url", kind, url}`, and finally
/// `{type:"done", kind, ok, cancelled, message}`.
fn start_job(app: &AppHandle, setup: &SetupState, kind: JobKind, mut cmd: Command) -> Result<()> {
    let mut guard = setup.job.lock().map_err(|_| AppError::Invalid("setup lock poisoned".into()))?;
    if let Some(j) = guard.as_ref() {
        return Err(AppError::Invalid(match j.kind {
            JobKind::Install => "Claude Code is still being installed.".into(),
            JobKind::Login => "A sign-in is already waiting for the browser.".into(),
        }));
    }
    // stdin stays open (piped, never written) for the job's lifetime: some CLIs treat a closed
    // stdin as "user aborted".
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| AppError::io(format!("start the {}", if kind == JobKind::Install { "installer" } else { "sign-in" }), e))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let cancel = Arc::new(AtomicBool::new(false));
    *guard = Some(RunningJob { kind, cancel: cancel.clone() });
    drop(guard);

    let log = Arc::new(Mutex::new(String::new()));
    let readers: Vec<_> = [Box::new(stdout) as Box<dyn Read + Send>, Box::new(stderr)]
        .into_iter()
        .map(|stream| {
            let app = app.clone();
            let log = log.clone();
            std::thread::spawn(move || {
                for raw in BufReader::new(stream).lines().map_while(|l| l.ok()) {
                    let line = strip_ansi(&raw);
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(mut l) = log.lock() {
                        l.push_str(&line);
                        l.push('\n');
                    }
                    if kind == JobKind::Login {
                        if let Some(url) = find_login_url(&line) {
                            emit(&app, json!({ "type": "url", "kind": kind, "url": url }));
                        }
                    }
                    emit(&app, json!({ "type": "output", "kind": kind, "line": line }));
                }
            })
        })
        .collect();

    let app = app.clone();
    let job_slot = setup.job.clone();
    std::thread::spawn(move || {
        let _keep_stdin_open = stdin;
        let exit = loop {
            if cancel.load(Ordering::SeqCst) {
                kill_tree(&mut child);
                break None;
            }
            match child.try_wait() {
                Ok(Some(st)) => break Some(st.success()),
                Ok(None) => std::thread::sleep(Duration::from_millis(150)),
                Err(_) => break Some(false),
            }
        };
        for r in readers {
            let _ = r.join();
        }
        let output = log.lock().map(|l| l.clone()).unwrap_or_default();
        let (ok, cancelled, message) = match exit {
            None => (false, true, if kind == JobKind::Login { "Sign-in was cancelled." } else { "Install was cancelled." }.to_string()),
            Some(true) => (true, false, String::new()),
            Some(false) => (false, false, describe_failure(kind, &output)),
        };
        if let Ok(mut g) = job_slot.lock() {
            *g = None;
        }
        if ok && kind == JobKind::Login {
            // The sidecar's long-lived session started before sign-in; restart it lazily so the
            // next chat message picks up the new credential without restarting Dreamer.
            crate::sidecar::shutdown(&app.state::<crate::state::AppState>());
        }
        emit(&app, json!({ "type": "done", "kind": kind, "ok": ok, "cancelled": cancelled, "message": message }));
    });
    Ok(())
}

pub fn start_install(app: &AppHandle, setup: &SetupState) -> Result<()> {
    let Some(npm) = resolve(Tool::Npm) else {
        return Err(AppError::Invalid(format!(
            "npm wasn't found (looked in {}). Install Node.js from https://nodejs.org (it includes npm), then try again.",
            searched_locations(Tool::Npm, cfg!(windows))
        )));
    };
    let mut cmd = command(&npm);
    cmd.args(["install", "-g", INSTALL_PACKAGE]);
    emit(app, json!({ "type": "output", "kind": JobKind::Install, "line": format!("> {} install -g {INSTALL_PACKAGE}", npm.display()) }));
    start_job(app, setup, JobKind::Install, cmd)
}

pub fn start_login(app: &AppHandle, setup: &SetupState) -> Result<()> {
    let Some(claude) = resolve(Tool::Claude) else {
        return Err(AppError::Invalid("Claude Code isn't installed yet, so there's nothing to sign in to. Install it first.".into()));
    };
    let mut cmd = command(&claude);
    cmd.args(["auth", "login"]);
    emit(app, json!({ "type": "output", "kind": JobKind::Login, "line": format!("> {} auth login", claude.display()) }));
    start_job(app, setup, JobKind::Login, cmd)
}

/// Opens a sign-in URL that `claude auth login` printed, in the default browser. Only
/// Anthropic-owned https URLs are accepted, so this can't be used to launch anything else.
pub fn open_login_url(url: &str) -> Result<()> {
    if !is_anthropic_url(url) {
        return Err(AppError::Invalid("refusing to open a non-Anthropic URL".into()));
    }
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    hide_window(&mut cmd);
    cmd.spawn().map_err(|e| AppError::io("open the browser", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn win_env(root: &Path, path_dirs: &[&Path]) -> SearchEnv {
        SearchEnv {
            windows: true,
            path: Some(std::env::join_paths(path_dirs).unwrap()),
            appdata: Some(root.join("AppData").join("Roaming")),
            userprofile: Some(root.join("home")),
            program_files: Some(root.join("Program Files")),
            program_files_x86: None,
        }
    }

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"").unwrap();
    }

    #[test]
    fn resolves_claude_from_path_first() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        touch(&bin.join("claude.exe"));
        touch(&tmp.path().join("AppData/Roaming/npm/claude.cmd"));
        let env = win_env(tmp.path(), &[&bin]);
        assert_eq!(resolve_with(Tool::Claude, &env, Path::is_file), Some(bin.join("claude.exe")));
    }

    #[test]
    fn resolves_claude_from_npm_prefix_when_path_is_short() {
        // A GUI-launched app whose PATH lacks %APPDATA%\npm still finds the npm shim.
        let tmp = tempfile::tempdir().unwrap();
        let empty = tmp.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        let shim = tmp.path().join("AppData").join("Roaming").join("npm").join("claude.cmd");
        touch(&shim);
        // The extensionless shell shim and .ps1 next to it must not be picked.
        touch(&shim.with_file_name("claude"));
        touch(&shim.with_file_name("claude.ps1"));
        let env = win_env(tmp.path(), &[&empty]);
        assert_eq!(resolve_with(Tool::Claude, &env, Path::is_file), Some(shim));
    }

    #[test]
    fn prefers_native_installer_over_npm_shim() {
        let tmp = tempfile::tempdir().unwrap();
        let native = tmp.path().join("home").join(".local").join("bin").join("claude.exe");
        touch(&native);
        touch(&tmp.path().join("AppData/Roaming/npm/claude.cmd"));
        let env = win_env(tmp.path(), &[]);
        assert_eq!(resolve_with(Tool::Claude, &env, Path::is_file), Some(native));
    }

    #[test]
    fn resolves_nothing_when_missing_and_npm_from_program_files() {
        let tmp = tempfile::tempdir().unwrap();
        let env = win_env(tmp.path(), &[]);
        assert_eq!(resolve_with(Tool::Claude, &env, Path::is_file), None);
        let npm = tmp.path().join("Program Files").join("nodejs").join("npm.cmd");
        touch(&npm);
        assert_eq!(resolve_with(Tool::Npm, &env, Path::is_file), Some(npm));
    }

    #[test]
    fn unix_candidates_use_bare_names() {
        let path = std::env::join_paths([Path::new("/a"), Path::new("/b")]).unwrap();
        let env = SearchEnv { windows: false, path: Some(path), userprofile: Some("/home/u".into()), ..Default::default() };
        let c = candidate_paths(Tool::Claude, &env);
        assert_eq!(c[0], Path::new("/a").join("claude"));
        assert!(c.contains(&Path::new("/home/u").join(".local").join("bin").join("claude")));
        assert!(c.iter().all(|p| p.extension().is_none()));
    }

    #[test]
    fn parses_auth_status_json() {
        let out = r#"{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty"}"#;
        assert_eq!(parse_auth_status(out), Some(AuthInfo { logged_in: true, auth_method: Some("claude.ai".into()) }));
        let out = "some warning\n{\n  \"loggedIn\": false,\n  \"authMethod\": \"none\"\n}\n";
        assert_eq!(parse_auth_status(out), Some(AuthInfo { logged_in: false, auth_method: None }));
    }

    #[test]
    fn parses_auth_status_text_fallback() {
        assert_eq!(parse_auth_status("Not logged in. Run claude auth login.").map(|a| a.logged_in), Some(false));
        assert_eq!(parse_auth_status("\u{1b}[32mLogged in\u{1b}[0m as someone").map(|a| a.logged_in), Some(true));
        assert_eq!(parse_auth_status("error: unknown command 'auth'"), None);
        assert_eq!(parse_auth_status(""), None);
    }

    #[test]
    fn parses_version_and_strips_ansi() {
        assert_eq!(parse_version("2.1.322 (Claude Code)\r\n"), Some("2.1.322 (Claude Code)".into()));
        assert_eq!(strip_ansi("\u{1b}[1;31mred\u{1b}[0m \u{1b}]8;;https://x\u{7}link"), "red link");
        assert_eq!(parse_version("  \n"), None);
    }

    #[test]
    fn describes_failures_in_plain_words() {
        assert!(describe_failure(JobKind::Install, "npm ERR! code ENOTFOUND\nnpm ERR! getaddrinfo ENOTFOUND registry.npmjs.org").contains("internet"));
        assert!(describe_failure(JobKind::Install, "npm ERR! code EACCES").contains("permission"));
        assert!(describe_failure(JobKind::Login, "OAuth error: fetch failed").contains("internet"));
        assert_eq!(describe_failure(JobKind::Login, "Login cancelled by user"), "Sign-in was cancelled.");
        assert_eq!(describe_failure(JobKind::Login, "boom\nsomething odd\n"), "Sign-in didn't finish: something odd");
        assert_eq!(describe_failure(JobKind::Install, ""), "Install didn't finish.");
    }

    #[test]
    fn login_urls_are_limited_to_anthropic_hosts() {
        assert_eq!(
            find_login_url("Browser didn't open? Use: https://claude.ai/oauth/authorize?code=true&x=1 "),
            Some("https://claude.ai/oauth/authorize?code=true&x=1".into())
        );
        assert_eq!(find_login_url("visit https://console.anthropic.com/login"), Some("https://console.anthropic.com/login".into()));
        assert_eq!(find_login_url("https://evil.example/claude.ai"), None);
        assert_eq!(find_login_url("https://claude.ai.evil.example/x"), None);
        assert!(!is_anthropic_url("http://claude.ai"));
    }

    /// Needs a real Claude Code install: `cargo test -- --ignored live_status --nocapture`.
    #[test]
    #[ignore]
    fn live_status() {
        let s = check_status();
        println!("installed={} version={:?} path={:?} logged_in={:?} method={:?} error={:?}", s.installed, s.version, s.path, s.logged_in, s.auth_method, s.error);
        assert!(s.installed, "{:?}", s.error);
        assert!(s.logged_in.is_some(), "auth status could not be parsed");
    }

    #[test]
    fn ready_transition_fires_once() {
        let s = SetupState::default();
        assert!(!s.note_ready(false));
        assert!(s.note_ready(true));
        assert!(!s.note_ready(true));
        // First observation being "ready" is not a transition (sidecar has nothing stale).
        let s2 = SetupState::default();
        assert!(!s2.note_ready(true));
    }
}
