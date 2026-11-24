//! Model routing for chat turns: a few string rules, no extra model call.
//!
//! * deep: only when the user turned on "Think harder" for this message.
//! * fast: a short message (< 200 chars) that is a simple action or lookup.
//! * main: everything else.
//!
//! Then the tier picks a backend ([`backend`]): with local chat on, fast and main both run on the
//! local model (Ollama) and only deep ("Think harder") goes to Claude, as do turns with web access
//! and "Retry with Claude". Such a Claude turn in a local thread is an *escalation*: one turn, then
//! the thread goes back to local. If Ollama isn't usable the turn falls back to Claude, visibly.
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

/// Where a turn runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Local,
    Claude,
}

/// Why a turn that would have been local went to Claude (shown under the reply).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    /// "Think harder" (or a pinned deep tier).
    Think,
    /// The globe: WebSearch / WebFetch run server-side at Anthropic, not through Ollama.
    Web,
    /// "Retry with Claude" on a failed local turn.
    Retry,
    /// Local chat is on but Ollama isn't usable right now.
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Route {
    pub backend: Backend,
    /// A one-turn Claude visit from a local thread: recap + last turns instead of the transcript.
    pub escalated: bool,
    pub reason: Option<Reason>,
}

/// Picks the backend for a turn whose tier is already decided. `local_on` = the setting,
/// `local_ready` = Ollama answered and has the model.
pub fn backend(tier: Tier, web: bool, retry: bool, local_on: bool, local_ready: bool) -> Route {
    let claude = |escalated, reason| Route { backend: Backend::Claude, escalated, reason };
    if !local_on {
        return claude(false, None);
    }
    let reason = if retry {
        Some(Reason::Retry)
    } else if tier == Tier::Deep {
        Some(Reason::Think)
    } else if web {
        Some(Reason::Web)
    } else {
        None
    };
    match (reason, local_ready) {
        (Some(r), true) => claude(true, Some(r)),
        // No local thread to escalate from: a plain Claude turn, as before local chat existed.
        (Some(r), false) => claude(false, Some(r)),
        (None, true) => Route { backend: Backend::Local, escalated: false, reason: None },
        (None, false) => claude(false, Some(Reason::Unavailable)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_and_main_run_locally_deep_goes_to_claude() {
        for tier in [Tier::Fast, Tier::Main] {
            assert_eq!(backend(tier, false, false, true, true), Route { backend: Backend::Local, escalated: false, reason: None }, "{tier:?}");
        }
        assert_eq!(backend(Tier::Deep, false, false, true, true), Route { backend: Backend::Claude, escalated: true, reason: Some(Reason::Think) });
        // A pinned deep tier is the same as Think.
        let mut s = RouterState::default();
        assert_eq!(backend(route(&mut s, "rename this", false, Some(Tier::Deep), true), false, false, true, true).reason, Some(Reason::Think));
        // Think from the router: deep, Claude, and the thread's hysteresis is untouched.
        let tier = route(&mut s, "rename this", true, None, true);
        assert_eq!(backend(tier, false, false, true, true).backend, Backend::Claude);
        assert_eq!(backend(route(&mut s, "rename this", false, None, true), false, false, true, true).backend, Backend::Local, "next turn back to local");
    }

    #[test]
    fn web_and_retry_escalate_one_turn() {
        assert_eq!(backend(Tier::Fast, true, false, true, true), Route { backend: Backend::Claude, escalated: true, reason: Some(Reason::Web) });
        assert_eq!(backend(Tier::Main, false, true, true, true), Route { backend: Backend::Claude, escalated: true, reason: Some(Reason::Retry) });
        assert_eq!(backend(Tier::Deep, true, true, true, true).reason, Some(Reason::Retry), "retry names itself first");
    }

    #[test]
    fn local_off_or_unavailable_uses_claude_as_before() {
        for tier in [Tier::Fast, Tier::Main, Tier::Deep] {
            assert_eq!(backend(tier, false, false, false, true), Route { backend: Backend::Claude, escalated: false, reason: None }, "setting off: no note");
        }
        assert_eq!(backend(Tier::Main, false, false, true, false), Route { backend: Backend::Claude, escalated: false, reason: Some(Reason::Unavailable) }, "visible fallback");
        assert_eq!(backend(Tier::Deep, false, false, true, false), Route { backend: Backend::Claude, escalated: false, reason: Some(Reason::Think) }, "no local thread to escalate from");
    }

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
