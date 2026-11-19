//! Installing Ollama from inside Dreamer, and reading the GPU to pick a model.
//!
//! Install: download Ollama's official Windows installer (GitHub release asset, https only) to a
//! fresh temp folder, check its Authenticode signature (Valid, signed by Ollama Inc.), run it
//! silently (per-user Inno Setup, no UAC), delete it, start the server, then carry on with the
//! model: the recommended one for the GPU is downloaded with the usual pull progress. Every step
//! is an `ollama-setup` event `{type:"install", phase, completed, total}`; a failure ends with the
//! usual `{type:"done", ok:false, message}`.

use crate::error::{AppError, Result};
use crate::ollama::{self, LocalCfg, ModelChoice};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// The latest release's installer. ollama.com/download/OllamaSetup.exe redirects here too.
pub const INSTALLER_URL: &str = "https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe";
/// The organization (O=) of the certificate Ollama signs its installer with.
pub const SIGNER_ORG: &str = "Ollama Inc.";
/// Inno Setup switches: no wizard, no message boxes, no Cancel button. Per-user install (the
/// script says `PrivilegesRequired=lowest`), so no UAC prompt.
pub const SILENT_ARGS: [&str; 4] = ["/VERYSILENT", "/NORMAL", "/SUPPRESSMSGBOXES", "/NOCANCEL"];
/// The installer is ~1.9 GB (it bundles the GPU runtimes).
pub const INSTALLER_SIZE_HINT: u64 = 1_900_000_000;

// ---------- GPU ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    /// Dedicated memory in bytes; None = unknown.
    pub vram: Option<u64>,
    /// "nvidia-smi", "driver" (the display driver's registry entry) or "wmi".
    pub source: &'static str,
}

/// `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` -> (name, MiB) per GPU.
pub fn parse_nvidia_smi(out: &str) -> Vec<(String, u64)> {
    out.lines()
        .filter_map(|l| {
            let (name, mib) = l.trim().rsplit_once(',')?;
            Some((name.trim().to_string(), mib.trim().parse().ok()?))
        })
        .collect()
}

/// Display adapters from two `reg query <class key> /s /v <name>` runs (DriverDesc and
/// HardwareInformation.qwMemorySize), joined by subkey. The driver's 64-bit memory size is the
/// dedicated VRAM (what DXGI reports as DedicatedVideoMemory); a missing size is unknown.
pub fn parse_driver_reg(desc_out: &str, mem_out: &str) -> Vec<(String, Option<u64>)> {
    fn blocks(out: &str, name: &str) -> Vec<(String, String)> {
        let mut key = String::new();
        let mut v = Vec::new();
        for l in out.lines() {
            if l.starts_with("HKEY_") {
                key = l.trim().to_string();
            } else if let Some(d) = ollama::parse_reg_value(l, name) {
                v.push((key.clone(), d));
            }
        }
        v
    }
    let mem = blocks(mem_out, "HardwareInformation.qwMemorySize");
    blocks(desc_out, "DriverDesc")
        .into_iter()
        .filter(|(_, name)| !name.contains("Basic Render") && !name.contains("Basic Display") && !name.contains("Remote Display"))
        .map(|(k, name)| {
            let bytes = mem.iter().find(|(mk, _)| *mk == k).and_then(|(_, d)| {
                let d = d.trim();
                d.strip_prefix("0x").map_or_else(|| d.parse().ok(), |h| u64::from_str_radix(h, 16).ok())
            });
            (name, bytes.filter(|b| *b > 0))
        })
        .collect()
}

/// `Name|AdapterRAM` lines from Win32_VideoController. AdapterRAM is 32-bit: anything near 4 GB
/// is the cap, not the size, so it's unknown (not "small").
pub fn parse_wmi(out: &str) -> Vec<(String, Option<u64>)> {
    out.lines()
        .filter_map(|l| {
            let (name, ram) = l.trim().rsplit_once('|')?;
            let ram: Option<u64> = ram.trim().parse().ok().filter(|r| *r > 0 && *r < 4_000_000_000);
            (!name.trim().is_empty()).then(|| (name.trim().to_string(), ram))
        })
        .collect()
}

/// The GPU with the most memory (a known size beats an unknown one).
pub fn best_gpu(list: Vec<(String, Option<u64>)>, source: &'static str) -> Option<Gpu> {
    list.into_iter().max_by_key(|(_, v)| v.map_or(0, |b| b + 1)).map(|(name, vram)| Gpu { name, vram, source })
}

fn run_out(program: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = crate::claude_setup::command(program);
    cmd.args(args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn nvidia_smi() -> Option<PathBuf> {
    let mut c = vec![PathBuf::from("nvidia-smi")];
    if let Some(w) = std::env::var_os("SystemRoot") {
        c.push(PathBuf::from(w).join("System32").join("nvidia-smi.exe"));
    }
    if let Some(p) = std::env::var_os("ProgramFiles") {
        c.push(PathBuf::from(p).join("NVIDIA Corporation").join("NVSMI").join("nvidia-smi.exe"));
    }
    c.into_iter().find(|p| p.is_file() || p.components().count() == 1)
}

const DISPLAY_CLASS: &str = r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

/// NVIDIA first (nvidia-smi is exact), then any GPU from its driver entry, then WMI.
pub fn detect_gpu() -> Option<Gpu> {
    if !cfg!(windows) {
        return None;
    }
    if let Some(out) = nvidia_smi().and_then(|p| run_out(&p, &["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])) {
        if let Some(g) = best_gpu(parse_nvidia_smi(&out).into_iter().map(|(n, m)| (n, Some(m << 20))).collect(), "nvidia-smi") {
            return Some(g);
        }
    }
    let reg = Path::new("reg");
    if let (Some(d), Some(m)) = (run_out(reg, &["query", DISPLAY_CLASS, "/s", "/v", "DriverDesc"]), run_out(reg, &["query", DISPLAY_CLASS, "/s", "/v", "HardwareInformation.qwMemorySize"])) {
        if let Some(g) = best_gpu(parse_driver_reg(&d, &m), "driver") {
            return Some(g);
        }
    }
    let ps = run_out(Path::new("powershell"), &["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | ForEach-Object { \"$($_.Name)|$($_.AdapterRAM)\" }"])?;
    best_gpu(parse_wmi(&ps), "wmi")
}

/// The detected GPU, read once per run.
pub fn gpu(state: &ollama::OllamaState) -> Option<Gpu> {
    if let Ok(g) = state.gpu.lock() {
        if let Some(v) = g.as_ref() {
            return v.clone();
        }
    }
    let found = detect_gpu();
    if let Ok(mut g) = state.gpu.lock() {
        *g = Some(found.clone());
    }
    found
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub gpu: Option<Gpu>,
    pub recommended: ModelChoice,
    pub choices: Vec<ModelChoice>,
    /// The model in settings, and whether the user picked it (not the untouched default).
    pub current: String,
    pub user_picked: bool,
}

pub fn recommend(state: &ollama::OllamaState, settings: &crate::model::Settings) -> Recommendation {
    let gpu = gpu(state);
    let recommended = ollama::tier_for(gpu.as_ref().and_then(|g| g.vram));
    Recommendation { gpu, recommended, choices: ollama::choices(), current: settings.local_model.clone(), user_picked: settings.local_model != crate::model::DEFAULT_LOCAL_MODEL }
}

// ---------- signature ----------

/// The O= value of an X.500 subject (`CN=Ollama Inc., O=Ollama Inc., L=Toronto, ...`).
pub fn subject_org(subject: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    // Split on commas outside quotes.
    let (mut cur, mut quoted) = (String::new(), false);
    for ch in subject.chars() {
        match ch {
            '"' => quoted = !quoted,
            ',' if !quoted => parts.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    parts.push(cur);
    parts.iter().find_map(|p| p.trim().strip_prefix("O=").map(|o| o.trim().to_string()))
}

/// Whether `Get-AuthenticodeSignature` output (`Status|Subject`) is a valid signature by Ollama.
pub fn signature_ok(ps_out: &str) -> bool {
    let line = ps_out.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let Some((status, subject)) = line.split_once('|') else { return false };
    status.trim() == "Valid" && subject_org(subject).as_deref() == Some(SIGNER_ORG)
}

/// The real verifier: Windows checks the Authenticode chain; we check it's Ollama's certificate.
/// The path goes in through an env var, never into the script text.
pub fn verify_authenticode(file: &Path) -> std::result::Result<(), String> {
    let mut cmd = crate::claude_setup::command(Path::new("powershell"));
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", "$s = Get-AuthenticodeSignature -LiteralPath $env:DREAMER_VERIFY_FILE; \"$($s.Status)|$($s.SignerCertificate.Subject)\""])
        .env("DREAMER_VERIFY_FILE", crate::claude_setup::child_path(file))
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let out = cmd.output().map_err(|e| format!("couldn't run PowerShell: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    if signature_ok(&text) { Ok(()) } else { Err(text.trim().to_string()) }
}

pub const BAD_SIGNATURE: &str = "The installer's signature didn't check out, so Dreamer didn't run it.";

// ---------- install steps ----------

#[derive(Debug, PartialEq)]
pub enum InstallError {
    Cancelled,
    Failed(String),
}

impl InstallError {
    fn message(&self) -> String {
        match self {
            InstallError::Cancelled => "Install cancelled.".into(),
            InstallError::Failed(m) => m.clone(),
        }
    }
}

fn disk_full(e: &std::io::Error) -> bool {
    // ERROR_DISK_FULL (112) / ERROR_HANDLE_DISK_FULL (39) on Windows, ENOSPC (28) elsewhere.
    matches!(e.raw_os_error(), Some(112) | Some(39)) || (cfg!(unix) && e.raw_os_error() == Some(28)) || e.kind() == std::io::ErrorKind::StorageFull
}

const DISK_FULL: &str = "The disk is full: Ollama's installer needs about 2 GB free in the temp folder, and the model needs more. Free some space and try again.";

/// Downloads `url` to `dest`, reporting (completed, total). Redirects must stay on https.
pub fn download(url: &str, dest: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> std::result::Result<(), InstallError> {
    use InstallError::*;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|a| if a.previous().len() > 10 || a.url().scheme() != "https" { a.stop() } else { a.follow() }))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("Dreamer/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| Failed(format!("Couldn't start the download: {e}")))?;
    tauri::async_runtime::block_on(async {
        let resp = client.get(url).send().await.map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                Failed("No internet connection: Dreamer couldn't reach github.com to download Ollama. Check the connection and press Install again.".into())
            } else {
                Failed(format!("The download couldn't start: {e}"))
            }
        })?;
        if !resp.status().is_success() {
            return Err(Failed(format!("The download server answered {}. Try again later, or use Get Ollama for Windows.", resp.status())));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut f = std::fs::File::create(dest).map_err(|e| if disk_full(&e) { Failed(DISK_FULL.into()) } else { Failed(format!("Couldn't save the installer: {e}")) })?;
        let mut done = 0u64;
        let mut resp = resp;
        let mut last = Instant::now() - Duration::from_secs(1);
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(Cancelled);
            }
            let chunk = resp.chunk().await.map_err(|_| Failed("The download was interrupted. Press Install again to retry.".into()))?;
            let Some(chunk) = chunk else { break };
            f.write_all(&chunk).map_err(|e| if disk_full(&e) { Failed(DISK_FULL.into()) } else { Failed(format!("Couldn't save the installer: {e}")) })?;
            done += chunk.len() as u64;
            if last.elapsed() >= Duration::from_millis(200) {
                last = Instant::now();
                progress(done, total);
            }
        }
        f.flush().map_err(|e| if disk_full(&e) { Failed(DISK_FULL.into()) } else { Failed(format!("Couldn't save the installer: {e}")) })?;
        if total > 0 && done != total {
            return Err(Failed("The download was interrupted. Press Install again to retry.".into()));
        }
        progress(done, total);
        Ok(())
    })
}

/// Inno Setup exit codes in plain words.
pub fn describe_exit(code: i32) -> String {
    let why = match code {
        1 => "it couldn't start",
        2 | 5 => "it was cancelled",
        3 => "it failed while getting ready",
        4 => "it failed while installing",
        6 => "it was stopped",
        7 => "it couldn't tell whether it could install",
        8 => "a restart is needed first",
        _ => "it reported an error",
    };
    format!("The Ollama installer stopped with code {code} ({why}). Restart Windows and press Install again, or use Get Ollama for Windows.")
}

/// Verifies the downloaded installer and runs it; the folder holding it is deleted in every case.
/// `verify` and `run` are passed in so tests can stand in for Windows.
pub fn verify_and_run(file: &Path, verify: &dyn Fn(&Path) -> std::result::Result<(), String>, run: &dyn Fn(&Path) -> std::io::Result<i32>, phase: &mut dyn FnMut(&str)) -> std::result::Result<(), InstallError> {
    let cleanup = || {
        let _ = std::fs::remove_file(file);
        if let Some(d) = file.parent() {
            let _ = std::fs::remove_dir(d);
        }
    };
    phase("verify");
    if let Err(detail) = verify(file) {
        crate::sidecar_log::line(&format!("ollama installer signature rejected: {detail}"));
        cleanup();
        return Err(InstallError::Failed(BAD_SIGNATURE.into()));
    }
    phase("run");
    let result = run(file);
    cleanup();
    match result {
        Ok(0) => Ok(()),
        Ok(code) => Err(InstallError::Failed(describe_exit(code))),
        Err(e) => Err(InstallError::Failed(format!("The Ollama installer couldn't be started: {e}"))),
    }
}

fn run_installer(file: &Path) -> std::io::Result<i32> {
    let mut cmd = std::process::Command::new(crate::claude_setup::child_path(file));
    cmd.args(SILENT_ARGS).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let mut child = cmd.spawn()?;
    let until = Instant::now() + Duration::from_secs(15 * 60);
    loop {
        if let Some(s) = child.try_wait()? {
            return Ok(s.code().unwrap_or(-1));
        }
        if Instant::now() > until {
            let _ = child.kill();
            return Err(std::io::Error::other("it didn't finish within 15 minutes"));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// The model to download after an install: the user's own pick from Settings, else the one
/// recommended for this GPU (saved to settings). A cloud recommendation isn't started: it needs
/// `ollama signin` and a yes on the setup screen.
fn model_after_install(app: &AppHandle) -> Option<String> {
    use tauri::Manager;
    let state = app.state::<crate::state::AppState>();
    let settings = state.ws.lock().ok()?.get_settings().ok()?;
    let rec = recommend(&state.ollama, &settings);
    if rec.user_picked {
        return Some(settings.local_model);
    }
    if rec.recommended.cloud {
        return None;
    }
    let m = rec.recommended.model.to_string();
    if m != settings.local_model {
        state.ws.lock().ok()?.update_settings(crate::model::SettingsPatch { local_model: Some(m.clone()), ..Default::default() }).ok()?;
    }
    Some(m)
}

/// Installs Ollama in the background (see the module docs). Cancel works during the download.
pub fn start_install(app: &AppHandle, state: &ollama::OllamaState) -> Result<()> {
    if !cfg!(windows) {
        return Err(AppError::Invalid("Installing Ollama from Dreamer works on Windows only.".into()));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut g = state.install.lock().map_err(|_| AppError::Invalid("ollama lock poisoned".into()))?;
        if g.is_some() {
            return Err(AppError::Invalid("Ollama is already being installed.".into()));
        }
        *g = Some(cancel.clone());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let emit = |v: Value| {
            let _ = app.emit("ollama-setup", v);
        };
        let phase = |p: &str, completed: u64, total: u64| emit(json!({ "type": "install", "phase": p, "completed": completed, "total": total }));
        let result = (|| -> std::result::Result<(), InstallError> {
            phase("download", 0, INSTALLER_SIZE_HINT);
            let dir = std::env::temp_dir().join(format!("dreamer-ollama-{}", ulid::Ulid::generate()));
            std::fs::create_dir_all(&dir).map_err(|e| InstallError::Failed(if disk_full(&e) { DISK_FULL.into() } else { format!("Couldn't make a temp folder: {e}") }))?;
            let file = dir.join("OllamaSetup.exe");
            if let Err(e) = download(INSTALLER_URL, &file, &cancel, &mut |c, t| phase("download", c, t)) {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
            verify_and_run(&file, &verify_authenticode, &run_installer, &mut |p| phase(p, 0, 0))?;
            phase("start", 0, 0);
            let state = ollama::app_state(&app);
            state.clear_cache();
            let exe_dir = {
                use tauri::Manager;
                app.state::<crate::state::AppState>().ws.lock().ok().and_then(|ws| ws.get_settings().ok()).map(|s| LocalCfg::from_settings(&s).exe_dir).unwrap_or_default()
            };
            let addr = ollama::host().addr;
            // The installer launches Ollama's tray app itself; start it when it didn't.
            if !ollama::wait_up(&addr, Duration::from_secs(8)) && !ollama::start_server(&addr, exe_dir.as_deref()) {
                return Err(InstallError::Failed("Ollama is installed, but its server didn't start within 20 s. Start Ollama from the Start menu, then press Check again.".into()));
            }
            Ok(())
        })();
        if let Ok(mut g) = ollama::app_state(&app).install.lock() {
            *g = None;
        }
        if let Err(e) = result {
            let cancelled = e == InstallError::Cancelled;
            emit(json!({ "type": "done", "ok": false, "cancelled": cancelled, "message": e.message() }));
            return;
        }
        // Server up: on to the model (detect GPU -> recommend -> download -> 64k copy).
        match model_after_install(&app) {
            Some(m) => {
                use tauri::Manager;
                let state = app.state::<crate::state::AppState>();
                let cfg = state.ws.lock().ok().and_then(|ws| ws.get_settings().ok()).map(|s| LocalCfg::from_settings(&s)).unwrap_or(LocalCfg { model: m.clone(), ..Default::default() });
                let st = state.ollama.status(&cfg);
                if st.ready || ollama::is_cloud(&m) {
                    emit(json!({ "type": "done", "ok": true, "cancelled": false, "message": "" }));
                } else if let Err(e) = ollama::start_pull(&app, &state.ollama, &m) {
                    emit(json!({ "type": "done", "ok": false, "cancelled": false, "message": e.to_string() }));
                }
            }
            None => emit(json!({ "type": "done", "ok": true, "cancelled": false, "message": "" })),
        }
    });
    Ok(())
}

pub fn cancel_install(state: &ollama::OllamaState) {
    if let Ok(g) = state.install.lock() {
        if let Some(c) = g.as_ref() {
            c.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::{BufRead, BufReader, Read};
    use std::net::TcpListener;

    #[test]
    fn gpu_parsing() {
        assert_eq!(parse_nvidia_smi("NVIDIA GeForce RTX 4080 SUPER, 16376\r\n"), vec![("NVIDIA GeForce RTX 4080 SUPER".into(), 16376)]);
        assert_eq!(parse_nvidia_smi("garbage\n").len(), 0);
        let k0 = r"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000";
        let k1 = r"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0001";
        let desc = format!("\r\n{k0}\r\n    DriverDesc    REG_SZ    AMD Radeon(TM) Graphics\r\n\r\n{k1}\r\n    DriverDesc    REG_SZ    NVIDIA GeForce RTX 4080 SUPER\r\n\r\nEnd of search: 2 match(es) found.\r\n");
        let mem = format!("\r\n{k0}\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x20000000\r\n\r\n{k1}\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x3ff800000\r\n");
        let list = parse_driver_reg(&desc, &mem);
        assert_eq!(list, vec![("AMD Radeon(TM) Graphics".into(), Some(0x2000_0000)), ("NVIDIA GeForce RTX 4080 SUPER".into(), Some(0x3_ff80_0000))]);
        let g = best_gpu(list, "driver").unwrap();
        assert_eq!(g.name, "NVIDIA GeForce RTX 4080 SUPER");
        assert_eq!(ollama::tier_for(g.vram).model, "qwen3.5:9b");
        // AdapterRAM at its 32-bit cap is unknown, not small.
        let w = parse_wmi("AMD Radeon RX 7900 XTX|4293918720\r\nIntel(R) UHD Graphics|1073741824\r\n");
        assert_eq!(w, vec![("AMD Radeon RX 7900 XTX".into(), None), ("Intel(R) UHD Graphics".into(), Some(1_073_741_824))]);
        assert!(ollama::tier_for(best_gpu(w, "wmi").unwrap().vram).cloud);
    }

    #[test]
    fn signer_check() {
        let real = "Valid|CN=Ollama Inc., O=Ollama Inc., L=Toronto, S=Ontario, C=CA, SERIALNUMBER=2713355, OID.2.5.4.15=Private Organization\r\n";
        assert!(signature_ok(real));
        assert!(!signature_ok("NotSigned|"));
        assert!(!signature_ok("HashMismatch|CN=Ollama Inc., O=Ollama Inc., C=CA"));
        assert!(!signature_ok("Valid|CN=Ollama Inc. Fake, O=\"Evil, Ollama Inc.\", C=US"));
        assert!(!signature_ok("Valid|CN=Someone, O=Ollama Inc.x"));
        assert_eq!(subject_org("CN=x, O=\"DigiCert, Inc.\", C=US").as_deref(), Some("DigiCert, Inc."));
    }

    #[test]
    fn bad_signature_is_refused_and_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("dreamer-ollama-x");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("OllamaSetup.exe");
        std::fs::write(&file, b"MZ tampered").unwrap();
        let ran = Cell::new(false);
        let mut phases = Vec::new();
        let r = verify_and_run(&file, &|_| Err("HashMismatch|".into()), &|_| {
            ran.set(true);
            Ok(0)
        }, &mut |p| phases.push(p.to_string()));
        assert_eq!(r, Err(InstallError::Failed(BAD_SIGNATURE.into())));
        assert!(!ran.get(), "a refused installer must not run");
        assert!(!file.exists() && !sub.exists());
        assert_eq!(phases, ["verify"]);

        // A good one runs; its exit code decides; it's deleted either way.
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(&file, b"MZ").unwrap();
        let r = verify_and_run(&file, &|_| Ok(()), &|_| Ok(2), &mut |_| {});
        assert!(matches!(r, Err(InstallError::Failed(m)) if m.contains("code 2")));
        assert!(!file.exists());
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(&file, b"MZ").unwrap();
        assert_eq!(verify_and_run(&file, &|_| Ok(()), &|_| Ok(0), &mut |_| {}), Ok(()));
        assert!(!file.exists());
    }

    /// On a real Windows machine: `DREAMER_INSTALLER=<path to OllamaSetup.exe> cargo test live_ -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_signature_and_gpu() {
        println!("gpu: {:?}", detect_gpu());
        let Ok(p) = std::env::var("DREAMER_INSTALLER") else { return };
        let real = Path::new(&p);
        assert_eq!(verify_authenticode(real), Ok(()));
        // One flipped byte in the middle: Windows reports HashMismatch.
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("OllamaSetup.exe");
        let mut bytes = std::fs::read(real).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xff;
        std::fs::write(&bad, &bytes).unwrap();
        let r = verify_authenticode(&bad);
        println!("tampered: {r:?}");
        assert!(r.is_err());
        std::fs::write(&bad, b"MZ not signed").unwrap();
        assert!(verify_authenticode(&bad).is_err());
    }

    /// Serves one response, optionally cutting the body short.
    fn serve(body: Vec<u8>, claimed: usize) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap().to_string();
        std::thread::spawn(move || {
            if let Some(Ok(mut s)) = l.incoming().next() {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut line = String::new();
                while r.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                    line.clear();
                }
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {claimed}\r\nConnection: close\r\n\r\n");
                let _ = s.write_all(&body);
            }
        });
        format!("http://{addr}/OllamaSetup.exe")
    }

    #[test]
    fn download_complete_interrupted_and_offline() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.exe");
        let no = AtomicBool::new(false);
        let mut seen = (0, 0);
        download(&serve(vec![7; 1000], 1000), &dest, &no, &mut |c, t| seen = (c, t)).unwrap();
        assert_eq!(seen, (1000, 1000));
        let mut f = Vec::new();
        std::fs::File::open(&dest).unwrap().read_to_end(&mut f).unwrap();
        assert_eq!(f.len(), 1000);

        let r = download(&serve(vec![7; 100], 5000), &dest, &no, &mut |_, _| {});
        assert!(matches!(r, Err(InstallError::Failed(m)) if m.contains("interrupted")));

        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let r = download(&format!("http://{closed}/x"), &dest, &no, &mut |_, _| {});
        assert!(matches!(r, Err(InstallError::Failed(m)) if m.contains("No internet")));

        let yes = AtomicBool::new(true);
        assert_eq!(download(&serve(vec![7; 10], 10), &dest, &yes, &mut |_, _| {}), Err(InstallError::Cancelled));
    }
}
