//! Child process: spawn, stdio, exit handling, watchdog.
use super::*;

pub(super) fn sidecar_script_path(app: &AppHandle) -> Result<PathBuf> {
    // Dev only: the repo's `sidecar/` folder (uses the repo's node_modules).
    #[cfg(debug_assertions)]
    {
        // The reliability harness can run a frozen copy of an older sidecar (before/after runs).
        if let Some(p) = std::env::var_os("DREAMER_SIDECAR_SCRIPT").map(PathBuf::from).filter(|p| p.is_file()) {
            return Ok(p);
        }
        let dev =PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar").join("main.mjs");
        if dev.is_file() {
            return Ok(dev);
        }
    }
    // Release: `src-tauri/sidecar-dist` (script + its own node_modules, built by
    // scripts/build-sidecar.mjs) shipped as the `sidecar` resource.
    if let Ok(dir) = app.path().resource_dir() {
        let res = dir.join("sidecar").join("main.mjs");
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
                    // Token counts, thinking text and heartbeats stream many lines per turn: not worth a log line each.
                    if !matches!(msg.get("type").and_then(Value::as_str), Some("usage" | "thinking_delta" | "alive" | "pong")) {
                        crate::sidecar_log::line(&format!("<- #{generation} {}", crate::sidecar_log::summary(&msg)));
                    }
                    if !seen_by_watchdog(&out_app, &msg) {
                        continue;
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
        watchdog_tick(&mon_app, generation);
    });

    *guard = Some(Sidecar { child, stdin, tree, generation, stderr_tail, stderr_done });
    Ok(())
}

/// Message types worth resending to a respawned sidecar after a broken pipe: each starts work on
/// its own. (A tool_response, interrupt or reset means nothing to a fresh process.)
pub(super) fn resendable(value: &Value) -> Option<String> {
    let kind = value.get("type").and_then(Value::as_str)?;
    let id = match kind {
        "user_message" => value.get("id"),
        "oneshot_start" | "memory_start" => value.get("job"),
        _ => None,
    }?;
    id.as_str().map(str::to_string)
}

pub(super) enum WriteError {
    NotRunning,
    Broken(u64, std::io::Error),
}

pub(super) fn try_write(state: &AppState, value: &Value) -> std::result::Result<u64, WriteError> {
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
pub(super) fn on_exit(app: &AppHandle, generation: u64, reason: &str, keep: Option<&str>) {
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

/// A question form Claude showed goes into the project's asked-questions log (asked.json).
pub(super) fn log_asked(app: &AppHandle, msg: &Value) {
    if msg.get("type").and_then(Value::as_str) != Some("questions") {
        return;
    }
    let Some(turn) = msg.get("turnId").and_then(Value::as_str) else { return };
    let qs: Vec<String> = msg.get("questions").and_then(Value::as_array).into_iter().flatten().filter_map(|q| q.get("question").and_then(Value::as_str).map(str::to_string)).collect();
    let state = app.state::<AppState>();
    let Some((slug, cards)) = state.claude.pending_ctx.lock().ok().and_then(|p| p.get(turn).map(|p| (p.slug.clone(), p.asked_cards.clone()))) else { return };
    let Some(path) = state.ws.lock().ok().and_then(|ws| ws.existing_project_dir(&slug).ok()).map(|d| d.join("asked.json")) else { return };
    let mut log = read_asked(&path);
    crate::ctx::asked_push(&mut log, &qs, &cards);
    let _ = crate::storage::atomic_write(&path, serde_json::to_string(&log).unwrap_or_default().as_bytes());
}

pub(super) fn read_asked(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Fails the chat turns, handoff session and memory passes that were running on a sidecar that is
/// gone, so nothing waits forever. `restarted`: the app stopped it on purpose (not a crash).
pub(super) fn fail_in_flight(app: &AppHandle, generation: u64, code: Option<i32>, tail: &[String], keep: Option<&str>, restarted: bool) {
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
    if let Ok(mut w) = state.claude.watch.lock() {
        w.retain(|_, x| x.generation != generation);
    }
    // Completions waiting on it fail at once (dropping the sender ends their wait).
    if let Ok(mut c) = state.claude.completions.lock() {
        c.clear();
    }
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

/// watchdog already failed, and is dropped (it must not land on a dead or later turn).
pub(super) fn seen_by_watchdog(app: &AppHandle, msg: &Value) -> bool {
    let state = app.state::<AppState>();
    let Some(id) = msg.get("id").and_then(Value::as_str) else { return true };
    if state.claude.dead.lock().map(|d| d.iter().any(|x| x == id)).unwrap_or(false) {
        crate::sidecar_log::line(&format!("dropped late {} for failed turn {id}", msg.get("type").and_then(Value::as_str).unwrap_or("?")));
        return false;
    }
    if let Ok(mut w) = state.claude.watch.lock() {
        let terminal = matches!(msg.get("type").and_then(Value::as_str), Some("message_done" | "error" | "turn_ended"));
        if terminal {
            w.remove(id);
        } else if let Some(x) = w.get_mut(id) {
            x.last = Instant::now();
        }
    }
    true
}

/// Once a second (from the sidecar's monitor thread): fail turns the sidecar went quiet about, and
/// restart a sidecar that does not answer a ping.
pub(super) fn watchdog_tick(app: &AppHandle, generation: u64) {
    let state = app.state::<AppState>();
    let silent: Vec<String> = match state.claude.watch.lock() {
        Ok(w) => w.iter().filter(|(_, x)| x.generation == generation && x.last.elapsed() > SIDECAR_SILENCE).map(|(id, _)| id.clone()).collect(),
        Err(_) => return,
    };
    for id in &silent {
        crate::sidecar_log::line(&format!("watchdog: turn {id} silent for {}s; failing it", SIDECAR_SILENCE.as_secs()));
        if let Ok(mut w) = state.claude.watch.lock() {
            w.remove(id);
        }
        if let Ok(mut d) = state.claude.dead.lock() {
            d.push_back(id.clone());
            while d.len() > 64 {
                d.pop_front();
            }
        }
        if let Ok(mut p) = state.claude.pending_ctx.lock() {
            p.remove(id);
        }
        let text = "Claude's helper stopped responding to this message. Retry to send it again.";
        let _ = app.emit("claude-event", json!({ "type": "error", "id": id, "message": text, "endReason": "stalled" }));
        write_line(&state, &json!({ "type": "abort_turn", "id": id }));
    }
    // A ping after a silent turn: no pong in time means the sidecar is wedged, not just one turn.
    let mut restart = false;
    let mut send_ping: Option<u64> = None;
    if let Ok(mut p) = state.claude.ping.lock() {
        match *p {
            Some((_, at, false)) if at.elapsed() > PING_GRACE => {
                restart = true;
                *p = None;
            }
            Some((_, _, true)) if silent.is_empty() => *p = None,
            _ => {}
        }
        if !silent.is_empty() && p.is_none() && !restart {
            static PINGS: AtomicU64 = AtomicU64::new(0);
            let n = PINGS.fetch_add(1, Ordering::SeqCst) + 1;
            *p = Some((n, Instant::now(), false));
            send_ping = Some(n);
        }
    }
    if let Some(n) = send_ping {
        write_line(&state, &json!({ "type": "ping", "n": n }));
    }
    if restart {
        crate::sidecar_log::line(&format!("watchdog: sidecar #{generation} did not answer a ping; restarting it"));
        on_exit(app, generation, "unresponsive", None);
    }
}
