//! Design questions read back from the repo: `<repo>/docs/design/QUESTIONS.md` is where Claude Code
//! writes questions it hits while building. Unchecked lines become question items on the project's
//! "From Claude Code" checklist card (role `cc-questions`); answering one writes the answer back.

use crate::error::Result;
use crate::model::{CardKind, CardPatch, ChecklistItem, NewCard, ROLE_CC_QUESTIONS};
use crate::storage::{atomic_write, Workspace};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const CARD_TITLE: &str = "From Claude Code";

/// Content hashes of what we wrote ourselves, so the watcher can skip our own writes.
static OWN_WRITES: Mutex<Option<HashMap<PathBuf, u64>>> = Mutex::new(None);

fn hash(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

pub fn questions_path(repo: &Path) -> PathBuf {
    repo.join("docs").join("design").join("QUESTIONS.md")
}

/// True when `path` holds exactly what Dreamer last wrote there (the event is our own echo).
pub fn is_own_write(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    OWN_WRITES.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(path).copied())).is_some_and(|h| h == hash(&text))
}

/// Raw text of every unchecked `- [ ]` line (trimmed at the end), in file order.
pub fn parse(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim_end)
        .filter(|l| l.trim_start().strip_prefix("- [ ]").is_some_and(|r| !r.trim().is_empty()))
        .map(String::from)
        .collect()
}

/// Number of unanswered questions in the repo file (0 when there is none).
pub fn open_count(repo: &Path) -> usize {
    std::fs::read_to_string(questions_path(repo)).map(|t| parse(&t).len()).unwrap_or(0)
}

/// The question text of a source line: everything after the checkbox.
fn display(line: &str) -> String {
    line.trim_start().trim_start_matches("- [ ]").trim().to_string()
}

/// Turns `source` into a checked line followed by an indented `- A:` line. None when the line is gone.
pub fn apply_answer(text: &str, source: &str, answer: &str) -> Option<String> {
    let answer = answer.split_whitespace().collect::<Vec<_>>().join(" ");
    if answer.is_empty() {
        return None;
    }
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(text.len() + answer.len() + 16);
    let mut done = false;
    for raw in text.split_inclusive('\n') {
        let line = raw.trim_end_matches(['\r', '\n']);
        if !done && line.trim_end() == source.trim_end() && line.trim_start().starts_with("- [ ]") {
            let indent = &line[..line.len() - line.trim_start().len()];
            let rest = line.trim_start().trim_start_matches("- [ ]");
            out.push_str(&format!("{indent}- [x]{rest}{nl}{indent}  - A: {answer}"));
            if raw.ends_with('\n') {
                out.push_str(nl);
            }
            done = true;
        } else {
            out.push_str(raw);
        }
    }
    done.then_some(out)
}

fn repo_of(ws: &Workspace, slug: &str) -> Option<PathBuf> {
    let meta = ws.load_project(slug).ok()?.meta;
    meta.handoff_target.filter(|t| !t.trim().is_empty()).map(PathBuf::from)
}

/// Adds items for new unchecked lines to the project's "From Claude Code" card (created when
/// missing). Idempotent. Returns true when the card changed.
pub fn import(ws: &Workspace, slug: &str) -> Result<bool> {
    let Some(repo) = repo_of(ws, slug) else { return Ok(false) };
    let Ok(text) = std::fs::read_to_string(questions_path(&repo)) else { return Ok(false) };
    let lines = parse(&text);
    let data = ws.load_project(slug)?;
    let card = data.cards.iter().find(|c| c.meta.role.as_deref() == Some(ROLE_CC_QUESTIONS));
    // Known = on the card, or deleted from it (dismissed).
    let known = |l: &String| {
        card.is_some_and(|c| {
            c.meta.items.iter().filter_map(|i| i.source.as_deref()).chain(c.meta.dismissed_sources.iter().map(String::as_str)).any(|s| s.trim_end() == l.trim_end())
        })
    };
    let fresh: Vec<ChecklistItem> = lines
        .iter()
        .filter(|l| !known(l))
        .map(|l| ChecklistItem { text: display(l), question: true, source: Some(l.clone()), ..Default::default() })
        .collect();
    if fresh.is_empty() {
        return Ok(false);
    }
    push_items(ws, slug, &data, fresh)?;
    Ok(true)
}

/// Adds `fresh` to the "From Claude Code" card, creating the card when missing.
fn push_items(ws: &Workspace, slug: &str, data: &crate::model::ProjectData, fresh: Vec<ChecklistItem>) -> Result<()> {
    let card = data.cards.iter().find(|c| c.meta.role.as_deref() == Some(ROLE_CC_QUESTIONS));
    match card {
        Some(c) => {
            let mut items = c.meta.items.clone();
            items.extend(fresh);
            ws.update_card(slug, &c.meta.id, CardPatch { items: Some(items), ..Default::default() })?;
        }
        None => {
            // Next to the Design frame when the canvas has one, else the usual free spot.
            let at = data.canvas.frames.values().find(|f| f.title.trim().eq_ignore_ascii_case("design")).map(|f| (f.x + 20.0, f.y + 20.0));
            ws.create_card(
                slug,
                NewCard {
                    title: Some(CARD_TITLE.into()),
                    kind: Some(CardKind::Checklist),
                    role: Some(ROLE_CC_QUESTIONS.into()),
                    items: Some(fresh),
                    x: at.map(|a| a.0),
                    y: at.map(|a| a.1),
                    ..Default::default()
                },
            )?;
        }
    }
    Ok(())
}

/// A question that did not come from QUESTIONS.md (a blocked build): same card, no source line,
/// so nothing is written back to the repo. Skipped when the card already has that text.
pub fn add_question(ws: &Workspace, slug: &str, text: &str) -> Result<()> {
    let data = ws.load_project(slug)?;
    let dup = data.cards.iter().any(|c| c.meta.role.as_deref() == Some(ROLE_CC_QUESTIONS) && c.meta.items.iter().any(|i| i.text == text));
    if dup {
        return Ok(());
    }
    push_items(ws, slug, &data, vec![ChecklistItem { text: text.into(), question: true, ..Default::default() }])
}

/// Writes answers of `items` back to QUESTIONS.md (checked line + `- A:` line). Called after the
/// card is saved; best effort, so a missing repo or a vanished line never fails the card edit.
pub fn write_back(ws: &Workspace, slug: &str, items: &[ChecklistItem]) {
    let Some(repo) = repo_of(ws, slug) else { return };
    let path = questions_path(&repo);
    let Ok(mut text) = std::fs::read_to_string(&path) else { return };
    let mut changed = false;
    for it in items {
        let (Some(src), Some(ans)) = (it.source.as_deref(), it.answer.as_deref()) else { continue };
        if let Some(t) = apply_answer(&text, src, ans) {
            text = t;
            changed = true;
        }
    }
    if changed {
        if let Ok(mut g) = OWN_WRITES.lock() {
            g.get_or_insert_with(HashMap::new).insert(path.clone(), hash(&text));
        }
        if let Err(e) = atomic_write(&path, text.as_bytes()) {
            eprintln!("[dreamer] could not write answers to {}: {e}", path.display());
        }
    }
}

/// Answered (the decisions) and still-open questions on the card, for the handoff prompts.
pub fn summary(items: &[ChecklistItem]) -> (Vec<(String, String)>, Vec<String>) {
    let mut answered = Vec::new();
    let mut open = Vec::new();
    for i in items.iter().filter(|i| i.question) {
        match i.answer.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
            Some(a) => answered.push((i.text.clone(), a.to_string())),
            None => open.push(i.text.clone()),
        }
    }
    (answered, open)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unchecked_lines_leniently() {
        let t = "# Q\n\n- [ ] Q (T-1): how fast? — context\n- [x] done one\n  - A: yes\n  - [ ] nested ok\n-[ ] bad\n- [ ]\n- [ ] plain";
        assert_eq!(parse(t), vec!["- [ ] Q (T-1): how fast? — context", "  - [ ] nested ok", "- [ ] plain"]);
    }

    #[test]
    fn answer_checks_the_line_and_preserves_the_rest() {
        let t = "# Q\r\n\r\n- [ ] one\r\n- [ ] two\r\nend";
        let out = apply_answer(t, "- [ ] one", "line a\nline b").unwrap();
        assert_eq!(out, "# Q\r\n\r\n- [x] one\r\n  - A: line a line b\r\n- [ ] two\r\nend");
        assert!(apply_answer(&out, "- [ ] one", "again").is_none(), "the line is gone");
        assert_eq!(parse(&out), vec!["- [ ] two"]);
        assert_eq!(apply_answer("- [ ] x", "- [ ] x", "y").unwrap(), "- [x] x\n  - A: y");
    }
}
