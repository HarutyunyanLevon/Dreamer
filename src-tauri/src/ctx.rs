//! What Claude already knows about a chat thread, so each message carries only what changed.
//!
//! Every thread file keeps a snapshot (`ctx`) of the project as of the last message Claude
//! answered. The first message of a Claude session carries everything (memory, card list, the
//! open card); later ones carry a short "[Changes since your last message]" block, or nothing.
//! Rust owns `ctx`, `last_input_tokens` and `summary` in the thread file (see
//! `Workspace::save_chat`, which keeps them across UI saves).

use crate::model::Card;
use crate::search::OverviewCard;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Thread-file keys the UI never writes.
pub const RUST_OWNED_CHAT_KEYS: &[&str] = &["ctx", "last_input_tokens", "context_window", "summary"];

/// Stands in for the thread summary in a full text until the sidecar has produced it.
pub const SUMMARY_SLOT: &str = "{{SUMMARY}}";

const TRANSCRIPT_MAX_CHARS: usize = 60_000;

/// Longest text of one card / tool result / clip excerpt Claude is sent.
pub const MAX_CLAUDE_TEXT: usize = 8_000;

const DATA_OMITTED: &str = "[embedded data omitted]";

/// Length of a `data:<type>/<sub>[;params],<payload>` URI starting at the beginning of `s`.
fn data_uri_len(s: &str) -> Option<usize> {
    let rest = s.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    let head = &rest[..comma];
    if comma > 200 || !head.contains('/') || head.contains(char::is_whitespace) {
        return None;
    }
    let payload = &rest[comma + 1..];
    let end = payload.find(|c: char| c.is_whitespace() || matches!(c, ')' | '"' | '\'' | '<' | '>' | ']')).unwrap_or(payload.len());
    Some(5 + comma + 1 + end)
}

/// Drops raw HTML (script/style blocks and tags, keeping autolinks like `<https://x>`).
fn strip_html(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        if rest.starts_with('<') {
            let next = rest[1..].chars().next();
            let tag_like = matches!(next, Some(c) if c.is_ascii_alphabetic() || c == '/' || c == '!');
            if tag_like {
                let block = ["script", "style"].iter().find(|t| lower[i..].starts_with(&format!("<{t}")));
                if let Some(t) = block {
                    if let Some(end) = lower[i..].find(&format!("</{t}>")) {
                        i += end + t.len() + 3;
                        continue;
                    }
                }
                if let Some(gt) = rest.find('>').filter(|g| *g < 2000) {
                    let inner = &rest[1..gt];
                    let autolink = !inner.contains(char::is_whitespace) && (inner.contains("://") || inner.contains('@'));
                    if !autolink {
                        i += gt + 1;
                        continue;
                    }
                }
            }
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// Text as Claude should see it: `data:` / base64 URIs replaced by a marker (attachments are
/// referred to by id and caption, never inlined) and raw HTML stripped.
pub fn clean_for_claude(s: &str) -> String {
    let mut out = String::with_capacity(s.len().min(MAX_CLAUDE_TEXT * 2));
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        if rest.starts_with("data:") {
            if let Some(n) = data_uri_len(rest) {
                out.push_str(DATA_OMITTED);
                i += n;
                continue;
            }
        }
        // `d` is ASCII, so jumping to the next candidate start keeps char boundaries.
        let step = rest.char_indices().skip(1).find(|(_, c)| *c == 'd' || *c == 'D').map_or(rest.len(), |(k, _)| k);
        out.push_str(&rest[..step]);
        i += step;
    }
    if out.contains('<') { strip_html(&out) } else { out }
}

/// At most `max` chars, with a pointer to read_card when something was cut.
pub fn cap_for_claude(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}
…truncated ({} more chars), use read_card", n - max)
}

/// The `[This card]` block never exceeds this many chars.
pub const MAX_CARD_CHARS: usize = 6_000;
/// The project memory sent to Claude never exceeds this many chars.
pub const MEMORY_MAX_CHARS: usize = 2_000;

/// At most `max` chars of `s`, marked when cut.
pub fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    format!("{}…", s.chars().take(max).collect::<String>())
}

/// `clean_for_claude` then `cap_for_claude(MAX_CLAUDE_TEXT)`.
pub fn claude_text(s: &str) -> String {
    cap_for_claude(&clean_for_claude(s), MAX_CLAUDE_TEXT)
}

/// Every string inside a JSON value, cleaned and capped (what a tool result carries).
pub fn claude_json(v: &mut Value) {
    match v {
        Value::String(s) => *s = claude_text(s),
        Value::Array(a) => a.iter_mut().for_each(claude_json),
        Value::Object(m) => m.values_mut().for_each(claude_json),
        _ => {}
    }
}

/// One card as Claude last saw it (enough to say what changed without reading the file again).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct CardSnap {
    pub updated: String,
    pub title: String,
    pub tags: Vec<String>,
    pub stage: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct CardMark {
    pub id: String,
    pub updated: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Ctx {
    /// Hash of memory.md ("" = no memory).
    #[serde(default, rename = "memoryHash")]
    pub memory_hash: String,
    /// Kept (non-ghost) cards by id.
    #[serde(default)]
    pub cards: BTreeMap<String, CardSnap>,
    /// The card this thread is about, when it is a card thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<CardMark>,
    /// Cards already sent as `[Related cards]` in this session: id -> `updated` when sent.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sent: BTreeMap<String, String>,
}

/// FNV-1a: stable across Rust versions, unlike `DefaultHasher`.
pub(crate) fn hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn stage_name(c: &OverviewCard) -> String {
    serde_json::to_value(c.stage).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// The project as it is now. Ghost cards (unkept suggestions) never count.
pub fn snapshot(cards: &[OverviewCard], memory: Option<&str>, card: Option<CardMark>) -> Ctx {
    Ctx {
        memory_hash: memory.map(hash).unwrap_or_default(),
        cards: cards
            .iter()
            .filter(|c| !c.ghost)
            .map(|c| (c.id.clone(), CardSnap { updated: c.updated.clone(), title: c.title.clone(), tags: c.tags.clone(), stage: stage_name(c) }))
            .collect(),
        card,
        sent: BTreeMap::new(),
    }
}

fn quote(titles: impl Iterator<Item = String>) -> String {
    titles.map(|t| format!("\"{}\"", t.trim())).collect::<Vec<_>>().join(", ")
}

/// The open card in full, as Claude should see it after the user changed it.
pub fn format_card(card: &Card) -> String {
    let m = &card.meta;
    let stage = serde_json::to_value(m.stage).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    format!(
        "[Selected card, updated] \"{}\" (id {}, stage: {stage}{})\n{}",
        m.title,
        m.id,
        if m.tags.is_empty() { String::new() } else { format!(", tags: {}", m.tags.join(", ")) },
        if card.body.trim().is_empty() { "(no notes yet)".to_string() } else { cap_for_claude(&clean_for_claude(&card.body), MAX_CARD_CHARS) }
    )
}

/// What changed between `prev` and `now`, or None when nothing did (then no block is sent).
/// `memory` is the current memory text; `card` the open card as it is now (card threads).
pub fn delta(prev: &Ctx, now: &Ctx, memory: Option<&str>, card: Option<&Card>) -> Option<String> {
    let open = now.card.as_ref().map(|c| c.id.as_str());
    let mut lines: Vec<String> = Vec::new();

    let created: Vec<String> = now.cards.iter().filter(|(id, _)| !prev.cards.contains_key(*id)).map(|(_, c)| c.title.clone()).collect();
    if !created.is_empty() {
        lines.push(format!("Created: {}", quote(created.into_iter())));
    }

    let mut edited: Vec<String> = Vec::new();
    let mut staged: Vec<String> = Vec::new();
    for (id, c) in &now.cards {
        let Some(p) = prev.cards.get(id) else { continue };
        if p.updated == c.updated {
            continue;
        }
        if p.stage != c.stage {
            staged.push(format!("\"{}\" {} -> {}", c.title.trim(), p.stage, c.stage));
        }
        if open == Some(id.as_str()) {
            continue; // the open card gets its own block below
        }
        let mut fields = Vec::new();
        if p.title != c.title {
            fields.push("title");
        }
        if p.tags != c.tags {
            fields.push("tags");
        }
        if p.title == c.title && p.tags == c.tags && p.stage == c.stage {
            fields.push("content");
        }
        if !fields.is_empty() {
            edited.push(format!("\"{}\" ({}{})", c.title.trim(), fields.join(", "), if p.title != c.title { format!("; was \"{}\"", p.title.trim()) } else { String::new() }));
        }
    }
    if !edited.is_empty() {
        lines.push(format!("Edited: {}", edited.join(", ")));
    }
    if !staged.is_empty() {
        lines.push(format!("Stage: {}", staged.join("; ")));
    }

    let trashed: Vec<String> = prev.cards.iter().filter(|(id, _)| !now.cards.contains_key(*id)).map(|(_, c)| c.title.clone()).collect();
    if !trashed.is_empty() {
        lines.push(format!("Trashed: {}", quote(trashed.into_iter())));
    }

    if prev.memory_hash != now.memory_hash {
        match memory {
            Some(m) => lines.push(format!("Project memory updated. New memory:\n{m}")),
            None => lines.push("Project memory removed.".into()),
        }
    }

    if let (Some(p), Some(n), Some(card)) = (prev.card.as_ref(), now.card.as_ref(), card) {
        if p.id == n.id && p.updated != n.updated {
            lines.push(format_card(card));
        }
    }

    if lines.is_empty() {
        None
    } else {
        Some(format!("[Changes since your last message]\n{}", lines.join("\n")))
    }
}

/// The text for one turn: the change block (if any) above the user's words.
pub fn with_block(block: Option<String>, user: &str) -> String {
    match block {
        Some(b) => format!("{b}\n\n---\n\n{user}"),
        None => user.to_string(),
    }
}

/// The visible conversation as plain text for the summarizer: user and assistant text, question
/// and answer pairs. Starts after the last "compacted" divider (the thread's earlier summary, if
/// any, leads), skips search chips, and keeps the most recent `TRANSCRIPT_MAX_CHARS`.
pub fn transcript(file: &Value) -> String {
    transcript_capped(file, TRANSCRIPT_MAX_CHARS)
}

/// [`transcript`], keeping only the most recent `max` chars (a restarted local session gets this as its history).
pub fn transcript_capped(file: &Value, max: usize) -> String {
    let mut out: Vec<String> = Vec::new();
    if let Some(s) = file.get("summary").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        out.push(format!("Earlier summary: {}", s.trim()));
    }
    out.extend(transcript_lines(file));
    let joined = out.join("
");
    let n = joined.chars().count();
    if n > max {
        joined.chars().skip(n - max).collect()
    } else {
        joined
    }
}

/// One line per visible message since the last compaction divider (errors skipped).
fn transcript_lines(file: &Value) -> Vec<String> {
    let msgs = file.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let start = msgs.iter().rposition(|m| m.get("kind").and_then(Value::as_str) == Some("compacted")).map_or(0, |i| i + 1);
    let mut out: Vec<String> = Vec::new();
    for m in &msgs[start..] {
        let text = m.get("text").and_then(Value::as_str).unwrap_or("").trim();
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        if m.get("isError").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let asked = asked_pairs(m);
        if !asked.is_empty() {
            for (question, answer) in asked {
                out.push(format!("Claude asked: {question}{}", answer.map(|a| format!(" -> user answered: {a}")).unwrap_or_default()));
            }
        } else if let Some(line) = m.get("line").and_then(Value::as_str).filter(|_| m.get("kind").and_then(Value::as_str) == Some("change")) {
            out.push(format!("Change: {line}")); // a change-log line
        } else if !text.is_empty() {
            out.push(format!("{}: {text}", if role == "user" { "User" } else { "Claude" }));
        }
    }
    out
}

/// The questions a saved message asked, with their answers: the question form (`questions`, a
/// skipped one answered "(skipped)") or an older thread's single `question`.
fn asked_pairs(m: &Value) -> Vec<(&str, Option<&str>)> {
    if let Some(qs) = m.get("questions").and_then(Value::as_array) {
        return qs
            .iter()
            .map(|q| {
                let skipped = q.get("skipped").and_then(Value::as_bool) == Some(true);
                (q.get("question").and_then(Value::as_str).unwrap_or(""), if skipped { Some("(skipped)") } else { q.get("answer").and_then(Value::as_str) })
            })
            .collect();
    }
    m.get("question").map(|q| vec![(q.get("question").and_then(Value::as_str).unwrap_or(""), q.get("answered").and_then(Value::as_str))]).unwrap_or_default()
}

/// The pairs of a batched answer message (`Q: <question>` / `A: <answer>` lines); empty when it is not one.
fn qa_lines(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut q: Option<&str> = None;
    for l in text.lines() {
        if let Some(x) = l.strip_prefix("Q: ") {
            q = Some(x.trim());
        } else if let (Some(a), Some(qq)) = (l.strip_prefix("A: "), q.take()) {
            out.push((qq.to_string(), a.trim().to_string()));
        }
    }
    out
}

/// History a restarted local session gets (chars, newest kept): enough for a long grill, small for a 9B model.
pub const RESTART_HISTORY_CHARS: usize = 12_000;

/// Pairs kept in [`answered_block`] (the newest), and chars per question / answer.
const ANSWERED_MAX: usize = 40;
const ANSWERED_Q_CHARS: usize = 300;
const ANSWERED_A_CHARS: usize = 200;

/// The `[Answered so far]` block of a grill turn: every question already asked in this thread with
/// the chosen answer (oldest first; `current` is the pair this turn answers, which the saved
/// thread may not hold yet), then the card's memory lines. None when there is nothing to list.
pub fn answered_block(file: &Value, current: Option<(&str, &str)>, card_memory: &str) -> Option<String> {
    let mut pairs: Vec<(String, String)> = file
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(asked_pairs)
        .filter_map(|(q, a)| Some((q.trim().to_string(), a?.trim().to_string())))
        .filter(|(q, a)| !q.is_empty() && !a.is_empty())
        .collect();
    if let Some((q, a)) = current {
        // A batched answer is "Q: ..\nA: .." lines; a single one is the choice itself.
        let batch = qa_lines(a);
        let current: Vec<(String, String)> = if batch.is_empty() { vec![(q.trim().to_string(), a.trim().to_string())] } else { batch };
        for (q, a) in current.into_iter().filter(|(q, a)| !q.is_empty() && !a.is_empty()) {
            if !pairs.iter().any(|(lq, _)| *lq == q) {
                pairs.push((q, a));
            }
        }
    }
    let memory: Vec<&str> = card_memory.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if pairs.is_empty() && memory.is_empty() {
        return None;
    }
    let skip = pairs.len().saturating_sub(ANSWERED_MAX);
    let mut out = vec!["[Answered so far]".to_string()];
    out.extend(pairs[skip..].iter().map(|(q, a)| format!("- Q: {} -> A: {}", cap_chars(q, ANSWERED_Q_CHARS), cap_chars(a, ANSWERED_A_CHARS))));
    if !memory.is_empty() {
        out.push("Card memory:".into());
        out.extend(memory.iter().map(|l| format!("- {}", cap_chars(l.trim_start_matches(['-', '*', ' ']), ANSWERED_Q_CHARS))));
    }
    Some(out.join("\n"))
}

/// Characters kept per message in [`recent_turns`].
const RECENT_LINE_CHARS: usize = 1_500;

/// The last `n` messages of the thread as transcript lines, each capped (an escalated Claude turn
/// gets these plus the local model's recap instead of the whole transcript). None when empty.
pub fn recent_turns(file: &Value, n: usize) -> Option<String> {
    let lines = transcript_lines(file);
    let tail: Vec<String> = lines[lines.len().saturating_sub(n)..].iter().map(|l| cap_chars(l, RECENT_LINE_CHARS)).collect();
    (!tail.is_empty()).then(|| tail.join("
"))
}

/// Local threads run with a 65,536-token context (ollama::NUM_CTX), so they are summarized by
/// 40k at the latest, even when the setting is higher. Compaction is checked between turns, so one
/// heavy turn (a list_tree of 30k chars, several tool rounds, the reply) must still fit after it.
pub const LOCAL_COMPACT_MAX: u64 = 40_000;
pub fn local_compact_tokens(setting: u64) -> u64 {
    setting.min(LOCAL_COMPACT_MAX)
}

/// Whether the thread's last turn read enough input that it should be summarized first.
pub fn should_compact(file: &Value, compact_tokens: u64) -> bool {
    let tokens = file.get("last_input_tokens").and_then(Value::as_u64).unwrap_or(0);
    tokens > compact_tokens && file.get("messages").and_then(Value::as_array).is_some_and(|m| m.len() >= 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CardKind, Stage};
    use serde_json::json;

    fn oc(id: &str, title: &str, updated: &str, stage: Stage, ghost: bool) -> OverviewCard {
        OverviewCard { id: id.into(), title: title.into(), tags: vec![], stage, ghost, updated: updated.into(), kind: CardKind::Card, frame: None, attachments: 0 }
    }

    fn base() -> Vec<OverviewCard> {
        vec![oc("a", "Alpha", "1", Stage::Mist, false), oc("b", "Beta", "1", Stage::Mist, false)]
    }

    #[test]
    fn answered_block_lists_pairs_current_and_memory() {
        let file = json!({ "messages": [
            { "role": "user", "text": "/grill-me" },
            { "role": "claude", "text": "", "question": { "question": "Who plays?", "choices": ["Kids", "Adults"], "answered": "Adults" } },
            { "role": "user", "text": "Adults" },
            { "role": "claude", "text": "", "question": { "question": "Unanswered?", "choices": ["a", "b"] } },
            { "role": "claude", "text": "", "question": { "question": "Play order?", "choices": ["List", "None"], "answered": "List" } },
        ] });
        let b = answered_block(&file, Some(("Platform?", "PC")), "- The levels list JSON defines the play order.\n\n").unwrap();
        assert_eq!(b, "[Answered so far]\n- Q: Who plays? -> A: Adults\n- Q: Play order? -> A: List\n- Q: Platform? -> A: PC\nCard memory:\n- The levels list JSON defines the play order.");
        // The pair this turn answers is not listed twice when the saved thread already has it.
        let again = answered_block(&file, Some(("Play order?", "List")), "").unwrap();
        assert_eq!(again.matches("Play order?").count(), 1);
        assert!(answered_block(&json!({ "messages": [] }), None, "").is_none());
    }

    #[test]
    fn answered_block_reads_question_forms_and_batched_answers() {
        let file = json!({ "messages": [
            { "role": "claude", "text": "", "answered": true, "questions": [
                { "id": "q1", "question": "Who plays?", "choices": ["Kids", "Adults"], "answer": "Adults" },
                { "id": "q2", "question": "Mood?", "choices": ["a", "b"], "skipped": true },
            ] },
        ] });
        let b = answered_block(&file, Some(("Platform?\nLength?", "Q: Platform?\nA: PC\nQ: Who plays?\nA: Adults\nQ: Length?\nA: (skipped)")), "").unwrap();
        assert_eq!(b, "[Answered so far]\n- Q: Who plays? -> A: Adults\n- Q: Mood? -> A: (skipped)\n- Q: Platform? -> A: PC\n- Q: Length? -> A: (skipped)");
        assert!(transcript(&file).contains("Claude asked: Mood? -> user answered: (skipped)"));
    }

    #[test]
    fn transcript_capped_keeps_the_newest() {
        let file = json!({ "messages": [{ "role": "user", "text": "old ".repeat(50) }, { "role": "user", "text": "newest" }] });
        let t = transcript_capped(&file, 20);
        assert!(t.ends_with("User: newest") && t.chars().count() == 20, "{t}");
    }

    #[test]
    fn claude_text_drops_data_uris_and_html_and_caps() {
        let b64 = "A".repeat(50_000);
        let md = format!("see ![shot](data:image/png;base64,{b64}) and <img src=\"data:image/png;base64,{b64}\"> <b>bold</b> <https://x.io> a < b");
        let out = clean_for_claude(&md);
        assert!(!out.contains("AAAA") && !out.contains("<b>") && !out.contains("<img"), "{out}");
        assert!(out.contains("![shot]([embedded data omitted])") && out.contains("<https://x.io>") && out.contains("a < b") && out.contains("bold"));
        let long = "x".repeat(20_000);
        let c = claude_text(&long);
        assert!(c.chars().count() < MAX_CLAUDE_TEXT + 80 && c.contains("use read_card"));
        assert_eq!(claude_text("héllo wörld, dédé"), "héllo wörld, dédé");
    }

    #[test]
    fn no_change_means_no_block() {
        let prev = snapshot(&base(), Some("mem"), None);
        let mut cards = base();
        cards.push(oc("g", "Ghost", "2", Stage::Mist, true)); // unkept suggestions never count
        let now = snapshot(&cards, Some("mem"), None);
        assert_eq!(delta(&prev, &now, Some("mem"), None), None);
        assert_eq!(with_block(None, "hello"), "hello");
    }

    #[test]
    fn edit_create_stage_and_trash_are_listed() {
        let prev = snapshot(&base(), None, None);
        let mut cards = vec![oc("a", "Alpha 2", "2", Stage::Mist, false), oc("c", "Gamma", "2", Stage::Mist, false)];
        let mut b = oc("b", "Beta", "2", Stage::Lucid, false);
        b.tags = vec!["x".into()];
        cards.push(b);
        let d = delta(&prev, &snapshot(&cards, None, None), None, None).unwrap();
        assert!(d.starts_with("[Changes since your last message]"));
        assert!(d.contains("Created: \"Gamma\""), "{d}");
        assert!(d.contains("\"Alpha 2\" (title; was \"Alpha\")"), "{d}");
        assert!(d.contains("\"Beta\" (tags)"), "{d}");
        assert!(d.contains("Stage: \"Beta\" mist -> lucid"), "{d}");

        let d = delta(&prev, &snapshot(&base()[..1], None, None), None, None).unwrap();
        assert!(d.contains("Trashed: \"Beta\""), "{d}");
        assert!(!d.contains("Edited"), "{d}");
    }

    #[test]
    fn untouched_fields_fall_back_to_content() {
        let prev = snapshot(&base(), None, None);
        let cards = vec![oc("a", "Alpha", "5", Stage::Mist, false), oc("b", "Beta", "1", Stage::Mist, false)];
        let d = delta(&prev, &snapshot(&cards, None, None), None, None).unwrap();
        assert!(d.contains("Edited: \"Alpha\" (content)"), "{d}");
    }

    #[test]
    fn memory_change_carries_the_new_memory() {
        let prev = snapshot(&base(), Some("old"), None);
        let now = snapshot(&base(), Some("new memory"), None);
        let d = delta(&prev, &now, Some("new memory"), None).unwrap();
        assert!(d.contains("Project memory updated") && d.contains("new memory"), "{d}");
        let gone = snapshot(&base(), None, None);
        assert!(delta(&prev, &gone, None, None).unwrap().contains("Project memory removed"));
        assert_ne!(hash("a"), hash("b"));
    }

    #[test]
    fn open_card_change_sends_its_new_content_once() {
        let mark = |u: &str| Some(CardMark { id: "a".into(), updated: u.into() });
        let prev = snapshot(&base(), None, mark("1"));
        let cards = vec![oc("a", "Alpha", "2", Stage::Mist, false), oc("b", "Beta", "1", Stage::Mist, false)];
        let now = snapshot(&cards, None, mark("2"));
        let mut card = Card::default();
        card.meta.id = "a".into();
        card.meta.title = "Alpha".into();
        card.body = "new notes".into();
        let d = delta(&prev, &now, None, Some(&card)).unwrap();
        assert!(d.contains("[Selected card, updated] \"Alpha\"") && d.contains("new notes"), "{d}");
        assert!(!d.contains("Edited"), "the open card is not also listed as edited: {d}");
        assert_eq!(delta(&now, &now, None, Some(&card)), None);
    }

    #[test]
    fn ctx_roundtrips_through_json() {
        let c = snapshot(&base(), Some("m"), Some(CardMark { id: "a".into(), updated: "1".into() }));
        let v = serde_json::to_value(&c).unwrap();
        assert!(v.get("memoryHash").is_some());
        assert_eq!(serde_json::from_value::<Ctx>(v).unwrap(), c);
    }

    #[test]
    fn transcript_and_compaction_threshold() {
        let file = json!({
            "summary": "old summary",
            "last_input_tokens": 50000,
            "messages": [
                {"id": "1", "role": "user", "text": "before divider"},
                {"id": "d", "role": "claude", "kind": "compacted", "text": ""},
                {"id": "2", "role": "user", "text": "hi"},
                {"id": "3", "role": "claude", "text": "", "question": {"question": "Which?", "choices": ["a"], "answered": "a"}},
                {"id": "4", "role": "claude", "text": "answer", "searches": [{"query": "x", "results": []}]},
                {"id": "5", "role": "claude", "text": "boom", "isError": true}
            ]
        });
        let t = transcript(&file);
        assert_eq!(t, "Earlier summary: old summary\nUser: hi\nClaude asked: Which? -> user answered: a\nClaude: answer");
        assert!(should_compact(&file, 40_000));
        assert!(!should_compact(&file, 60_000));
        assert!(!should_compact(&json!({"last_input_tokens": 99999, "messages": []}), 40_000));
    }

    #[test]
    fn recent_turns_for_an_escalation() {
        let long = "x".repeat(3000);
        let file = json!({ "summary": "s", "messages": [
            {"id": "1", "role": "user", "text": "one"},
            {"id": "2", "role": "claude", "text": "two"},
            {"id": "3", "role": "user", "text": "three"},
            {"id": "4", "role": "claude", "text": "oops", "isError": true},
            {"id": "5", "role": "claude", "text": long}
        ]});
        let r = recent_turns(&file, 3).unwrap();
        assert!(r.starts_with("Claude: two
User: three
Claude: xxx"), "{r}");
        assert!(!r.contains("summary") && !r.contains("oops"), "no summary line, no errors");
        assert!(r.chars().count() < 1_600 + 30, "each line capped");
        assert_eq!(recent_turns(&json!({"messages": []}), 3), None);
        assert_eq!((local_compact_tokens(30_000), local_compact_tokens(200_000)), (30_000, LOCAL_COMPACT_MAX));
    }
}
