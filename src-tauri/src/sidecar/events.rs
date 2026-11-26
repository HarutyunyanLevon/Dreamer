//! Messages coming from the sidecar, and the organize-pipeline registry.
use super::*;

pub(super) fn handle_sidecar_message(app: &AppHandle, msg: Value) {
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
        Some("complete_done") => {
            let job = msg.get("job").and_then(Value::as_str).unwrap_or_default().to_string();
            if let Some(tx) = app.state::<AppState>().claude.completions.lock().ok().and_then(|mut m| m.remove(&job)) {
                let _ = tx.send(msg);
            }
            return;
        }
        Some("pong") => {
            if let Ok(mut p) = app.state::<AppState>().claude.ping.lock() {
                if let Some(p) = p.as_mut() {
                    p.2 = true;
                }
            }
            return;
        }
        // A turn the sidecar ended without an answer the UI waits for (Stop, superseded, reset).
        Some("turn_ended") => {
            let state = app.state::<AppState>();
            if let Some(id) = msg.get("id").and_then(Value::as_str) {
                if let Ok(mut p) = state.claude.pending_ctx.lock() {
                    p.remove(id);
                }
            }
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
        // Off the thread that reads the sidecar's output: a tool that waits on a lock (or writes a
        // big image reply into stdin) must never stop the stream of every other event.
        let (app, tool) = (app.clone(), tool.to_string());
        std::thread::spawn(move || {
            let state = app.state::<AppState>();
            let result = if tool.starts_with("handoff_") {
                crate::handoff::run_tool(&app, &state, &tool, input)
            } else if matches!(tool.as_str(), "remember" | "forget") {
                crate::memory::run_tool(&app, &state, &tool, input)
            } else {
                run_tool(&state, &tool, input)
            };
            let reply = match result {
                Ok(result) => json!({ "type": "tool_response", "reqId": req_id, "result": result }),
                Err(e) => json!({ "type": "tool_response", "reqId": req_id, "error": e.to_string() }),
            };
            write_line(&state, &reply);
        });
        return;
    }
    if msg.get("type").and_then(Value::as_str) == Some("oneshot_done") {
        // Writing a version copies files: keep that off the thread that streams chat replies.
        let app = app.clone();
        std::thread::spawn(move || crate::handoff::finish(&app, &app.state::<AppState>(), &msg));
        return;
    }
    log_asked(app, &msg);
    record_turn_result(app, &msg);
    let _ = app.emit("claude-event", msg);
}

/// Bookkeeping for the app's watchdog on every sidecar line. False: the line is about a turn the

/// Registers a running organize pipeline (Stop cancels it).
pub(crate) fn register_pipeline(app: &AppHandle, turn: &str, cancel: Arc<AtomicBool>) {
    if let Ok(mut m) = app.state::<AppState>().claude.pipelines.lock() {
        m.insert(turn.to_string(), cancel);
    }
}

pub(crate) fn unregister_pipeline(app: &AppHandle, turn: &str) {
    if let Ok(mut m) = app.state::<AppState>().claude.pipelines.lock() {
        m.remove(turn);
    }
}

/// One Claude completion without tools (the sidecar's complete_start), waited for here. The sidecar
/// has the watchdog; this only backs it up (and fails when the sidecar dies).
pub(crate) fn complete(app: &AppHandle, state: &AppState, model: &str, system: &str, prompt: &str) -> std::result::Result<String, String> {
    ensure_started(app, state).map_err(|e| e.to_string())?;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let job = format!("cmp{}", SEQ.fetch_add(1, Ordering::SeqCst) + 1);
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    state.claude.completions.lock().map_err(|_| "lock poisoned".to_string())?.insert(job.clone(), tx);
    write_line(state, &json!({ "type": "complete_start", "job": job, "system": system, "prompt": prompt, "model": model }));
    let r = rx.recv_timeout(Duration::from_secs(180));
    if let Ok(mut m) = state.claude.completions.lock() {
        m.remove(&job);
    }
    match r {
        Ok(v) if v.get("ok").and_then(Value::as_bool) == Some(true) => Ok(v.get("text").and_then(Value::as_str).unwrap_or_default().to_string()),
        Ok(v) => Err(v.get("error").and_then(Value::as_str).unwrap_or("Claude could not answer").to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            write_line(state, &json!({ "type": "complete_cancel", "job": job }));
            Err("no reply from Claude within 180s".into())
        }
        Err(_) => Err("Claude's helper stopped".into()),
    }
}


/// A handoff job's steps/usage go to the handoff panel (handoff-event); a memory pass's usage becomes
/// the "Updating memory…" line under the chat turn it follows (claude-event memory_progress).
pub(super) fn route_job_activity(app: &AppHandle, msg: Value) {
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
pub(super) fn record_turn_result(app: &AppHandle, msg: &Value) {
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
            pending.get(id).map(|p| (p.slug.clone(), p.thread.clone(), None))
        } else {
            pending.remove(id).map(|p| {
                memory_turn = p.memory;
                (p.slug, p.thread, Some(p.ctx))
            })
        }
    };
    let Some((slug, thread, ctx)) = target else { return };
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
    // An artifact turn: the model, SpriteCook job ids and credits go into the version's meta.json.
    if kind == "message_done" {
        if let Some(a) = msg.get("artifact").filter(|a| a.is_object()) {
            let jobs: Vec<String> = a.get("jobs").and_then(Value::as_array).map(|j| j.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            let credits = a.get("credits").and_then(Value::as_f64).unwrap_or(0.0);
            let model = msg.get("model").and_then(Value::as_str);
            if let Ok(ws) = state.ws.lock() {
                if let Err(e) = crate::artifacts::record_turn(&ws, &slug, &thread, model, &jobs, credits) {
                    crate::sidecar_log::line(&format!("artifact record_turn failed: {e}"));
                }
            }
        }
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
