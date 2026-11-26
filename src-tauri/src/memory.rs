//! Per-project memory: `<project>/memory.md` (what the user decided; never Claude's guesses),
//! its change log `memory.log.jsonl` (Undo and History), and the Haiku "memory pass" that
//! proposes updates after a chat turn.
//!
//! The file is bullet lines under six fixed sections, capped in words (`memory_cap`). Every
//! change (auto, user, claude, seed) is written atomically and logged `{at, source, thread, ops,
//! before, after}`. The watcher reloads it like any other file. A card's own decisions are never
//! written to the card directly: they go into the card's pending proposal (a draft the user keeps
//! or dismisses), see `add_card_decisions`.

use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::storage::{atomic_write, now, Workspace};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

pub const SECTIONS: [&str; 6] = ["Pitch", "Pillars", "Decisions", "Rejected", "Glossary", "How to work with me"];
const PREFIXES: [&str; 6] = ["pitch", "pillar", "decision", "reject", "gloss", "how"];
pub const DEFAULT_CAP: u64 = 600;
const FILE: &str = "memory.md";
const LOG: &str = "memory.log.jsonl";
const CARD_HEADING: &str = "## Decisions";
const REPLY_MAX_CHARS: usize = 3000;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Op {
    pub op: String,
    pub section: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old: Option<String>,
}

pub type Sections = Vec<(String, Vec<String>)>;

// ---------- parsing and rendering ----------

fn canon(name: &str) -> Option<&'static str> {
    let n = name.trim().trim_start_matches('#').trim().to_lowercase();
    PREFIXES.iter().position(|p| n.starts_with(p)).map(|i| SECTIONS[i])
}

fn clean(s: &str) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    t.trim_start_matches(['-', '*', '•']).trim().to_string()
}

fn norm(s: &str) -> String {
    clean(s).to_lowercase()
}

/// memory.md text to sections. Anything that is not a heading becomes a bullet; unknown `##`
/// headings are kept (after the six) so a hand edit is never lost.
pub fn parse(text: &str) -> Sections {
    let mut out: Sections = SECTIONS.iter().map(|s| (s.to_string(), Vec::new())).collect();
    let mut cur = 0usize;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with('#') {
            let level = t.chars().take_while(|c| *c == '#').count();
            if level < 2 {
                continue;
            }
            let name = t.trim_start_matches('#').trim();
            cur = match canon(name) {
                Some(c) => out.iter().position(|(n, _)| n == c).unwrap_or(0),
                None => match out.iter().position(|(n, _)| n.eq_ignore_ascii_case(name)) {
                    Some(i) => i,
                    None => {
                        out.push((name.to_string(), Vec::new()));
                        out.len() - 1
                    }
                },
            };
            continue;
        }
        let b = clean(t);
        if !b.is_empty() {
            out[cur].1.push(b);
        }
    }
    out
}

pub fn render(s: &Sections) -> String {
    let mut out = String::new();
    for (name, items) in s {
        out.push_str(&format!("## {name}\n"));
        for i in items {
            out.push_str(&format!("- {i}\n"));
        }
        out.push('\n');
    }
    out.trim_end().to_string() + "\n"
}

pub fn template() -> String {
    render(&parse(""))
}

pub fn words(s: &Sections) -> usize {
    s.iter().flat_map(|(_, i)| i.iter()).map(|b| b.split_whitespace().count()).sum()
}

pub fn has_bullets(text: &str) -> bool {
    parse(text).iter().any(|(_, i)| !i.is_empty())
}

fn find(items: &[String], what: &str) -> Option<usize> {
    let w = norm(what);
    if w.is_empty() {
        return None;
    }
    if let Some(i) = items.iter().position(|i| norm(i) == w) {
        return Some(i);
    }
    let hits: Vec<usize> = items.iter().enumerate().filter(|(_, i)| norm(i).contains(&w) || (w.len() > 12 && w.contains(&norm(i)))).map(|(k, _)| k).collect();
    (hits.len() == 1).then(|| hits[0])
}

/// Applies the ops; returns only the ones that changed something (duplicates and misses drop out).
pub fn apply_ops(s: &mut Sections, ops: &[Op]) -> Vec<Op> {
    let mut done = Vec::new();
    for op in ops {
        let Some(sec) = canon(&op.section) else { continue };
        let Some(idx) = s.iter().position(|(n, _)| n == sec) else { continue };
        let items = &mut s[idx].1;
        let text = op.text.as_deref().map(clean).filter(|t| !t.is_empty());
        let old = op.old.as_deref().map(clean).filter(|t| !t.is_empty());
        let eff = |kind: &str, text: Option<String>, old: Option<String>| Op { op: kind.into(), section: sec.into(), text, old };
        match op.op.as_str() {
            "add" => {
                if let Some(t) = text {
                    if !items.iter().any(|i| norm(i) == norm(&t)) {
                        items.push(t.clone());
                        done.push(eff("add", Some(t), None));
                    }
                }
            }
            "replace" => {
                let Some(t) = text else { continue };
                match old.as_deref().and_then(|o| find(items, o)) {
                    Some(i) => {
                        if norm(&items[i]) != norm(&t) {
                            let was = std::mem::replace(&mut items[i], t.clone());
                            done.push(eff("replace", Some(t), Some(was)));
                        }
                    }
                    None => {
                        if !items.iter().any(|i| norm(i) == norm(&t)) {
                            items.push(t.clone());
                            done.push(eff("add", Some(t), None));
                        }
                    }
                }
            }
            "remove" => {
                if let Some(o) = old.or(text) {
                    if let Some(i) = find(items, &o) {
                        let was = items.remove(i);
                        done.push(eff("remove", None, Some(was)));
                    }
                }
            }
            _ => {}
        }
    }
    done
}

/// "forget": remove ops for every line (in any section) that matches `what`.
pub fn forget_ops(s: &Sections, what: &str) -> Vec<Op> {
    s.iter()
        .filter_map(|(name, items)| find(items, what).map(|i| Op { op: "remove".into(), section: name.clone(), text: None, old: Some(items[i].clone()) }))
        .collect()
}

// ---------- file and log ----------

pub fn read_raw(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(FILE)).ok()
}

fn at_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn append_log(dir: &Path, entry: &Value) -> Result<()> {
    use std::io::Write;
    let path = dir.join(LOG);
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| AppError::io(format!("open {}", path.display()), e))?;
    writeln!(f, "{entry}").map_err(|e| AppError::io(format!("write {}", path.display()), e))
}

/// Writes memory.md (atomic) and logs the change. `None` when nothing changed. `cap` blocks only
/// growth past the limit, so a consolidating change is always allowed.
fn write(dir: &Path, new: &Sections, ops: Value, source: &str, thread: Option<&str>, cap: Option<u64>) -> Result<Option<String>> {
    let existing = read_raw(dir);
    let before_s = parse(existing.as_deref().unwrap_or(""));
    let before = if existing.as_deref().is_none_or(|t| t.trim().is_empty()) { String::new() } else { render(&before_s) };
    let after = render(new);
    if existing.is_some() && after == before {
        return Ok(None);
    }
    if let Some(cap) = cap {
        let (w, w0) = (words(new) as u64, words(&before_s) as u64);
        if w > cap && w > w0 {
            return Err(AppError::Invalid(format!("project memory is full ({w}/{cap} words): consolidate or forget something first")));
        }
    }
    atomic_write(&dir.join(FILE), after.as_bytes())?;
    let at = at_now();
    append_log(dir, &json!({ "at": at, "source": source, "thread": thread, "ops": ops, "before": before, "after": after }))?;
    Ok(Some(at))
}

/// Applies ops to the file. Returns the log `at` and the ops that took effect.
pub fn apply_to_dir(dir: &Path, ops: &[Op], source: &str, thread: Option<&str>, cap: u64) -> Result<Option<(String, Vec<Op>)>> {
    let mut s = parse(read_raw(dir).as_deref().unwrap_or(""));
    let eff = apply_ops(&mut s, ops);
    if eff.is_empty() {
        return Ok(None);
    }
    Ok(write(dir, &s, json!(eff), source, thread, Some(cap))?.map(|at| (at, eff)))
}

/// The Memory modal's Save (source "user") and the seed's Keep / Start empty (source "seed").
pub fn save_text(dir: &Path, text: &str, source: &str) -> Result<Option<String>> {
    if !matches!(source, "user" | "seed") {
        return Err(AppError::Invalid("unknown memory source".into()));
    }
    write(dir, &parse(text), json!([{ "op": "edit" }]), source, None, None)
}

pub fn history(dir: &Path, limit: usize) -> Vec<Value> {
    let text = std::fs::read_to_string(dir.join(LOG)).unwrap_or_default();
    let mut v: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    v.reverse();
    v.truncate(limit);
    v
}

/// Undoes one log entry line by line: what it added goes, what it removed comes back; edits made
/// since stay. Logged as a "user" change.
pub fn revert(dir: &Path, at: &str) -> Result<Option<String>> {
    let entry = history(dir, usize::MAX).into_iter().find(|e| e["at"].as_str() == Some(at)).ok_or_else(|| AppError::NotFound(format!("memory change {at}")))?;
    let (before, after) = (parse(entry["before"].as_str().unwrap_or("")), parse(entry["after"].as_str().unwrap_or("")));
    let mut cur = parse(read_raw(dir).as_deref().unwrap_or(""));
    let lines = |s: &Sections, name: &str| -> Vec<String> { s.iter().find(|(n, _)| n == name).map(|(_, i)| i.clone()).unwrap_or_default() };
    let names: Vec<String> = after.iter().chain(before.iter()).map(|(n, _)| n.clone()).collect();
    for name in names {
        let (b, a) = (lines(&before, &name), lines(&after, &name));
        let added: Vec<&String> = a.iter().filter(|l| !b.iter().any(|x| norm(x) == norm(l))).collect();
        let removed: Vec<&String> = b.iter().filter(|l| !a.iter().any(|x| norm(x) == norm(l))).collect();
        let idx = match cur.iter().position(|(n, _)| *n == name) {
            Some(i) => i,
            None => {
                cur.push((name.clone(), Vec::new()));
                cur.len() - 1
            }
        };
        for l in added {
            if let Some(p) = cur[idx].1.iter().position(|x| norm(x) == norm(l)) {
                cur[idx].1.remove(p);
            }
        }
        for l in removed {
            if !cur[idx].1.iter().any(|x| norm(x) == norm(l)) {
                cur[idx].1.push(l.clone());
            }
        }
    }
    write(dir, &cur, json!([{ "op": "revert", "at": at }]), "user", None, None)
}

// ---------- a card's own decisions (drafted into its proposal) ----------

fn section_end(ls: &[String], heading: usize) -> usize {
    let mut end = heading + 1;
    while end < ls.len() && !ls[end].trim_start().starts_with('#') {
        end += 1;
    }
    end
}

fn heading_at(ls: &[String]) -> Option<usize> {
    ls.iter().position(|l| l.trim().eq_ignore_ascii_case(CARD_HEADING))
}

/// `body` with the lines added under "## Decisions" (heading created at the end). Also returns the
/// lines that were really new.
pub fn add_decisions(body: &str, lines: &[String]) -> (String, Vec<String>) {
    let mut ls: Vec<String> = body.lines().map(String::from).collect();
    let mut added: Vec<String> = Vec::new();
    for l in lines {
        let c = clean(l);
        if !c.is_empty() && !ls.iter().any(|x| norm(x) == norm(&c)) && !added.iter().any(|x| norm(x) == norm(&c)) {
            added.push(c);
        }
    }
    if added.is_empty() {
        return (body.to_string(), added);
    }
    let new: Vec<String> = added.iter().map(|a| format!("- {a}")).collect();
    match heading_at(&ls) {
        Some(h) => {
            let mut at = section_end(&ls, h);
            while at > h + 1 && ls[at - 1].trim().is_empty() {
                at -= 1;
            }
            for (k, n) in new.into_iter().enumerate() {
                ls.insert(at + k, n);
            }
        }
        None => {
            while ls.last().is_some_and(|l| l.trim().is_empty()) {
                ls.pop();
            }
            if !ls.is_empty() {
                ls.push(String::new());
            }
            ls.push(CARD_HEADING.into());
            ls.push(String::new());
            ls.extend(new);
        }
    }
    (ls.join("\n") + "\n", added)
}

/// The reverse of `add_decisions`: drops the lines, and the heading again if the card itself
/// (`card_body`) never had one.
pub fn remove_decisions(body: &str, lines: &[String], card_body: &str) -> String {
    let mut ls: Vec<String> = body.lines().map(String::from).collect();
    for l in lines {
        let n = norm(l);
        if let Some(p) = ls.iter().rposition(|x| x.trim_start().starts_with('-') && norm(x) == n) {
            ls.remove(p);
        }
    }
    if heading_at(&card_body.lines().map(String::from).collect::<Vec<_>>()).is_none() {
        if let Some(h) = heading_at(&ls) {
            let end = section_end(&ls, h);
            if ls[h + 1..end].iter().all(|l| l.trim().is_empty()) {
                ls.drain(h..end);
            }
        }
    }
    while ls.last().is_some_and(|l| l.trim().is_empty()) {
        ls.pop();
    }
    if ls.is_empty() { String::new() } else { ls.join("\n") + "\n" }
}

/// The "## Decisions" section of a card body (for the memory pass).
pub fn decisions_of(body: &str) -> String {
    let ls: Vec<String> = body.lines().map(String::from).collect();
    heading_at(&ls).map(|h| ls[h + 1..section_end(&ls, h)].join("\n").trim().to_string()).unwrap_or_default()
}

/// Appends decision lines to the card's pending proposal (creating one from the saved body).
/// Returns the lines that were new.
pub fn add_card_decisions(ws: &Workspace, slug: &str, id: &str, lines: &[String]) -> Result<Vec<String>> {
    let card = ws.read_card(slug, id)?;
    let mut p = match ws.read_proposal(slug, id) {
        Some(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    let base = p.get("body").and_then(Value::as_str).map(String::from).unwrap_or(card.body.clone());
    let (body, added) = add_decisions(&base, lines);
    if added.is_empty() {
        return Ok(added);
    }
    p.insert("body".into(), json!(body));
    p.entry("reason").or_insert(json!("Decisions you stated in the chat (project memory)"));
    p.entry("created").or_insert(json!(now()));
    let mut mem: Vec<Value> = p.get("memory_lines").and_then(Value::as_array).cloned().unwrap_or_default();
    mem.extend(added.iter().map(|a| json!(a)));
    p.insert("memory_lines".into(), Value::Array(mem));
    ws.write_proposal(slug, id, &Value::Object(p))?;
    Ok(added)
}

/// Undo for `add_card_decisions`: removes the lines from the proposal; the proposal goes when it
/// no longer changes anything.
pub fn remove_card_decisions(ws: &Workspace, slug: &str, id: &str, lines: &[String]) -> Result<()> {
    let Some(Value::Object(mut p)) = ws.read_proposal(slug, id) else { return Ok(()) };
    let card = ws.read_card(slug, id)?;
    let body = remove_decisions(p.get("body").and_then(Value::as_str).unwrap_or(&card.body), lines, &card.body);
    if body.trim_end() == card.body.trim_end() {
        p.remove("body");
    } else {
        p.insert("body".into(), json!(body));
    }
    if let Some(m) = p.get_mut("memory_lines").and_then(Value::as_array_mut) {
        m.retain(|v| v.as_str().is_none_or(|s| !lines.iter().any(|l| norm(l) == norm(s))));
    }
    let real = ["title", "body", "tags", "stage", "captions"].iter().any(|k| p.contains_key(*k));
    if real { ws.write_proposal(slug, id, &Value::Object(p)) } else { ws.delete_proposal(slug, id) }
}

// ---------- the memory pass (one-shot Haiku query) ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Update,
    Seed,
}

pub struct Pass {
    pub job: String,
    pub kind: Kind,
    pub slug: String,
    pub thread: String,
    /// The chat turn the "Memory updated" line belongs to.
    pub turn: Option<String>,
    pub prompt: String,
    pub model: String,
    /// The card thread's card (id, title): where card_decisions go.
    pub card: Option<(String, String)>,
    pub result: Option<Value>,
}

/// One pass per project at a time; the rest wait here.
#[derive(Default)]
pub struct Queue {
    running: HashMap<String, Pass>,
    waiting: VecDeque<Pass>,
}

fn lock(state: &AppState) -> Option<std::sync::MutexGuard<'_, Queue>> {
    state.claude.memory.lock().ok()
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n).collect::<String>()) }
}

pub struct TurnInfo<'a> {
    pub slug: &'a str,
    pub thread: &'a str,
    pub turn: &'a str,
    pub user: &'a str,
    pub reply: &'a str,
    pub question: Option<&'a str>,
}

fn update_prompt(info: &TurnInfo, memory: &str, cap: u64, card: Option<(&str, &str)>) -> String {
    let mut out = format!("[memory.md] ({} of {cap} words)\n{}\n", words(&parse(memory)), if memory.trim().is_empty() { template() } else { memory.trim().to_string() });
    match card {
        Some((title, decisions)) => out.push_str(&format!("\n[Thread] card \"{title}\"\n[Card's current ## Decisions]\n{}\n", if decisions.is_empty() { "(none)" } else { decisions })),
        None => out.push_str("\n[Thread] project chat (no card)\n"),
    }
    out.push_str(&format!("\n[User's message]\n{}\n", info.user));
    if let Some(q) = info.question {
        out.push_str(&format!("\n[Question Claude asked, and the user's answer is the message above]\n{q}\n"));
    }
    out.push_str(&format!("\n[Claude's reply]\n{}\n\nCall memory_update exactly once.", truncate(info.reply, REPLY_MAX_CHARS)));
    out
}

/// After an answered chat turn: queue a memory pass (the caller already skipped fixed chip commands).
pub fn after_turn(app: &AppHandle, state: &AppState, info: TurnInfo) {
    if info.user.trim().is_empty() {
        return;
    }
    let (settings, memory, card) = {
        let Ok(ws) = state.ws.lock() else { return };
        let card = (info.thread != "project").then(|| ws.read_card(info.slug, info.thread).ok()).flatten().map(|c| {
            let body = ws.read_proposal(info.slug, &c.meta.id).and_then(|p| p.get("body").and_then(Value::as_str).map(String::from)).unwrap_or(c.body.clone());
            (c.meta.id.clone(), c.meta.title.clone(), decisions_of(&body))
        });
        (ws.get_settings().unwrap_or_default(), ws.existing_project_dir(info.slug).ok().and_then(|d| read_raw(&d)).unwrap_or_default(), card)
    };
    let prompt = update_prompt(&info, &memory, settings.memory_cap, card.as_ref().map(|c| (c.1.as_str(), c.2.as_str())));
    submit(
        app,
        state,
        Pass {
            job: format!("m{}", ulid::Ulid::generate()),
            kind: Kind::Update,
            slug: info.slug.into(),
            thread: info.thread.into(),
            turn: Some(info.turn.into()),
            prompt,
            model: settings.model_memory,
            card: card.map(|c| (c.0, c.1)),
            result: None,
        },
    );
}

fn submit(app: &AppHandle, state: &AppState, pass: Pass) {
    let Some(mut q) = lock(state) else { return };
    if q.running.contains_key(&pass.slug) {
        q.waiting.push_back(pass);
    } else {
        start(app, state, &mut q, pass);
    }
}

/// Starts a pass, or drops it when the sidecar can't run (the memory pass never blocks or fails the chat).
fn start(app: &AppHandle, state: &AppState, q: &mut Queue, pass: Pass) {
    if crate::sidecar::ensure_started(app, state).is_err() {
        if pass.kind == Kind::Seed {
            let _ = app.emit("memory-event", json!({ "type": "seed_error", "slug": pass.slug }));
        }
        return;
    }
    let kind = if pass.kind == Kind::Seed { "seed" } else { "update" };
    crate::sidecar::write_line(state, &json!({ "type": "memory_start", "job": pass.job, "kind": kind, "prompt": pass.prompt, "model": pass.model }));
    emit_progress(app, pass.turn.as_deref(), true);
    q.running.insert(pass.slug.clone(), pass);
}

/// "Updating memory…" under the chat turn a pass follows (its token count comes from the sidecar's usage events).
fn emit_progress(app: &AppHandle, turn: Option<&str>, active: bool) {
    if let Some(turn) = turn {
        let _ = app.emit("claude-event", json!({ "type": "memory_progress", "id": turn, "active": active, "input": 0, "output": 0 }));
    }
}

/// Job ids of the passes running now (the sidecar ending fails them all).
pub fn running_jobs(state: &AppState) -> Vec<String> {
    lock(state).map(|q| q.running.values().map(|p| p.job.clone()).collect()).unwrap_or_default()
}

/// The chat turn a running memory pass follows (None for a seed pass or an unknown job).
pub fn turn_of(state: &AppState, job: &str) -> Option<String> {
    lock(state)?.running.values().find(|p| p.job == job).and_then(|p| p.turn.clone())
}

/// The sidecar's `memory_result`: the tool call's input, kept until the pass ends.
pub fn on_result(state: &AppState, job: &str, result: Value) {
    if let Some(mut q) = lock(state) {
        if let Some(p) = q.running.values_mut().find(|p| p.job == job) {
            if p.result.is_none() {
                p.result = Some(result);
            }
        }
    }
}

/// The sidecar's `memory_done`: applies the result, then starts the next waiting pass of that project.
pub fn on_done(app: &AppHandle, job: &str, ok: bool) {
    let state = app.state::<AppState>();
    let pass = {
        let Some(mut q) = lock(&state) else { return };
        let Some(slug) = q.running.iter().find(|(_, p)| p.job == job).map(|(s, _)| s.clone()) else { return };
        let pass = q.running.remove(&slug);
        if let Some(i) = q.waiting.iter().position(|p| p.slug == slug) {
            if let Some(next) = q.waiting.remove(i) {
                start(app, &state, &mut q, next);
            }
        }
        pass
    };
    let Some(pass) = pass else { return };
    emit_progress(app, pass.turn.as_deref(), false);
    match (ok, pass.result.clone()) {
        (true, Some(r)) => {
            if let Err(e) = apply_result(app, &state, &pass, &r) {
                eprintln!("[dreamer] memory pass failed: {e}");
            }
        }
        _ => {
            if pass.kind == Kind::Seed {
                let _ = app.emit("memory-event", json!({ "type": "seed_error", "slug": pass.slug }));
            }
        }
    }
}

fn short(s: &str) -> String {
    truncate(s, 60)
}

fn op_label(o: &Op) -> String {
    match o.op.as_str() {
        "add" => format!("+ {}: {}", o.section, short(o.text.as_deref().unwrap_or(""))),
        "replace" => format!("~ {}: {}", o.section, short(o.text.as_deref().unwrap_or(""))),
        _ => format!("− {}: {}", o.section, short(o.old.as_deref().unwrap_or(""))),
    }
}

/// The chat line's text: "+ Decisions: no PvP · card: + 3 boss phases".
fn label(ops: &[Op], card_lines: &[String]) -> String {
    let mut parts: Vec<String> = ops.iter().map(op_label).collect();
    parts.extend(card_lines.iter().map(|l| format!("card: + {}", short(l))));
    parts.join(" · ")
}

fn emit_update(app: &AppHandle, turn: Option<&str>, ats: &[String], ops: &[Op], card: Option<(&str, &str, &[String])>) {
    let card_lines: &[String] = card.map(|c| c.2).unwrap_or(&[]);
    if (ats.is_empty() && card_lines.is_empty()) || turn.is_none() {
        return;
    }
    let _ = app.emit(
        "claude-event",
        json!({
            "type": "memory_update", "id": turn, "label": label(ops, card_lines), "ats": ats,
            "card": card.filter(|c| !c.2.is_empty()).map(|c| json!({ "id": c.0, "title": c.1, "lines": c.2 })),
        }),
    );
}

fn apply_result(app: &AppHandle, state: &AppState, pass: &Pass, result: &Value) -> Result<()> {
    if pass.kind == Kind::Seed {
        let list = |k: &str| -> Vec<String> { result.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str()).map(clean).filter(|s| !s.is_empty()).collect()).unwrap_or_default() };
        let mut s = parse("");
        for (i, key) in ["pitch", "pillars", "decisions", "rejected", "glossary", "how"].iter().enumerate() {
            s[i].1 = list(key);
        }
        let _ = app.emit("memory-event", json!({ "type": "seed", "slug": pass.slug, "text": render(&s) }));
        return Ok(());
    }
    if result.get("none").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let ops: Vec<Op> = result.get("project_ops").cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let decisions: Vec<String> = result.get("card_decisions").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
    let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
    let cap = ws.get_settings().map(|s| s.memory_cap).unwrap_or(DEFAULT_CAP);
    let dir = ws.existing_project_dir(&pass.slug)?;
    let (ats, eff) = match apply_to_dir(&dir, &ops, "auto", Some(&pass.thread), cap) {
        Ok(Some((at, eff))) => (vec![at], eff),
        Ok(None) => (vec![], vec![]),
        Err(e) => {
            eprintln!("[dreamer] memory pass skipped: {e}");
            (vec![], vec![])
        }
    };
    let added = match (&pass.card, decisions.is_empty()) {
        (Some((id, _)), false) => add_card_decisions(&ws, &pass.slug, id, &decisions).unwrap_or_default(),
        _ => vec![],
    };
    drop(ws);
    emit_update(app, pass.turn.as_deref(), &ats, &eff, pass.card.as_ref().map(|(id, t)| (id.as_str(), t.as_str(), added.as_slice())));
    Ok(())
}

/// Chat tools `remember(text, section?)` and `forget(text)`: applied directly, source "claude".
pub fn run_tool(app: &AppHandle, state: &AppState, tool: &str, input: Value) -> Result<Value> {
    let turn = input.get("turn").and_then(Value::as_str).unwrap_or_default().to_string();
    let (slug, thread) = {
        let q = state.claude.pending_ctx_of(&turn);
        q.ok_or_else(|| AppError::Invalid("no chat turn is running".into()))?
    };
    let text = input.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
    if clean(&text).is_empty() {
        return Err(AppError::Invalid("text is empty".into()));
    }
    let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
    let cap = ws.get_settings().map(|s| s.memory_cap).unwrap_or(DEFAULT_CAP);
    let dir = ws.existing_project_dir(&slug)?;
    let ops = if tool == "remember" {
        let section = input.get("section").and_then(Value::as_str).and_then(canon).unwrap_or("Decisions");
        vec![Op { op: "add".into(), section: section.into(), text: Some(text), old: None }]
    } else {
        let ops = forget_ops(&parse(read_raw(&dir).as_deref().unwrap_or("")), &text);
        if ops.is_empty() {
            return Err(AppError::NotFound("a memory line matching that; nothing was removed".into()));
        }
        ops
    };
    let applied = apply_to_dir(&dir, &ops, "claude", Some(&thread), cap)?;
    drop(ws);
    match applied {
        Some((at, eff)) => {
            emit_update(app, Some(&turn), &[at], &eff, None);
            Ok(json!({ "saved": true, "changes": eff.iter().map(op_label).collect::<Vec<_>>() }))
        }
        None => Ok(json!({ "saved": false, "note": "memory already says this" })),
    }
}

// ---------- bootstrap: one seed query for a project that has no memory yet ----------

fn clip(s: &str, n: usize) -> String {
    truncate(s.trim(), n)
}

/// Starts the seed query (Tech & decisions cards, Dream/Lucid cards, the latest design overview).
/// The draft arrives as a `memory-event` of type "seed"; nothing is written until the user chooses.
pub fn seed(app: &AppHandle, state: &AppState, slug: &str) -> Result<()> {
    crate::storage::check_slug(slug)?;
    let (prompt, model) = {
        let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let dir = ws.existing_project_dir(slug)?;
        if dir.join(FILE).exists() {
            return Err(AppError::Invalid("this project already has a memory".into()));
        }
        let data = ws.load_project(slug)?;
        let kept: Vec<&crate::model::Card> = data.cards.iter().filter(|c| !c.meta.ghost).collect();
        if kept.len() < 3 {
            return Err(AppError::Invalid("a project needs at least 3 kept cards before memory is seeded".into()));
        }
        let mut out = format!("Project \"{}\". Draft its memory from this material only.\n", data.meta.name);
        for (role, name) in [(crate::model::ROLE_TECH, "Tech & constraints card"), (crate::model::ROLE_DECISIONS, "Project decisions card")] {
            if let Some(c) = kept.iter().find(|c| c.meta.role.as_deref() == Some(role)) {
                out.push_str(&format!("\n[{name}] \"{}\"\n{}\n", c.meta.title, clip(&c.body, 2000)));
            }
        }
        out.push_str("\n[Dream and Lucid cards] (title, then the first 400 characters)\n");
        let mut n = 0;
        for c in kept.iter().filter(|c| c.meta.role.is_none() && matches!(c.meta.stage, crate::model::Stage::Dream | crate::model::Stage::Lucid | crate::model::Stage::Built)) {
            out.push_str(&format!("- \"{}\" ({:?}): {}\n", c.meta.title, c.meta.stage, clip(&c.body, 400).replace('\n', " ")));
            n += 1;
        }
        if n == 0 {
            out.push_str("(none)\n");
        }
        out.push_str("\nCall memory_seed exactly once.");
        (out, ws.get_settings().map(|s| s.model_memory).unwrap_or_else(|_| crate::model::DEFAULT_MODEL_MEMORY.into()))
    };
    submit(app, state, Pass { job: format!("m{}", ulid::Ulid::generate()), kind: Kind::Seed, slug: slug.into(), thread: "project".into(), turn: None, prompt, model, card: None, result: None });
    Ok(())
}

// ---------- what the UI reads ----------

#[derive(Serialize)]
pub struct View {
    pub exists: bool,
    /// memory.md as normalized text (the empty template when there is none yet).
    pub text: String,
    pub words: usize,
    pub cap: u64,
}

pub fn view(ws: &Workspace, slug: &str) -> Result<View> {
    let dir = ws.existing_project_dir(slug)?;
    let raw = read_raw(&dir);
    let s = parse(raw.as_deref().unwrap_or(""));
    Ok(View { exists: raw.is_some(), text: render(&s), words: words(&s), cap: ws.get_settings().map(|s| s.memory_cap).unwrap_or(DEFAULT_CAP) })
}

/// FNV-1a hash of the memory text, for the export manifest.
pub fn hash_of(text: &str) -> String {
    crate::ctx::hash(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(o: &str, s: &str, t: Option<&str>, old: Option<&str>) -> Op {
        Op { op: o.into(), section: s.into(), text: t.map(String::from), old: old.map(String::from) }
    }

    #[test]
    fn parse_and_render_keep_the_six_sections_in_order() {
        let s = parse("# Memory\n## Decisions\n- no PvP\n* solo only\nloose line\n## Weird\n- keep me\n");
        let r = render(&s);
        let heads: Vec<&str> = r.lines().filter(|l| l.starts_with("## ")).collect();
        assert_eq!(heads, ["## Pitch", "## Pillars", "## Decisions", "## Rejected", "## Glossary", "## How to work with me", "## Weird"]);
        assert!(r.contains("- no PvP\n- solo only\n- loose line\n"));
        assert_eq!(words(&s), 8);
        assert!(!has_bullets(&template()));
        assert_eq!(parse(&r), s, "render then parse is stable");
    }

    #[test]
    fn ops_dedupe_replace_and_remove() {
        let mut s = parse("");
        let eff = apply_ops(&mut s, &[op("add", "Decisions", Some("No PvP"), None), op("add", "decisions", Some("- no pvp"), None), op("add", "nope", Some("x"), None)]);
        assert_eq!(eff.len(), 1, "duplicate and unknown section are dropped");
        let eff = apply_ops(&mut s, &[op("replace", "Decisions", Some("Co-op only (was: no PvP)"), Some("no pvp")), op("remove", "Decisions", None, Some("missing"))]);
        assert_eq!(eff.len(), 1);
        assert_eq!(s[2].1, ["Co-op only (was: no PvP)"]);
        let eff = apply_ops(&mut s, &[op("replace", "Rejected", Some("PvP"), Some("not there"))]);
        assert_eq!(eff[0].op, "add", "a replace that finds nothing adds");
        assert_eq!(forget_ops(&s, "co-op only").len(), 1);
    }

    #[test]
    fn writes_log_and_revert_line_by_line() {
        let dir = tempfile::TempDir::new().unwrap();
        let d = dir.path();
        let (at1, _) = apply_to_dir(d, &[op("add", "Decisions", Some("No PvP"), None)], "auto", Some("project"), 600).unwrap().unwrap();
        let (at2, _) = apply_to_dir(d, &[op("add", "Pillars", Some("Calm"), None)], "user", None, 600).unwrap().unwrap();
        assert!(apply_to_dir(d, &[op("add", "Decisions", Some("no pvp"), None)], "auto", None, 600).unwrap().is_none(), "no change, no log");
        assert_eq!(history(d, 10).len(), 2);
        assert_eq!(history(d, 10)[0]["at"], at2.as_str());
        // Undo the first change even though a later one happened.
        revert(d, &at1).unwrap().unwrap();
        let s = parse(&read_raw(d).unwrap());
        assert!(s[2].1.is_empty() && s[1].1 == ["Calm"]);
        assert_eq!(history(d, 10)[0]["source"], "user");
    }

    #[test]
    fn the_cap_blocks_growth_only() {
        let dir = tempfile::TempDir::new().unwrap();
        let d = dir.path();
        assert!(apply_to_dir(d, &[op("add", "Pitch", Some("one two three four"), None)], "auto", None, 3).is_err());
        apply_to_dir(d, &[op("add", "Pitch", Some("one two three"), None)], "auto", None, 3).unwrap().unwrap();
        // Replacing with a shorter line is allowed at the cap.
        apply_to_dir(d, &[op("replace", "Pitch", Some("one two"), Some("one two three"))], "auto", None, 3).unwrap().unwrap();
    }

    #[test]
    fn save_text_normalizes_and_logs_the_source() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(save_text(dir.path(), "x", "auto").is_err());
        save_text(dir.path(), "", "seed").unwrap().unwrap();
        assert_eq!(read_raw(dir.path()).unwrap(), template());
        assert!(save_text(dir.path(), "", "seed").unwrap().is_none());
    }

    #[test]
    fn card_decisions_append_under_the_heading_and_undo_cleanly() {
        let (b, added) = add_decisions("Notes\n", &["Three boss phases".into()]);
        assert_eq!(b, "Notes\n\n## Decisions\n\n- Three boss phases\n");
        assert_eq!(added.len(), 1);
        let (b2, added2) = add_decisions(&b, &["three boss phases".into(), "No co-op".into()]);
        assert_eq!(added2, ["No co-op"]);
        assert_eq!(decisions_of(&b2), "- Three boss phases\n- No co-op");
        assert_eq!(remove_decisions(&b2, &["No co-op".into()], "Notes\n"), b);
        assert_eq!(remove_decisions(&b, &["Three boss phases".into()], "Notes\n"), "Notes\n");
        // An existing heading in the middle keeps its place.
        let (b3, _) = add_decisions("## Decisions\n- a\n\n## Later\ntext\n", &["b".into()]);
        assert_eq!(b3, "## Decisions\n- a\n- b\n\n## Later\ntext\n");
        assert_eq!(remove_decisions(&b3, &["b".into()], "## Decisions\n- a\n\n## Later\ntext\n"), "## Decisions\n- a\n\n## Later\ntext\n");
    }

    #[test]
    fn update_prompt_truncates_the_reply() {
        let long = "x".repeat(5000);
        let info = TurnInfo { slug: "p", thread: "project", turn: "t", user: "hi", reply: &long, question: Some("Pick one?") };
        let p = update_prompt(&info, "", 600, None);
        assert!(p.contains("Pick one?") && p.len() < 4000 && p.contains('…'));
    }
}
