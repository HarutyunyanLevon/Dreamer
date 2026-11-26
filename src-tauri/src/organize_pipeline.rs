//! The organize pipeline: /organize as a few small model calls orchestrated here, instead of one
//! agent turn (list_tree -> propose_organize) that a 9B local model could not finish reliably.
//!
//! 1. Digest: a compact list of the in-scope cards (alias, title, tags, a ~120-char snippet,
//!    links). Pinned cards are listed but stay put.
//! 2. Groups: one call returns 3-8 frame groups (title + one-line purpose) and a tag plan (reuse
//!    existing tags, merge near-duplicates, at most 5 new tags).
//! 3. Assign: cards go to groups in batches of ~12 (group, tags to add / remove). Every id is
//!    validated here; a bad batch gets one retry with the errors listed.
//! 4. Layout: deterministic, in Rust (organize::layout): frames sized to their cards, a grid inside
//!    each, no overlaps, pinned cards untouched.
//! 5. Plan: the existing organize plan format (create_frame, place, retag), validated by
//!    organize::propose_organize, so the preview / Apply / Discard UI works as before.
//!
//! Local steps call Ollama's /api/chat with a JSON-schema format (structured output). "Redo with
//! Claude" / "Finish with Claude" run the same steps on Claude through the sidecar's one-shot
//! completion (no tools). Each step has its own watchdog; the chat shows progress. A batch that
//! still fails after its retry leaves its cards unplaced: the plan is shown as partial, listing
//! them, and nothing escalates by itself.

use crate::ollama::{ChatLimits, LlmError};
use crate::organize::{CardBox, Rect};
use crate::router::Backend;
use crate::state::AppState;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const BATCH: usize = 12;
const SNIPPET: usize = 120;
const MAX_GROUPS: usize = 8;
const MAX_NEW_TAGS: usize = 5;

/// One organize run.
#[derive(Clone, Debug)]
pub struct Request {
    pub turn: String,
    pub slug: String,
    /// The cards the plan works on (project, a frame's cards, or the selection).
    pub scope: crate::organize::Scope,
    pub instruction: String,
    /// A previous plan: "/organize revise" (its groups guide the new ones) or "Retry rest locally"
    /// / "Finish with Claude" (`rest`: only its unplaced cards are assigned, into its groups).
    pub prior: Option<Value>,
    pub rest: bool,
    pub backend: Backend,
    /// The local variant (dreamer-…) or the Claude model.
    pub model: String,
    /// Shown in the chat (the plain Ollama name for a local run).
    pub shown_model: String,
}

#[derive(Clone, Debug)]
struct DCard {
    id: String,
    alias: String,
    title: String,
    tags: Vec<String>,
    snippet: String,
    links: Vec<String>,
    pinned: bool,
    w: f64,
    h: f64,
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct Group {
    id: String,
    title: String,
    purpose: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct TagPlan {
    /// existing tag -> the tag it merges into
    merge: BTreeMap<String, String>,
    new: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct Assigned {
    group: String,
    add: Vec<String>,
    remove: Vec<String>,
}

/// Everything a step sees.
struct Ctx<'a> {
    app: &'a AppHandle,
    req: &'a Request,
    cancel: Arc<AtomicBool>,
    started: Instant,
    steps: usize,
}

fn emit(app: &AppHandle, v: Value) {
    if let Some(t) = v.get("type").and_then(Value::as_str) {
        if t != "alive" {
            crate::sidecar_log::line(&format!("organize -> {}", crate::sidecar_log::summary(&v)));
        }
    }
    let _ = app.emit("claude-event", v);
}

impl Ctx<'_> {
    fn step(&mut self, sid: &str, label: &str, status: &str) {
        self.steps += 1;
        let now = chrono::Utc::now().timestamp_millis();
        let mut step = json!({ "sid": sid, "kind": "tool", "tool": "organize", "label": label, "status": status, "startedAt": now });
        if status != "running" {
            step["endedAt"] = json!(now);
        }
        emit(self.app, json!({ "type": "step", "id": self.req.turn, "step": step }));
    }

    /// One structured model call on the request's backend.
    fn call(&self, system: &str, user: &str, schema: &Value, limits: ChatLimits) -> Result<Value, LlmError> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(LlmError::Failed("stopped".into()));
        }
        let t0 = Instant::now();
        let out = match self.req.backend {
            Backend::Local => crate::ollama::chat_json(&self.req.model, system, user, schema, 0.2, &limits, &self.cancel),
            Backend::Claude => claude_json(self.app, &self.req.model, system, user, schema),
        };
        crate::sidecar_log::line(&format!(
            "organize call turn={} backend={:?} est_prompt_tokens={} ms={} ok={}{}",
            self.req.turn,
            self.req.backend,
            (system.len() + user.len()) / 3,
            t0.elapsed().as_millis(),
            out.is_ok(),
            out.as_ref().err().map(|e| format!(" error=\"{e}\"")).unwrap_or_default()
        ));
        out
    }
}

/// A Claude completion through the sidecar (no tools; its own watchdog there), parsed as JSON.
fn claude_json(app: &AppHandle, model: &str, system: &str, user: &str, schema: &Value) -> Result<Value, LlmError> {
    let state = app.state::<AppState>();
    let prompt = format!("{user}\n\nReply with ONE JSON object and nothing else (no prose, no code fence), matching this JSON schema:\n{schema}");
    let text = crate::sidecar::complete(app, &state, model, system, &prompt).map_err(|e| if e.contains("no activity") || e.contains("no reply") { LlmError::Stalled(e) } else { LlmError::Failed(e) })?;
    let t = text.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t).trim();
    let start = t.find('{').unwrap_or(0);
    let end = t.rfind('}').map(|i| i + 1).unwrap_or(t.len());
    serde_json::from_str(&t[start..end.max(start)]).map_err(|e| LlmError::Failed(format!("Claude's reply was not valid JSON ({e})")))
}

fn snippet(body: &str) -> String {
    let clean = crate::ctx::clean_for_claude(body);
    let one: String = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > SNIPPET { format!("{}…", one.chars().take(SNIPPET).collect::<String>()) } else { one }
}

/// The in-scope cards (live, not ghosts) with their place and size.
fn digest(state: &AppState, slug: &str, scope: &crate::organize::Scope) -> crate::error::Result<(Vec<DCard>, Vec<Rect>, BTreeMap<String, usize>)> {
    let p = state.ws.lock().map_err(|_| crate::error::AppError::Invalid("workspace lock poisoned".into()))?.load_project(slug)?;
    let canvas = p.canvas.clone();
    let by_id: BTreeMap<&str, &crate::model::Card> = p.cards.iter().filter(|c| !c.meta.ghost && scope.has(&c.meta.id)).map(|c| (c.meta.id.as_str(), c)).collect();
    // Reading order of where they sit now: groups keep a familiar order.
    let mut on: Vec<(&String, &crate::model::Pos)> = canvas.cards.iter().filter(|(id, _)| by_id.contains_key(id.as_str())).collect();
    on.sort_by(|a, b| (a.1.y / 100.0).round().total_cmp(&(b.1.y / 100.0).round()).then(a.1.x.total_cmp(&b.1.x)));
    let alias_of: BTreeMap<String, String> = on.iter().enumerate().map(|(i, (id, _))| ((*id).clone(), format!("c{}", i + 1))).collect();
    let mut tags: BTreeMap<String, usize> = BTreeMap::new();
    let cards: Vec<DCard> = on
        .iter()
        .map(|(id, pos)| {
            let c = by_id[id.as_str()];
            for t in &c.meta.tags {
                *tags.entry(t.clone()).or_default() += 1;
            }
            let w = pos.w.unwrap_or(crate::organize::CARD_W);
            DCard {
                id: (*id).clone(),
                alias: alias_of[*id].clone(),
                title: if c.meta.title.trim().is_empty() { "Untitled".into() } else { c.meta.title.trim().chars().take(80).collect() },
                tags: c.meta.tags.clone(),
                snippet: snippet(&c.body),
                links: c.meta.links.iter().filter_map(|l| alias_of.get(&l.to).cloned()).collect(),
                pinned: pos.pinned,
                w,
                h: pos.h.unwrap_or_else(|| crate::organize::estimate_card_h(c, w)),
                x: pos.x,
                y: pos.y,
            }
        })
        .collect();
    // Existing frames stay where they are: new ones are placed around them.
    let frames: Vec<Rect> = canvas.frames.values().map(|f| Rect { x: f.x, y: f.y, w: f.w, h: f.h }).collect();
    Ok((cards, frames, tags))
}

fn card_line(c: &DCard) -> String {
    let tags = if c.tags.is_empty() { "-".to_string() } else { c.tags.join(", ") };
    let links = if c.links.is_empty() { String::new() } else { format!(" · links {}", c.links.join(",")) };
    format!("{} · \"{}\" · tags: {tags}{links}{}", c.alias, c.title.replace('"', "'"), if c.snippet.is_empty() { String::new() } else { format!(" · {}", c.snippet) })
}

fn norm_tag(t: &str) -> String {
    t.trim().trim_start_matches('#').to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect()
}

const GROUPS_SYSTEM: &str = "You organize the idea cards of a game-design board into frames (visual groups on one canvas). Be concrete and terse. Reply with JSON only.";

fn groups_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "groups": { "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string" }, "purpose": { "type": "string" } }, "required": ["title", "purpose"] } },
            "merge": { "type": "array", "items": { "type": "object", "properties": { "from": { "type": "array", "items": { "type": "string" } }, "to": { "type": "string" } }, "required": ["from", "to"] } },
            "new_tags": { "type": "array", "items": { "type": "string" } },
            "rationale": { "type": "string" }
        },
        "required": ["groups", "merge", "new_tags", "rationale"]
    })
}

/// Step 2: frame groups and the tag plan. Validated; one retry with the problems listed.
fn make_groups(cx: &mut Ctx, cards: &[DCard], tags: &BTreeMap<String, usize>) -> Result<(Vec<Group>, TagPlan, String), LlmError> {
    let movable = cards.iter().filter(|c| !c.pinned).count();
    let (lo, hi) = if movable >= 9 { (3, MAX_GROUPS) } else { (1, MAX_GROUPS.min(movable.max(1))) };
    let tag_list = if tags.is_empty() { "(none yet)".to_string() } else { tags.iter().map(|(t, n)| format!("{t} ({n})")).collect::<Vec<_>>().join(", ") };
    let prior = cx.req.prior.as_ref().and_then(|p| p.pointer("/pipeline/groups")).and_then(Value::as_array).map(|g| g.iter().filter_map(|x| x.get("title").and_then(Value::as_str)).collect::<Vec<_>>().join("; "));
    let mut user = format!(
        "Cards on the board ({} total):\n{}\n\nExisting tags (count): {tag_list}\n\nUser's instruction: {}\n",
        cards.len(),
        cards.iter().map(card_line).collect::<Vec<_>>().join("\n"),
        if cx.req.instruction.trim().is_empty() { "organize it into a clear structure" } else { cx.req.instruction.trim() }
    );
    if let Some(p) = prior.filter(|p| !p.is_empty()) {
        user.push_str(&format!("\nThe previous plan had these frames: {p}. Revise them as the instruction asks.\n"));
    }
    user.push_str(&format!(
        "\nTask: propose {lo}-{hi} frames that group these cards by theme or purpose; every card must fit one frame, and each frame should hold several cards. For each frame: a title (1-4 words) and a one-line purpose. \
         Tag plan: \"merge\" lists near-duplicate EXISTING tags to merge (for example fish + fishes -> fish), always into one of the existing tags; \"new_tags\" lists at most {MAX_NEW_TAGS} new tags (lowercase, 1-2 words) only where existing tags do not cover a frame's theme. \"rationale\": one sentence on the idea behind the grouping."
    ));
    let mut errors: Vec<String> = Vec::new();
    for attempt in 0..2 {
        let msg = if errors.is_empty() { user.clone() } else { format!("{user}\n\nYour previous answer had these problems; fix them:\n- {}", errors.join("\n- ")) };
        let v = match cx.call(GROUPS_SYSTEM, &msg, &groups_schema(), ChatLimits::default()) {
            Ok(v) => v,
            Err(e @ LlmError::Stalled(_)) => return Err(e),
            Err(e) if attempt == 0 => {
                errors = vec![e.to_string()];
                continue;
            }
            Err(e) => return Err(e),
        };
        errors.clear();
        let mut groups: Vec<Group> = Vec::new();
        for g in v.get("groups").and_then(Value::as_array).into_iter().flatten() {
            let title: String = g.get("title").and_then(Value::as_str).unwrap_or_default().trim().chars().take(40).collect();
            if title.is_empty() || groups.iter().any(|x| x.title.eq_ignore_ascii_case(&title)) {
                continue;
            }
            let purpose: String = g.get("purpose").and_then(Value::as_str).unwrap_or_default().trim().chars().take(160).collect();
            groups.push(Group { id: format!("g{}", groups.len() + 1), title, purpose });
        }
        groups.truncate(hi);
        if groups.len() < lo {
            errors.push(format!("give between {lo} and {hi} distinct frames (you gave {})", groups.len()));
            continue;
        }
        let mut plan = TagPlan::default();
        for m in v.get("merge").and_then(Value::as_array).into_iter().flatten() {
            let to = norm_tag(m.get("to").and_then(Value::as_str).unwrap_or_default());
            let Some(to) = tags.keys().find(|t| norm_tag(t) == to).cloned() else { continue };
            for f in m.get("from").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                if let Some(from) = tags.keys().find(|t| norm_tag(t) == norm_tag(f)).cloned() {
                    if from != to {
                        plan.merge.insert(from, to.clone());
                    }
                }
            }
        }
        for t in v.get("new_tags").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            let t = norm_tag(t);
            if !t.is_empty() && !tags.keys().any(|x| norm_tag(x) == t) && !plan.new.contains(&t) && plan.new.len() < MAX_NEW_TAGS {
                plan.new.push(t);
            }
        }
        let rationale = v.get("rationale").and_then(Value::as_str).unwrap_or_default().trim().chars().take(400).collect::<String>();
        return Ok((groups, plan, rationale));
    }
    Err(LlmError::Failed(format!("the frame groups were invalid twice ({})", errors.join("; "))))
}

const ASSIGN_SYSTEM: &str = "You place idea cards of a game-design board into the given frames and tidy their tags. Reply with JSON only.";

fn assign_schema(aliases: &[String], groups: &[Group]) -> Value {
    json!({
        "type": "object",
        "properties": {
            "assignments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "card": { "type": "string", "enum": aliases },
                        "group": { "type": "string", "enum": groups.iter().map(|g| g.id.clone()).collect::<Vec<_>>() },
                        "add": { "type": "array", "items": { "type": "string" } },
                        "remove": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["card", "group", "add", "remove"]
                }
            }
        },
        "required": ["assignments"]
    })
}

/// Checks one batch's answer. Ok: the valid entries (tags filtered to the vocabulary); Err: the
/// id problems (missing, duplicate or unknown cards and groups), for the retry.
fn check_batch(v: &Value, batch: &[&DCard], groups: &[Group], vocab: &BTreeSet<String>) -> (BTreeMap<String, Assigned>, Vec<String>) {
    let mut out: BTreeMap<String, Assigned> = BTreeMap::new();
    let mut errors: Vec<String> = Vec::new();
    let by_alias: BTreeMap<&str, &DCard> = batch.iter().map(|c| (c.alias.as_str(), *c)).collect();
    for a in v.get("assignments").and_then(Value::as_array).into_iter().flatten() {
        let alias = a.get("card").and_then(Value::as_str).unwrap_or_default();
        let group = a.get("group").and_then(Value::as_str).unwrap_or_default();
        let Some(c) = by_alias.get(alias) else {
            errors.push(format!("{alias:?} is not one of the cards in this batch"));
            continue;
        };
        if !groups.iter().any(|g| g.id == group) {
            errors.push(format!("{alias}: unknown frame {group:?}"));
            continue;
        }
        if out.contains_key(&c.id) {
            errors.push(format!("{alias} is listed twice"));
            continue;
        }
        let list = |k: &str| a.get(k).and_then(Value::as_array).map(|x| x.iter().filter_map(Value::as_str).map(norm_tag).collect::<Vec<_>>()).unwrap_or_default();
        let have: BTreeSet<String> = c.tags.iter().map(|t| norm_tag(t)).collect();
        let mut add: Vec<String> = list("add").into_iter().filter(|t| vocab.contains(t) && !have.contains(t)).collect();
        add.dedup();
        add.truncate(3);
        let remove: Vec<String> = c.tags.iter().filter(|t| list("remove").contains(&norm_tag(t))).cloned().collect();
        out.insert(c.id.clone(), Assigned { group: group.to_string(), add, remove });
    }
    for c in batch {
        if !out.contains_key(&c.id) {
            errors.push(format!("{} (\"{}\") is missing: every card needs an entry", c.alias, c.title));
        }
    }
    (out, errors)
}

/// Step 3: one batch of cards into the groups; one retry with the errors listed.
fn assign_batch(cx: &mut Ctx, batch: &[&DCard], groups: &[Group], plan: &TagPlan, vocab: &BTreeSet<String>) -> (BTreeMap<String, Assigned>, Option<String>) {
    let frames = groups.iter().map(|g| format!("{} · {} — {}", g.id, g.title, g.purpose)).collect::<Vec<_>>().join("\n");
    let existing: Vec<&String> = vocab.iter().filter(|t| !plan.new.contains(t)).collect();
    let user = format!(
        "Frames:\n{frames}\n\nTags you may add: existing: {}; new: {}\n\nCards to place:\n{}\n\nFor EVERY card above give one entry: the frame it fits best, \"add\": 0-3 tags from the lists above that describe it and it lacks, \"remove\": only tags it has that are clearly wrong for it (usually none).",
        if existing.is_empty() { "(none)".to_string() } else { existing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ") },
        if plan.new.is_empty() { "(none)".to_string() } else { plan.new.join(", ") },
        batch.iter().map(|c| card_line(c)).collect::<Vec<_>>().join("\n")
    );
    let aliases: Vec<String> = batch.iter().map(|c| c.alias.clone()).collect();
    let schema = assign_schema(&aliases, groups);
    let mut best: BTreeMap<String, Assigned> = BTreeMap::new();
    let mut last_err: Option<String> = None;
    let mut errors: Vec<String> = Vec::new();
    for attempt in 0..2 {
        let msg = if errors.is_empty() { user.clone() } else { format!("{user}\n\nYour previous answer had these problems; answer again for every card:\n- {}", errors.join("\n- ")) };
        match cx.call(ASSIGN_SYSTEM, &msg, &schema, ChatLimits::default()) {
            Ok(v) => {
                let (ok, errs) = check_batch(&v, batch, groups, vocab);
                for (k, a) in ok {
                    best.entry(k).or_insert(a);
                }
                if errs.is_empty() || best.len() == batch.len() {
                    return (best, None);
                }
                last_err = Some(errs.join("; "));
                errors = errs;
            }
            Err(e) => {
                last_err = Some(e.to_string());
                if attempt == 0 && matches!(e, LlmError::Failed(_)) {
                    errors = vec![e.to_string()];
                    continue;
                }
                // A stall gets its retry too, but not a third chance.
                if attempt == 0 {
                    continue;
                }
            }
        }
    }
    (best, last_err)
}

/// The previous plan's groups and assignments ("Retry rest" / "Finish with Claude").
fn prior_state(prior: &Value) -> Option<(Vec<Group>, TagPlan, BTreeMap<String, Assigned>, String)> {
    let p = prior.get("pipeline")?;
    let groups: Vec<Group> = serde_json::from_value(p.get("groups")?.clone()).ok()?;
    let plan: TagPlan = serde_json::from_value(p.get("tagPlan").cloned().unwrap_or(json!({}))).unwrap_or_default();
    let assign: BTreeMap<String, Assigned> = serde_json::from_value(p.get("assign").cloned().unwrap_or(json!({}))).unwrap_or_default();
    let rationale = prior.get("rationale").and_then(Value::as_str).unwrap_or_default().to_string();
    Some((groups, plan, assign, rationale))
}

/// Runs the whole pipeline for one organize turn; the chat sees step, organize_proposal and
/// message_done / error events with the turn id, like a sidecar turn.
pub fn spawn(app: AppHandle, req: Request) {
    std::thread::spawn(move || {
        let cancel = Arc::new(AtomicBool::new(false));
        crate::sidecar::register_pipeline(&app, &req.turn, cancel.clone());
        // Heartbeat: the chat's last-resort timer knows this turn is alive while a step runs.
        let done = Arc::new(AtomicBool::new(false));
        {
            let (app, id, done) = (app.clone(), req.turn.clone(), done.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_secs(1));
                    if chrono::Utc::now().timestamp() % 10 == 0 && !done.load(Ordering::SeqCst) {
                        let _ = app.emit("claude-event", json!({ "type": "alive", "id": id, "phase": "organize" }));
                    }
                }
            });
        }
        let mut cx = Ctx { app: &app, req: &req, cancel: cancel.clone(), started: Instant::now(), steps: 0 };
        let outcome = run(&mut cx);
        done.store(true, Ordering::SeqCst);
        crate::sidecar::unregister_pipeline(&app, &req.turn);
        if cancel.load(Ordering::SeqCst) {
            crate::sidecar_log::line(&format!("organize turn={} stopped by the user", req.turn));
            return;
        }
        let ms = cx.started.elapsed().as_millis() as u64;
        let backend = if req.backend == Backend::Local { "local" } else { "claude" };
        match outcome {
            Ok((plan, text)) => {
                let partial = plan.get("partial").and_then(Value::as_bool).unwrap_or(false);
                emit(&app, json!({ "type": "organize_proposal", "id": req.turn, "plan": plan }));
                emit(&app, json!({ "type": "message_done", "id": req.turn, "text": text, "isError": false, "backend": backend, "model": req.shown_model, "durationMs": ms, "endReason": if partial { "partial" } else { "done" } }));
                crate::sidecar_log::line(&format!("turn_end turn={} backend={backend} model={} reason={} kind=organize dur_ms={ms}", req.turn, req.model, if partial { "partial" } else { "done" }));
            }
            Err(e) => {
                let (reason, fallback) = match &e {
                    LlmError::Stalled(_) => ("stalled", "stalled"),
                    LlmError::Failed(_) => ("error", "error"),
                };
                let text = format!("Organize could not finish: {e}.");
                if req.backend == Backend::Local {
                    emit(&app, json!({ "type": "message_done", "id": req.turn, "text": text, "isError": true, "backend": "local", "model": req.shown_model, "fallback": fallback, "endReason": reason, "durationMs": ms }));
                } else {
                    emit(&app, json!({ "type": "error", "id": req.turn, "message": text, "endReason": reason }));
                }
                crate::sidecar_log::line(&format!("turn_end turn={} backend={backend} model={} reason={reason} kind=organize dur_ms={ms} error=\"{e}\"", req.turn, req.model));
            }
        }
    });
}

fn run(cx: &mut Ctx) -> Result<(Value, String), LlmError> {
    let app = cx.app.clone();
    let state = app.state::<AppState>();
    let req = cx.req.clone();
    cx.step("org-digest", "Reading the cards…", "running");
    let (cards, frames_now, tags) = digest(&state, &req.slug, &req.scope).map_err(|e| LlmError::Failed(e.to_string()))?;
    let movable: Vec<&DCard> = cards.iter().filter(|c| !c.pinned).collect();
    cx.step("org-digest", &format!("Read {} cards ({} pinned)", cards.len(), cards.len() - movable.len()), "done");
    if movable.len() < 2 {
        return Err(LlmError::Failed(format!("there is nothing to organize here ({} movable card{})", movable.len(), if movable.len() == 1 { "" } else { "s" })));
    }
    // Groups: new, or the previous plan's (only its unplaced cards are assigned then).
    let prior = req.prior.as_ref().filter(|_| req.rest).and_then(prior_state);
    let (groups, plan, rationale, mut assigned) = match prior {
        Some((g, p, a, r)) => {
            let live: BTreeSet<&str> = cards.iter().map(|c| c.id.as_str()).collect();
            let a: BTreeMap<String, Assigned> = a.into_iter().filter(|(id, _)| live.contains(id.as_str())).collect();
            cx.step("org-groups", &format!("Kept the plan's {} frames", g.len()), "done");
            (g, p, r, a)
        }
        None => {
            cx.step("org-groups", "Grouping…", "running");
            let (g, p, r) = match make_groups(cx, &cards, &tags) {
                Ok(x) => x,
                Err(e) => {
                    cx.step("org-groups", "Grouping failed", "error");
                    return Err(e);
                }
            };
            cx.step("org-groups", &format!("Grouped into {} frames", g.len()), "done");
            (g, p, r, BTreeMap::new())
        }
    };
    let mut vocab: BTreeSet<String> = tags.keys().map(|t| norm_tag(t)).filter(|t| !plan.merge.contains_key(t)).collect();
    vocab.extend(plan.new.iter().cloned());
    // Assign in batches (only cards without a frame yet).
    let todo: Vec<&DCard> = movable.iter().filter(|c| !assigned.contains_key(&c.id)).copied().collect();
    let batches: Vec<&[&DCard]> = todo.chunks(BATCH).collect();
    let mut problems: Vec<String> = Vec::new();
    for (i, b) in batches.iter().enumerate() {
        let sid = format!("org-assign-{}", i + 1);
        cx.step(&sid, &format!("Assigning {}/{}…", i + 1, batches.len()), "running");
        let (got, err) = assign_batch(cx, b, &groups, &plan, &vocab);
        let n = got.len();
        assigned.extend(got);
        match err.filter(|_| n < b.len()) {
            Some(e) => {
                cx.step(&sid, &format!("Assigned {n}/{} of batch {}", b.len(), i + 1), "error");
                problems.push(e);
            }
            None => cx.step(&sid, &format!("Assigned batch {}/{}", i + 1, batches.len()), "done"),
        }
        if cx.cancel.load(Ordering::SeqCst) {
            return Err(LlmError::Failed("stopped".into()));
        }
    }
    if assigned.is_empty() {
        return Err(LlmError::Failed(format!("no card could be placed ({})", problems.join("; "))));
    }
    // Layout, deterministic.
    cx.step("org-layout", "Laying out…", "running");
    let unplaced: Vec<&DCard> = movable.iter().filter(|c| !assigned.contains_key(&c.id)).copied().collect();
    let members: Vec<Vec<&DCard>> = groups.iter().map(|g| movable.iter().filter(|c| assigned.get(&c.id).is_some_and(|a| a.group == g.id)).copied().collect()).collect();
    let used: Vec<(usize, &Group)> = groups.iter().enumerate().filter(|(i, _)| !members[*i].is_empty()).collect();
    let boxes: Vec<Vec<CardBox>> = used.iter().map(|(i, _)| members[*i].iter().map(|c| CardBox { id: c.id.clone(), w: c.w, h: c.h }).collect()).collect();
    let loose: Vec<CardBox> = unplaced.iter().map(|c| CardBox { id: c.id.clone(), w: c.w, h: c.h }).collect();
    let mut obstacles: Vec<Rect> = cards.iter().filter(|c| c.pinned).map(|c| Rect { x: c.x, y: c.y, w: c.w, h: c.h }).collect();
    obstacles.extend(frames_now);
    let origin = (movable.iter().map(|c| c.x).fold(f64::INFINITY, f64::min).round(), movable.iter().map(|c| c.y).fold(f64::INFINITY, f64::min).round());
    let (rects, pos) = crate::organize::layout(&boxes, &loose, &obstacles, origin);
    cx.step("org-layout", &format!("Laid out {} frames", rects.len()), "done");
    // The plan, in the existing format.
    let mut ops: Vec<Value> = Vec::new();
    for ((_, g), r) in used.iter().zip(rects.iter()) {
        ops.push(json!({ "op": "create_frame", "tempId": format!("org-{}", g.id), "title": g.title, "rect": { "x": r.x, "y": r.y, "w": r.w, "h": r.h } }));
    }
    let positions: serde_json::Map<String, Value> = pos.iter().map(|(id, (x, y))| (id.clone(), json!({ "x": x, "y": y }))).collect();
    ops.push(json!({ "op": "place", "positions": positions }));
    let mut retags = 0;
    for c in &cards {
        // Merges apply to every card that has the merged tag (pinned ones too: tags are not positions).
        let mut add: Vec<String> = Vec::new();
        let mut remove: Vec<String> = Vec::new();
        for t in &c.tags {
            if let Some(to) = plan.merge.get(&norm_tag(t)).or_else(|| plan.merge.get(t)) {
                remove.push(t.clone());
                if !c.tags.iter().any(|x| norm_tag(x) == norm_tag(to)) {
                    add.push(to.clone());
                }
            }
        }
        if let Some(a) = assigned.get(&c.id) {
            for t in &a.add {
                if !add.contains(t) && !c.tags.iter().any(|x| norm_tag(x) == *t) {
                    add.push(t.clone());
                }
            }
            for t in &a.remove {
                if !remove.contains(t) {
                    remove.push(t.clone());
                }
            }
        }
        add.retain(|t| !remove.contains(t));
        if !add.is_empty() || !remove.is_empty() {
            retags += 1;
            ops.push(json!({ "op": "retag", "id": c.id, "add": add, "remove": remove }));
        }
    }
    let partial = !unplaced.is_empty();
    let rationale = if rationale.trim().is_empty() { format!("{} frames by theme.", used.len()) } else { rationale };
    let input = json!({
        "scope": req.scope.kind,
        "rationale": rationale,
        "ops": ops,
        "partial": partial,
        "unplaced": unplaced.iter().map(|c| json!({ "id": c.id, "title": c.title })).collect::<Vec<_>>(),
        "pipeline": {
            "groups": groups,
            "tagPlan": plan,
            "assign": assigned,
            "backend": if req.backend == Backend::Local { "local" } else { "claude" },
            "problems": problems,
        },
    });
    let plan_v = crate::organize::propose_organize(&state, &req.slug, &req.scope, &input).map_err(|e| LlmError::Failed(format!("the plan did not validate: {e}")))?;
    let text = if partial {
        format!("Placed {} of {} cards in {} frames ({retags} retags); {} could not be placed.", assigned.len(), movable.len(), used.len(), unplaced.len())
    } else {
        format!("Proposed {} frames for {} cards, with {retags} retags.", used.len(), movable.len())
    };
    Ok((plan_v, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dc(alias: &str, tags: &[&str]) -> DCard {
        DCard { id: format!("ID{alias}"), alias: alias.into(), title: alias.into(), tags: tags.iter().map(|t| t.to_string()).collect(), snippet: String::new(), links: vec![], pinned: false, w: 236.0, h: 150.0, x: 0.0, y: 0.0 }
    }

    #[test]
    fn a_batch_is_checked_card_by_card() {
        let (a, b, c) = (dc("c1", &["fish"]), dc("c2", &[]), dc("c3", &["boss"]));
        let batch = vec![&a, &b, &c];
        let groups = vec![Group { id: "g1".into(), title: "A".into(), purpose: String::new() }, Group { id: "g2".into(), title: "B".into(), purpose: String::new() }];
        let vocab: BTreeSet<String> = ["fish", "boss", "music"].iter().map(|s| s.to_string()).collect();
        let v = json!({ "assignments": [
            { "card": "c1", "group": "g1", "add": ["Music", "invented"], "remove": ["fish"] },
            { "card": "c1", "group": "g2", "add": [], "remove": [] },
            { "card": "c9", "group": "g1", "add": [], "remove": [] },
            { "card": "c3", "group": "g7", "add": [], "remove": [] }
        ]});
        let (ok, errs) = check_batch(&v, &batch, &groups, &vocab);
        assert_eq!(ok.len(), 1);
        let a1 = &ok["IDc1"];
        assert_eq!((a1.group.as_str(), a1.add.clone(), a1.remove.clone()), ("g1", vec!["music".to_string()], vec!["fish".to_string()]));
        let joined = errs.join(" | ");
        for want in ["c1 is listed twice", "\"c9\" is not one of the cards", "c3: unknown frame", "c2 (\"c2\") is missing"] {
            assert!(joined.contains(want), "{want} not in {joined}");
        }
    }

    #[test]
    fn tags_are_normalized() {
        assert_eq!(norm_tag("  #Boss  Fight "), "boss fight");
    }
}
