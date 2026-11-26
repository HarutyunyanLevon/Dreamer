//! Model routing for chat turns: a few string rules, no extra model call.
//!
//! * deep: only when the user turned on "Think harder" for this message.
//! * fast: a short message (< 200 chars) that is a simple action or lookup.
//! * main: everything else.
//!
//! Switching models loses the prompt cache, so a thread that went to main stays there until it has
//! had [`FAST_STREAK_TO_DROP`] fast-type turns in a row. A pinned tier beats the router and leaves
//! its state alone.

use serde::Serialize;

pub const FAST_MAX_CHARS: usize = 200;
pub const FAST_STREAK_TO_DROP: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Fast,
    Main,
    Deep,
}

impl Tier {
    pub fn parse(s: &str) -> Option<Tier> {
        match s {
            "fast" => Some(Tier::Fast),
            "main" => Some(Tier::Main),
            "deep" => Some(Tier::Deep),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Fast => "fast",
            Tier::Main => "main",
            Tier::Deep => "deep",
        }
    }
}

/// Per-thread hysteresis state.
#[derive(Clone, Copy, Debug, Default)]
pub struct RouterState {
    on_main: bool,
    fast_streak: u8,
}

const LEADING_FILLER: &[&str] = &["please ", "pls ", "can you ", "could you ", "would you ", "just ", "now "];
const FAST_VERBS: &[&str] = &[
    "rename", "retitle", "move", "tag", "untag", "link", "unlink", "merge", "delete", "remove", "edit", "change", "set", "fix", "find", "search", "list", "show", "open", "restage", "promote", "demote", "archive",
];
const FAST_PHRASES: &[&str] = &["what is", "what's", "what are", "which cards", "which card", "where is", "where's", "how many", "who is"];
/// A message that names thinking work is never a simple action, whatever its first word.
const HEAVY_WORDS: &[&str] = &[
    "ideas", "idea for", "takes", "options", "brainstorm", "suggest", "improve", "expand", "rewrite", "write", "draft", "why", "how should", "how would", "compare", "pros and cons", "critique", "feedback", "explain", "summar", "think", "alternatives", "variations", "come up",
];

/// Is this message a simple action or lookup (fast-type)?
pub fn is_fast_type(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.chars().count() >= FAST_MAX_CHARS || t.starts_with('/') {
        return false;
    }
    let mut l = t.to_lowercase();
    while let Some(f) = LEADING_FILLER.iter().find(|f| l.starts_with(**f)) {
        l = l[f.len()..].trim_start().to_string();
    }
    if HEAVY_WORDS.iter().any(|w| l.contains(w)) {
        return false;
    }
    let first = l.split(|c: char| !c.is_alphanumeric() && c != '\'').next().unwrap_or("");
    FAST_VERBS.contains(&first) || FAST_PHRASES.iter().any(|p| l.starts_with(p))
}

/// Picks the tier for one turn. `pin` and `think` come from the UI; `router_on` is the setting.
pub fn route(state: &mut RouterState, text: &str, think: bool, pin: Option<Tier>, router_on: bool) -> Tier {
    if let Some(p) = pin {
        return p;
    }
    if think {
        return Tier::Deep;
    }
    if !router_on {
        return Tier::Main;
    }
    let fast = is_fast_type(text);
    if !state.on_main {
        if fast {
            Tier::Fast
        } else {
            state.on_main = true;
            state.fast_streak = 0;
            Tier::Main
        }
    } else if fast {
        state.fast_streak += 1;
        if state.fast_streak >= FAST_STREAK_TO_DROP {
            state.on_main = false;
            state.fast_streak = 0;
            Tier::Fast
        } else {
            Tier::Main
        }
    } else {
        state.fast_streak = 0;
        Tier::Main
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_simple_actions_and_lookups() {
        for t in ["rename this card to Harpoon", "Please move it to Lucid", "tag this with boss", "find the cards about fishing", "what is the stage of this card?", "edit this card: fix the typo in the title", "list my cards"] {
            assert!(is_fast_type(t), "{t}");
        }
        for t in ["give me 3 takes on this card", "/merge", "why is this card stuck?", "write a longer description for this boss", "", "rename this card but also brainstorm what the boss could do", &"rename ".repeat(40)] {
            assert!(!is_fast_type(t), "{t}");
        }
    }

    #[test]
    fn think_and_pin_override_and_leave_state_alone() {
        let mut s = RouterState::default();
        assert_eq!(route(&mut s, "rename this", true, None, true), Tier::Deep);
        assert_eq!(route(&mut s, "rename this", false, Some(Tier::Main), true), Tier::Main);
        assert_eq!(route(&mut s, "rename this", false, Some(Tier::Deep), true), Tier::Deep);
        assert_eq!(route(&mut s, "rename this", false, None, true), Tier::Fast, "state untouched by think/pin");
        assert_eq!(route(&mut s, "rename this", false, None, false), Tier::Main, "router off");
    }

    #[test]
    fn main_sticks_until_three_fast_turns_in_a_row() {
        let mut s = RouterState::default();
        assert_eq!(route(&mut s, "rename this", false, None, true), Tier::Fast);
        assert_eq!(route(&mut s, "give me 3 takes", false, None, true), Tier::Main);
        assert_eq!(route(&mut s, "rename this", false, None, true), Tier::Main);
        assert_eq!(route(&mut s, "tag it boss", false, None, true), Tier::Main);
        assert_eq!(route(&mut s, "give me 3 takes", false, None, true), Tier::Main, "a main-type turn resets the streak");
        for _ in 0..2 {
            assert_eq!(route(&mut s, "delete this", false, None, true), Tier::Main);
        }
        assert_eq!(route(&mut s, "delete that", false, None, true), Tier::Fast, "third in a row drops to fast");
        assert_eq!(route(&mut s, "delete that", false, None, true), Tier::Fast);
    }
}
