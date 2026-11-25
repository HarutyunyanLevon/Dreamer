//! The `dreamer-cards` skill for Claude Code: shipped with the app (docs/skills/dreamer-cards/SKILL.md, also
//! bundled as resources/skills/dreamer-cards/SKILL.md) and installed to `%USERPROFILE%\.claude\skills\dreamer-cards\`.

use crate::error::{AppError, Result};
use serde::Serialize;
use std::path::PathBuf;

/// The text this build ships.
const SHIPPED: &str = include_str!("../../docs/skills/dreamer-cards/SKILL.md");

/// `ctx::hash` of every earlier shipped text (LF line ends). An installed file that matches one is
/// unedited and updated silently. When SKILL.md changes, add the OLD text's hash here
///.
const PREVIOUS: &[&str] = &[];

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Not installed.
    Missing,
    /// Installed and the same as this build's.
    Current,
    /// Installed, unedited, older: updated silently at start.
    Outdated,
    /// Installed but edited by the user (or from a source Dreamer doesn't know): "Update available", never silent.
    Edited,
}

#[derive(Serialize)]
pub struct Status {
    pub state: State,
    pub path: String,
}

fn lf(s: &str) -> String {
    s.replace("\r\n", "\n")
}

fn path() -> Result<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).ok_or_else(|| AppError::Invalid("Can't find your home folder.".into()))?;
    Ok(home.join(".claude").join("skills").join("dreamer-cards").join("SKILL.md"))
}

fn classify(installed: Option<&str>) -> State {
    let Some(text) = installed else { return State::Missing };
    let h = crate::ctx::hash(&lf(text));
    if h == crate::ctx::hash(&lf(SHIPPED)) {
        State::Current
    } else if PREVIOUS.contains(&h.as_str()) {
        State::Outdated
    } else {
        State::Edited
    }
}

pub fn status() -> Result<Status> {
    let p = path()?;
    Ok(Status { state: classify(std::fs::read_to_string(&p).ok().as_deref()), path: p.display().to_string() })
}

/// Writes (or overwrites) the skill.
pub fn install() -> Result<Status> {
    let p = path()?;
    crate::storage::atomic_write(&p, lf(SHIPPED).as_bytes())?;
    status()
}

pub fn remove() -> Result<Status> {
    let p = path()?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| AppError::io(format!("remove {}", p.display()), e))?;
        // The folder only when it is empty (never the user's other files).
        if let Some(d) = p.parent() {
            let _ = std::fs::remove_dir(d);
        }
    }
    status()
}

/// App start: an unedited older copy is replaced silently; an edited one is left alone.
pub fn auto_update() {
    if status().is_ok_and(|s| s.state == State::Outdated) {
        if let Err(e) = install() {
            eprintln!("[dreamer] could not update the dreamer-cards skill: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ```dreamer example in the skill, parsed by the real bundle parser: no warnings.
    #[test]
    fn the_skills_example_bundle_parses_clean() {
        let text = lf(SHIPPED);
        let start = text.find("```dreamer\n").expect("the skill has a ```dreamer example") + "```dreamer\n".len();
        let end = start + text[start..].find("\n```").expect("the example is closed");
        let b = crate::bundle::parse(&text[start..end]).expect("the example parses");
        assert!(b.warnings.is_empty(), "{:?}", b.warnings);
        assert_eq!(b.cards.len(), 2);
        assert_eq!(b.header.bundle_id, "combat-ideas-2026-11-24");
        assert!(b.cards.iter().any(|c| c.build.is_some()));
    }

    #[test]
    fn states() {
        assert_eq!(classify(None), State::Missing);
        assert_eq!(classify(Some(SHIPPED)), State::Current);
        assert_eq!(classify(Some(&SHIPPED.replace('\n', "\r\n"))), State::Current);
        assert_eq!(classify(Some("my own version")), State::Edited);
        assert!(!PREVIOUS.contains(&crate::ctx::hash(&lf(SHIPPED)).as_str()));
    }
}
