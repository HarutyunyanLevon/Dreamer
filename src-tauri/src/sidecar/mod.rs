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
    /// The last turn's organize scope (list_tree / propose_organize).
    scope: Mutex<crate::organize::Scope>,
    pub setup: crate::claude_setup::SetupState,
    /// The running handoff session, if any. See handoff.rs.
    pub handoff: Mutex<Option<crate::handoff::Job>>,
    /// Turns in flight: the project snapshot to record once Claude has answered (by turn id).
    pending_ctx: Mutex<std::collections::HashMap<String, PendingCtx>>,
    /// Memory passes (one per project at a time). See memory.rs.
    pub memory: Mutex<crate::memory::Queue>,
    /// Router hysteresis per thread key. See router.rs.
    router: Mutex<std::collections::HashMap<String, crate::router::RouterState>>,
    /// Sidecar turns in flight: when the sidecar last said anything about each (the app's watchdog).
    watch: Mutex<std::collections::HashMap<String, Watch>>,
    /// Turns the app's watchdog gave up on: anything the sidecar still sends for them is dropped.
    dead: Mutex<VecDeque<String>>,
    /// The last ping the watchdog sent (number, when) and whether its pong came back.
    ping: Mutex<Option<(u64, Instant, bool)>>,
    /// One-shot completions waiting for the sidecar's complete_done (the Claude side of organize).
    completions: Mutex<std::collections::HashMap<String, std::sync::mpsc::Sender<Value>>>,
    /// Organize pipelines running in Rust, by turn id (Stop cancels them).
    pipelines: Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
}

/// One sidecar turn the app's watchdog keeps an eye on.
struct Watch {
    generation: u64,
    last: Instant,
}

/// The sidecar sends a heartbeat for the live turn every 10 s and has its own turn watchdog
/// (first model event 60 s, then 45 s between events, tools on their own
/// limits). This one only fires when the sidecar itself has gone quiet about a turn: then the turn
/// fails here, the sidecar is told to drop it, and a sidecar that does not answer a ping is restarted.
const SIDECAR_SILENCE: Duration = Duration::from_secs(40);
const PING_GRACE: Duration = Duration::from_secs(10);

struct PendingCtx {
    /// The sidecar generation this turn was sent to; it fails with that sidecar.
    generation: u64,
    slug: String,
    thread: String,
    ctx: crate::ctx::Ctx,
    /// The cards a grill in this turn is about (card thread + selection), or ["project"]: keys of the asked-questions log.
    asked_cards: Vec<String>,
    /// What the memory pass needs once Claude has answered (None: a fixed chip command, no pass).
    memory: Option<MemoryTurn>,
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
        ClaudeState {
            sidecar: Mutex::new(None),
            generation: AtomicU64::new(0),
            app: OnceLock::new(),
            active_slug: Mutex::new(String::new()),
            selection: Mutex::new(Vec::new()),
            scope: Mutex::new(Default::default()),
            setup: Default::default(),
            handoff: Mutex::new(None),
            pending_ctx: Default::default(),
            memory: Default::default(),
            router: Default::default(),
            watch: Default::default(),
            dead: Default::default(),
            ping: Mutex::new(None),
            completions: Default::default(),
            pipelines: Default::default(),
        }
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

/// One chat turn from the UI.
pub struct Turn {
    pub slug: String,
    pub id: String,
    pub text: String,
    /// Pre-formatted card context (title/body/tags) from the UI.
    pub context: Option<String>,
    /// Chat thread: a card id, or "project".
    pub thread: String,
    /// The organize scope (a frame's cards or the selection; project = every card).
    pub scope: crate::organize::Scope,
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
    /// An organize turn: its scope kind.
    pub organize: Option<String>,
    /// The organize request's own words (the pipeline's instruction), the plan it continues from
    /// (a revision) and whether only that plan's unplaced cards are assigned.
    pub organize_instruction: Option<String>,
    pub organize_prior: Option<Value>,
    pub organize_rest: bool,
    /// An artifact turn (create, regenerate, a suggestion chip, feedback in the artifact's thread):
    /// the artifact id (= its card id). Always runs on Claude, with SpriteCook and the artifact tools.
    pub artifact: Option<String>,
    /// The chat thread an artifact request came from: its last messages go along.
    pub recap_from: Option<String>,
}

/// Messages of the thread an artifact request came from that the artifact turn sees verbatim.
const RECENT_TURNS: usize = 6;

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
    *state.claude.scope.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))? = turn.scope.clone();
    let (settings, frames, file, memory, card) = {
        let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let card = if turn.thread == "project" { None } else { ws.read_card(&turn.slug, &turn.thread).ok() };
        (ws.get_settings().unwrap_or_default(), ws.card_frames(&turn.slug).unwrap_or_default(), ws.load_chat(&turn.slug, &turn.thread).unwrap_or(Value::Null), ws.read_memory(&turn.slug), card)
    };
    let cards = state.with_search(|idx| idx.overview(&turn.slug)).ok().flatten().map(|(name, mut cards)| {
        for c in &mut cards {
            c.frame = frames.get(&c.id).cloned();
        }
        (name, cards)
    });

    // What Claude has seen already (the snapshot saved with the thread) vs. the project now.
    let prev: Option<crate::ctx::Ctx> = file.get("ctx").and_then(|c| serde_json::from_value(c.clone()).ok());
    let mark = card.as_ref().map(|c| crate::ctx::CardMark { id: c.meta.id.clone(), updated: c.meta.updated.clone() });
    let mut now = crate::ctx::snapshot(cards.as_ref().map(|c| c.1.as_slice()).unwrap_or(&[]), memory.as_deref(), mark);
    // A thread with no snapshot yet (older files) just sends the user's words: a delta against
    // nothing would call every card new.
    let block = prev.as_ref().and_then(|p| crate::ctx::delta(p, &now, memory.as_deref(), card.as_ref()));

    // An artifact turn starts with the artifact block (it changes every turn, so both texts carry it).
    let mut turn = turn;
    if let Some(a) = turn.artifact.clone() {
        let block = {
            let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
            crate::artifacts::context_block(&ws, &turn.slug, &a, settings.credit_cap, crate::credentials::spritecook_key().is_some())?
        };
        turn.text = format!("{block}\n\n---\n\n{}", turn.text);
    }
    // Which tier (router.rs).
    let key = thread_key(&turn.slug, &turn.thread);
    let tier = {
        let mut map = state.claude.router.lock().map_err(|_| AppError::Invalid("router lock poisoned".into()))?;
        crate::router::route(map.entry(key.clone()).or_default(), &turn.text, turn.think, turn.pin, settings.model_router)
    };
    // Organize: the chunked pipeline (organize_pipeline.rs). Card count no longer matters: the
    // pipeline works in small batches.
    if turn.organize.is_some() {
        let model = settings.model_chat.clone();
        crate::sidecar_log::line(&format!("route {} kind=organize model={model} rest={}", turn.id, turn.organize_rest));
        let _ = app.emit("claude-event", json!({ "type": "route", "id": turn.id, "model": model }));
        crate::organize_pipeline::spawn(
            app.clone(),
            crate::organize_pipeline::Request {
                turn: turn.id.clone(),
                slug: turn.slug.clone(),
                scope: turn.scope.clone(),
                instruction: turn.organize_instruction.clone().unwrap_or_default(),
                prior: turn.organize_prior.clone(),
                rest: turn.organize_rest,
                model,
            },
        );
        return Ok(());
    }

    // After a compaction, or in a session without history, every related card counts as unseen.
    let compact = crate::ctx::should_compact(&file, settings.compact_tokens);
    // Related cards for this message (retrieval replaces the full card list). A card Claude already
    // got in this session is skipped unless it changed since.
    let seen: std::collections::BTreeMap<String, String> = if compact { Default::default() } else { prev.as_ref().map(|p| p.sent.clone()).unwrap_or_default() };
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
    let card_ctx = turn.context.as_deref().filter(|c| !c.trim().is_empty()).map(|c| crate::ctx::cap_for_claude(&crate::ctx::clean_for_claude(c), crate::ctx::MAX_CARD_CHARS));
    if let Some(c) = &card_ctx {
        parts.push(format!("[This card]\n{c}"));
    }
    // A grill turn says what is settled (the model re-asked answered questions without it): every
    // question asked in this thread with its chosen answer, plus the card's memory lines.
    let project_grill = turn.text.starts_with("/grill-project");
    let grill = turn.question.is_some() || project_grill || turn.text.starts_with("/grill-me");
    let asked_cards: Vec<String> = if project_grill {
        vec!["project".into()]
    } else if turn.thread != "project" {
        std::iter::once(turn.thread.clone()).chain(turn.selection.iter().cloned()).collect()
    } else if turn.selection.is_empty() {
        vec!["project".into()]
    } else {
        turn.selection.clone()
    };
    let asked = grill
        .then(|| {
            let mut rel = asked_cards.clone();
            rel.extend(card.iter().flat_map(|c| c.meta.links.iter().map(|l| l.to.clone())));
            let path = state.ws.lock().ok()?.existing_project_dir(&turn.slug).ok()?.join("asked.json");
            crate::ctx::asked_block(&read_asked(&path), &rel)
        })
        .flatten();
    let answered = grill
        .then(|| {
            let memory = card.as_ref().map_or_else(String::new, |c| {
                // The memory pass adds its lines to the card's pending proposal, not its saved notes.
                let proposed = state.ws.lock().ok().and_then(|ws| ws.read_proposal(&turn.slug, &c.meta.id)).and_then(|p| p.get("body").and_then(Value::as_str).map(str::to_string));
                crate::memory::decisions_of(proposed.as_deref().unwrap_or(&c.body))
            });
            crate::ctx::answered_block(&file, turn.question.as_deref().map(|q| (q, turn.text.as_str())), &memory)
        })
        .flatten();
    if let Some(a) = &answered {
        parts.push(a.clone());
    }
    if let Some(a) = &asked {
        parts.push(a.clone());
    }
    let transcript = crate::ctx::transcript(&file);
    // An artifact requested from a chat thread: that thread's last messages go along.
    let source = turn.recap_from.as_deref().filter(|t| *t != turn.thread).and_then(|t| state.ws.lock().ok().and_then(|ws| ws.load_chat(&turn.slug, t).ok()));
    if let Some(r) = source.as_ref().and_then(|src| crate::ctx::recent_turns(src, RECENT_TURNS)) {
        parts.push(format!("[Last messages of the conversation that asked for this]
{r}"));
    }
    let earlier = if compact { Some(crate::ctx::SUMMARY_SLOT.to_string()) } else { file.get("summary").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string) };
    if let Some(s) = earlier {
        parts.push(format!("[Earlier in this thread]
{s}"));
    }
    if let Some(r) = &related_block {
        parts.push(r.clone());
    }
    let full_text = if parts.is_empty() { turn.text.clone() } else { format!("{}\n\n---\n\n{}", parts.join("\n\n"), turn.text) };
    // A live session gets the change block plus the related cards; the full text above is for a new one.
    let delta_block = [answered.clone(), asked.clone(), block, related_block.clone()].into_iter().flatten().collect::<Vec<_>>();
    let delta_block = (!delta_block.is_empty()).then(|| delta_block.join("\n\n"));
    let delta_text = crate::ctx::with_block(delta_block, &turn.text);

    // Sizes only, never content: what each part of this turn weighs (chars), for diagnosing context bloat.
    let n = |o: Option<&String>| o.map_or(0, |s| s.chars().count());
    crate::sidecar_log::line(&format!(
        "send_message {} thread={} resume={} compact={} chars: memory={} digest={} this_card={} (raw {}) related={} ({} cards) earlier={} answered={} user={} delta_block={} | text={} fullText={}",
        turn.id,
        key,
        turn.resume.is_some(),
        compact,
        n(memory_part.as_ref()),
        n(digest.as_ref()),
        n(card_ctx.as_ref()),
        turn.context.as_deref().map_or(0, |c| c.chars().count()),
        n(related_block.as_ref()),
        fresh.len(),
        file.get("summary").and_then(Value::as_str).map_or(0, |s| s.chars().count()),
        n(answered.as_ref()),
        turn.text.chars().count(),
        delta_text.chars().count().saturating_sub(turn.text.chars().count()),
        delta_text.chars().count(),
        full_text.chars().count(),
    ));
    if let Ok(mut pending) = state.claude.pending_ctx.lock() {
        let generation = state.claude.generation.load(Ordering::SeqCst);
        pending.insert(
            turn.id.clone(),
            PendingCtx { generation, slug: turn.slug.clone(), thread: turn.thread.clone(), ctx: now, asked_cards, memory: turn.memory.then(|| MemoryTurn { user: turn.text.clone(), question: turn.question.clone() }) },
        );
        if let Ok(mut w) = state.claude.watch.lock() {
            w.insert(turn.id.clone(), Watch { generation, last: Instant::now() });
        }
    }
    let model: String = if turn.artifact.is_some() {
        if turn.think { settings.model_deep.clone() } else { settings.model_chat.clone() }
    } else {
        match tier {
            crate::router::Tier::Fast => settings.model_fast.clone(),
            crate::router::Tier::Main => settings.model_chat.clone(),
            crate::router::Tier::Deep => settings.model_deep.clone(),
        }
    };
    crate::sidecar_log::line(&format!("route {} tier={} model={model} pinned={} think={}", turn.id, tier.as_str(), turn.pin.is_some(), turn.think));
    // The chat shows which model the turn runs on before anything streams.
    let _ = app.emit("claude-event", json!({ "type": "route", "id": turn.id, "model": model }));
    let mut msg = json!({
        "type": "user_message", "id": turn.id, "text": delta_text, "fullText": full_text,
        "thread": key, "resume": turn.resume, "model": model, "web": turn.web, "tier": tier.as_str(),
        // A Deep turn (Think, or the pinned Opus tier) always gets the thinking budget.
        "think": turn.think || tier == crate::router::Tier::Deep
    });
    // A router-picked fast turn that fails or comes back empty is retried once on the main model.
    if tier == crate::router::Tier::Fast && turn.pin.is_none() && turn.artifact.is_none() {
        msg["retryModel"] = json!(settings.model_chat);
    }
    if compact {
        msg["compact"] = json!({ "transcript": transcript, "model": settings.model_memory });
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

/// The user's answer to a paused artifact turn's "Generate N more?" confirm.
pub fn credit_answer(state: &AppState, req_id: &str, allow: bool) {
    write_line(state, &json!({ "type": "credit_answer", "reqId": req_id, "allow": allow }));
}

/// Asks the sidecar for the SpriteCook credit balance (a direct MCP call, no Claude); the answer
/// arrives as a `spritecook_balance` claude-event.
pub fn spritecook_balance(app: &AppHandle, state: &AppState) -> Result<()> {
    ensure_started(app, state)?;
    write_line(state, &json!({ "type": "spritecook_balance" }));
    Ok(())
}

/// `hard`: also close the thread's Claude session (Retry after a stall); its next message resumes it.
pub fn interrupt(state: &AppState, hard: bool) -> Result<()> {
    // An organize pipeline running in Rust stops at its next step.
    if let Ok(m) = state.claude.pipelines.lock() {
        for c in m.values() {
            c.store(true, Ordering::SeqCst);
        }
    }
    write_line(state, &json!({ "type": "interrupt", "hard": hard }));
    Ok(())
}

/// Kills the Node child so it never outlives the app.
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


mod process;
mod events;
mod protocol;
pub(crate) use events::{complete, register_pipeline, unregister_pipeline};
pub(crate) use process::{ensure_started, write_line};
pub(crate) use protocol::view_attachment;
use events::*;
use process::*;
use protocol::*;
#[cfg(test)]
mod tests;
