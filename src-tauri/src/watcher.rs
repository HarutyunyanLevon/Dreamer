//! Watches the workspace folder so external edits (Claude Code, git, an editor) show up live.

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

#[derive(Serialize, Clone, Debug, PartialEq, Eq, Hash)]
pub struct ChangeEvent {
    /// "project" | "settings" | "themes"
    pub scope: String,
    pub project: Option<String>,
}

pub type WatchHandle = Debouncer<notify::RecommendedWatcher>;

/// Map a changed path to the part of the app that should reload. Temp files and `.git` are ignored.
pub fn classify(root: &Path, path: &Path) -> Option<ChangeEvent> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| if let Component::Normal(s) = c { Some(s.to_string_lossy().into_owned()) } else { None })
        .collect();
    let first = parts.first()?;
    if parts.iter().any(|p| p == ".git") || parts.last().is_some_and(|f| f.ends_with(".tmp")) {
        return None;
    }
    match first.as_str() {
        "workspace.json" => Some(ChangeEvent { scope: "settings".into(), project: None }),
        "themes" => Some(ChangeEvent { scope: "themes".into(), project: None }),
        "inbox" => Some(ChangeEvent { scope: "project".into(), project: Some("inbox".into()) }),
        "projects" => Some(ChangeEvent { scope: "project".into(), project: parts.get(1).cloned() }),
        _ => None,
    }
}

/// Start watching `root`. `on_change` receives de-duplicated events, at most one burst per ~250ms.
pub fn start(root: PathBuf, on_change: impl Fn(Vec<ChangeEvent>) + Send + 'static) -> Result<WatchHandle, String> {
    let watch_root = root.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let set: HashSet<ChangeEvent> = events.iter().filter_map(|e| classify(&root, &e.path)).collect();
            if !set.is_empty() {
                on_change(set.into_iter().collect());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer.watcher().watch(&watch_root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    Ok(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_paths_and_ignores_noise() {
        let root = Path::new("/w");
        let ev = |p: &str| classify(root, Path::new(p));
        assert_eq!(ev("/w/projects/fish/cards/01A.md"), Some(ChangeEvent { scope: "project".into(), project: Some("fish".into()) }));
        assert_eq!(ev("/w/inbox/canvas.json"), Some(ChangeEvent { scope: "project".into(), project: Some("inbox".into()) }));
        assert_eq!(ev("/w/workspace.json"), Some(ChangeEvent { scope: "settings".into(), project: None }));
        assert_eq!(ev("/w/themes/mine.json").unwrap().scope, "themes");
        assert_eq!(ev("/w/projects/fish/cards/.01A.md.XYZ.tmp"), None);
        assert_eq!(ev("/w/.git/index"), None);
        assert_eq!(ev("/w/projects/fish/.git/HEAD"), None);
        assert_eq!(ev("/elsewhere/x"), None);
    }

    #[test]
    fn real_watcher_reports_an_external_file_change() {
        use std::sync::mpsc::channel;
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("inbox/cards")).unwrap();
        let (tx, rx) = channel();
        let _w = start(root.clone(), move |events| {
            let _ = tx.send(events);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(root.join("inbox/cards/01X.md"), "---\ntitle: x\n---\n").unwrap();
        let got = rx.recv_timeout(Duration::from_secs(5)).expect("no watcher event");
        assert!(got.contains(&ChangeEvent { scope: "project".into(), project: Some("inbox".into()) }));
    }
}
