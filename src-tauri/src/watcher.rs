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
    // <project>/chats/*.json is written by the chat panel itself on every turn; reloading the
    // canvas (and re-statting the search index) for those writes would be pure churn.
    let chats_at = if first == "inbox" { 1 } else { 2 };
    // design/ (handoff pack versions) is written only by Dreamer itself, which tells the UI when a
    // version is done; a canvas reload per copied asset would be churn too.
    if parts.get(chats_at).is_some_and(|p| p == "chats" || p == "design" || p == "builds") && parts.len() > chats_at + 1 {
        return None;
    }
    // artifacts/<id>/...: the artifact views reload that artifact; the canvas doesn't need to.
    if parts.get(chats_at).is_some_and(|p| p == "artifacts") && parts.len() > chats_at + 1 {
        return Some(ChangeEvent { scope: "artifact".into(), project: Some(if first == "inbox" { "inbox".into() } else { parts.get(1)?.clone() }) });
    }
    // memory.md and its log: only the Memory modal cares, not the canvas.
    if parts.len() == chats_at + 1 && parts.last().is_some_and(|f| f == "memory.md" || f == "memory.log.jsonl") {
        return Some(ChangeEvent { scope: "memory".into(), project: Some(if first == "inbox" { "inbox".into() } else { parts.get(1)?.clone() }) });
    }
    match first.as_str() {
        "workspace.json" => Some(ChangeEvent { scope: "settings".into(), project: None }),
        "themes" => Some(ChangeEvent { scope: "themes".into(), project: None }),
        "inbox" => Some(ChangeEvent { scope: "project".into(), project: Some("inbox".into()) }),
        "projects" => Some(ChangeEvent { scope: "project".into(), project: parts.get(1).cloned() }),
        _ => None,
    }
}

/// `QUESTIONS.md` (scope "questions") or `STATUS.md` (scope "status") of a project's handoff repo,
/// if `path` is one of them.
fn question_event(targets: &[(String, PathBuf)], path: &Path) -> Option<ChangeEvent> {
    let scope = match path.file_name()?.to_str()? {
        "QUESTIONS.md" => "questions",
        "STATUS.md" => "status",
        _ => return None,
    };
    targets
        .iter()
        .find(|(_, file)| path.parent() == file.parent())
        .map(|(slug, _)| ChangeEvent { scope: scope.into(), project: Some(slug.clone()) })
}

/// Start watching `root`, plus the `QUESTIONS.md` files in `questions` (project slug, file path;
/// they live in other repos). `on_change` receives de-duplicated events, at most one burst per ~250ms.
pub fn start(root: PathBuf, questions: Vec<(String, PathBuf)>, on_change: impl Fn(Vec<ChangeEvent>) + Send + 'static) -> Result<WatchHandle, String> {
    let watch_root = root.clone();
    let targets = questions.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let set: HashSet<ChangeEvent> = events.iter().filter_map(|e| classify(&root, &e.path).or_else(|| question_event(&targets, &e.path))).collect();
            if !set.is_empty() {
                on_change(set.into_iter().collect());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer.watcher().watch(&watch_root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    for (_, file) in &questions {
        // The folder (not the file) so a rewrite by rename is seen; a missing folder is skipped.
        if let Some(dir) = file.parent().filter(|d| d.is_dir()) {
            if let Err(e) = debouncer.watcher().watch(dir, RecursiveMode::NonRecursive) {
                eprintln!("[dreamer] cannot watch {}: {e}", dir.display());
            }
        }
    }
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
        assert_eq!(ev("/w/inbox/chats/01A.json"), None);
        assert_eq!(ev("/w/projects/fish/memory.md"), Some(ChangeEvent { scope: "memory".into(), project: Some("fish".into()) }));
        assert_eq!(ev("/w/projects/fish/memory.log.jsonl").unwrap().scope, "memory");
        assert_eq!(ev("/w/projects/fish/artifacts/01ABC/v1/hero.png"), Some(ChangeEvent { scope: "artifact".into(), project: Some("fish".into()) }));
        assert_eq!(ev("/w/inbox/artifacts/01ABC/artifact.json").unwrap().scope, "artifact");
        assert_eq!(ev("/w/projects/fish/chats/project.json"), None);
        assert_eq!(ev("/w/projects/fish/design/v1/01-gdd.md"), None);
        // A project whose slug is "chats" is still a real change.
        assert!(ev("/w/projects/chats/cards/01A.md").is_some());
        // Deleting a whole project folder still reports that project.
        assert_eq!(ev("/w/projects/fish"), Some(ChangeEvent { scope: "project".into(), project: Some("fish".into()) }));
    }

    #[test]
    fn repo_files_map_to_their_project_by_folder() {
        let t = vec![("fish".to_string(), PathBuf::from("/r/docs/design/QUESTIONS.md"))];
        let ev = |p: &str| question_event(&t, Path::new(p)).map(|e| (e.scope, e.project));
        assert_eq!(ev("/r/docs/design/STATUS.md"), Some(("status".into(), Some("fish".into()))));
        assert_eq!(ev("/r/docs/design/QUESTIONS.md"), Some(("questions".into(), Some("fish".into()))));
        assert_eq!(ev("/r/docs/design/OTHER.md"), None);
        assert_eq!(ev("/elsewhere/STATUS.md"), None);
    }

    #[test]
    fn real_watcher_reports_an_external_file_change() {
        use std::sync::mpsc::channel;
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("inbox/cards")).unwrap();
        let (tx, rx) = channel();
        let _w = start(root.clone(), Vec::new(), move |events| {
            let _ = tx.send(events);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(root.join("inbox/cards/01X.md"), "---\ntitle: x\n---\n").unwrap();
        let got = rx.recv_timeout(Duration::from_secs(5)).expect("no watcher event");
        assert!(got.contains(&ChangeEvent { scope: "project".into(), project: Some("inbox".into()) }));
    }
}
