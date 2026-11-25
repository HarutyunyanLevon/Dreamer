use crate::error::{AppError, Result};
use crate::storage::Workspace;
use crate::watcher::{self, ChangeEvent, WatchHandle};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// The registered "Clipboard to Inbox" shortcut (the handler tells the two shortcuts apart by it).
pub static CLIPBOARD_SHORTCUT: Mutex<Option<tauri_plugin_global_shortcut::Shortcut>> = Mutex::new(None);
/// Why the last registration of [quick capture, clipboard] failed.
pub static HOTKEY_ERRORS: Mutex<[Option<String>; 2]> = Mutex::new([None, None]);

/// Remembers where the workspace lives (app config dir, not inside the workspace itself).
#[derive(Serialize, Deserialize, Default)]
struct AppConfig {
    workspace_root: Option<String>,
}

pub struct AppState {
    pub ws: Mutex<Workspace>,
    pub claude: crate::sidecar::ClaudeState,
    /// The local chat model (Ollama): status cache and the model download. See ollama.rs.
    pub ollama: crate::ollama::OllamaState,
    /// In-memory card search index; the file watcher marks projects dirty (see search.rs).
    pub search: Arc<Mutex<crate::search::SearchIndex>>,
    watcher: Mutex<Option<WatchHandle>>,
    config_path: PathBuf,
}

pub fn default_root() -> PathBuf {
    // DREAMER_WORKSPACE lets tests and dev runs use a throwaway folder.
    if let Ok(p) = std::env::var("DREAMER_WORKSPACE") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join("Dreamer")
}

impl AppState {
    pub fn init(app: &AppHandle) -> Result<AppState> {
        let config_dir = app.path().app_config_dir().map_err(|e| AppError::Invalid(e.to_string()))?;
        let config_path = config_dir.join("config.json");
        let cfg: AppConfig = std::fs::read_to_string(&config_path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let root = cfg.workspace_root.map(PathBuf::from).unwrap_or_else(default_root);
        let ws = Workspace::open(&root)?;
        let (hotkey, clip_hotkey) = {
            let s = ws.get_settings()?;
            (s.hotkey, s.clipboard_hotkey)
        };
        let state = AppState {
            ws: Mutex::new(ws),
            claude: crate::sidecar::ClaudeState::default(),
            ollama: Default::default(),
            search: Arc::new(Mutex::new(crate::search::SearchIndex::default())),
            watcher: Mutex::new(None),
            config_path,
        };
        // The file watcher starts with the main window's first show (lib.rs), so an autostart boot stays light.
        Self::register_hotkeys(app, &hotkey, &clip_hotkey);
        Ok(state)
    }

    /// An AppState on a given workspace folder, without the hotkey or the saved config (the
    /// reliability harness runs the real chat pipeline on a temp copy of a workspace).
    pub fn headless(root: PathBuf) -> Result<AppState> {
        let ws = Workspace::open(&root)?;
        Ok(AppState {
            ws: Mutex::new(ws),
            claude: crate::sidecar::ClaudeState::default(),
            ollama: Default::default(),
            search: Arc::new(Mutex::new(crate::search::SearchIndex::default())),
            watcher: Mutex::new(None),
            config_path: root.join(".harness-config.json"),
        })
    }

    /// Stops the file watcher (dropping it releases its handle on the workspace folder), runs `f`,
    /// then starts a fresh watcher on the current root. Used around deleting a project folder.
    /// `f` may lock `self.ws`; this function only locks it again after `f` has returned.
    pub fn with_watcher_paused<T>(&self, app: &AppHandle, f: impl FnOnce() -> T) -> T {
        let had = self.watcher.lock().map(|mut w| w.take().is_some()).unwrap_or(false);
        let out = f();
        if had {
            if let Ok(root) = self.ws.lock().map(|w| w.root.clone()) {
                self.start_watching(app, root);
            }
        }
        out
    }

    /// Runs `f` on the search index, pointed at the current workspace root.
    pub fn with_search<T>(&self, f: impl FnOnce(&mut crate::search::SearchIndex) -> T) -> Result<T> {
        let root = self.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.root.clone();
        let mut idx = self.search.lock().map_err(|_| AppError::Invalid("search index lock poisoned".into()))?;
        idx.set_root(&root);
        Ok(f(&mut idx))
    }

    fn start_watching(&self, app: &AppHandle, root: PathBuf) {
        let handle = app.clone();
        let search = self.search.clone();
        let targets = self.question_targets();
        let linked: std::collections::HashSet<String> = targets.iter().map(|t| t.0.clone()).collect();
        match watcher::start(root, targets, move |events| {
            let mut out = Vec::new();
            for e in events {
                let slug = e.project.clone().unwrap_or_default();
                if e.scope == "questions" {
                    // Claude Code edited QUESTIONS.md: import new questions (our own answer writes are skipped).
                    Self::import_questions(&handle, &slug, true);
                    out.push(ChangeEvent { scope: "project".into(), project: Some(slug) });
                } else if e.scope == "status" {
                    // Claude Code edited STATUS.md (Dreamer only ever creates it empty): apply what changed.
                    Self::import_status(&handle, &slug);
                    out.push(ChangeEvent { scope: "project".into(), project: Some(slug) });
                } else {
                    if e.scope == "project" && !slug.is_empty() {
                        // An external edit may have changed a built card's content ("Needs rebuild"),
                        // and the repo's link file follows the cards (debounced).
                        Self::refresh_drift(&handle, &slug);
                        if linked.contains(&slug) {
                            Self::schedule_link(&handle, &slug);
                        }
                    }
                    out.push(e);
                }
            }
            if let Ok(mut idx) = search.lock() {
                for e in &out {
                    if e.scope == "project" {
                        idx.mark_dirty(e.project.as_deref());
                    }
                }
            }
            let _ = handle.emit("workspace-changed", out);
        }) {
            Ok(w) => *self.watcher.lock().unwrap() = Some(w),
            Err(e) => eprintln!("[dreamer] file watcher unavailable: {e}"),
        }
    }

    /// (project slug, QUESTIONS.md path) for every project with a handoff folder.
    fn question_targets(&self) -> Vec<(String, PathBuf)> {
        let Ok(ws) = self.ws.lock() else { return Vec::new() };
        ws.list_projects()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| {
                let target = ws.load_project(&p.slug).ok()?.meta.handoff_target.filter(|t| !t.trim().is_empty())?;
                Some((p.slug, crate::questions::questions_path(std::path::Path::new(&target))))
            })
            .collect()
    }

    /// Imports unchecked QUESTIONS.md lines into the project's "From Claude Code" card.
    fn import_questions(app: &AppHandle, slug: &str, skip_own: bool) {
        let Some(state) = app.try_state::<AppState>() else { return };
        let Ok(ws) = state.ws.lock() else { return };
        if skip_own {
            let own = ws.load_project(slug).ok().and_then(|d| d.meta.handoff_target).is_some_and(|t| crate::questions::is_own_write(&crate::questions::questions_path(std::path::Path::new(&t))));
            if own {
                return;
            }
        }
        if let Err(e) = crate::questions::import(&ws, slug) {
            eprintln!("[dreamer] could not import design questions for {slug}: {e}");
        }
    }

    /// Applies STATUS.md changes of one project and tells the UI ("build-update") what happened.
    fn import_status(app: &AppHandle, slug: &str) {
        let Some(state) = app.try_state::<AppState>() else { return };
        let Ok(ws) = state.ws.lock() else { return };
        match ws.sync_status(slug) {
            Ok(r) if r.changed() || !r.warnings.is_empty() => {
                let _ = app.emit("build-update", &r);
            }
            Ok(_) => {}
            Err(e) => eprintln!("[dreamer] could not read the build status for {slug}: {e}"),
        }
    }

    /// Recomputes "Needs rebuild" for the project's built cards (a no-op unless one changed on disk).
    fn refresh_drift(app: &AppHandle, slug: &str) {
        let Some(state) = app.try_state::<AppState>() else { return };
        let Ok(ws) = state.ws.lock() else { return };
        if let Err(e) = ws.refresh_dirty_all(slug) {
            eprintln!("[dreamer] could not check built cards of {slug}: {e}");
        }
    }

    /// Writes `<repo>/.dreamer/link.json` about 5 seconds after the last request for this project.
    pub fn schedule_link(app: &AppHandle, slug: &str) {
        static PENDING: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);
        if !PENDING.lock().map(|mut p| p.get_or_insert_with(Default::default).insert(slug.to_string())).unwrap_or(false) {
            return;
        }
        let (app, slug) = (app.clone(), slug.to_string());
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            if let Ok(mut p) = PENDING.lock() {
                p.get_or_insert_with(Default::default).remove(&slug);
            }
            Self::write_link_now(&app, &slug);
        });
    }

    /// Writes the repo link file right away (version switch, export).
    pub fn write_link_now(app: &AppHandle, slug: &str) {
        let Some(state) = app.try_state::<AppState>() else { return };
        let Ok(ws) = state.ws.lock() else { return };
        if let Err(e) = ws.write_link(slug) {
            eprintln!("[dreamer] could not write the repo link file for {slug}: {e}");
        }
    }

    /// Re-targets the watcher after a handoff folder changed, and imports what is already there.
    pub fn refresh_questions(&self, app: &AppHandle, rewatch: bool) {
        if rewatch {
            if let Ok(root) = self.ws.lock().map(|w| w.root.clone()) {
                self.start_watching(app, root);
            }
        }
        let app = app.clone();
        let slugs: Vec<String> = self.question_targets().into_iter().map(|t| t.0).collect();
        std::thread::spawn(move || {
            let mut events = Vec::new();
            for s in slugs {
                Self::import_questions(&app, &s, false);
                Self::import_status(&app, &s);
                Self::write_link_now(&app, &s);
                events.push(ChangeEvent { scope: "project".into(), project: Some(s) });
            }
            if !events.is_empty() {
                let _ = app.emit("workspace-changed", events);
            }
        });
    }

    /// Point the app at a different workspace folder (created if needed) and persist the choice.
    pub fn switch_root(&self, app: &AppHandle, root: PathBuf) -> Result<()> {
        let ws = Workspace::open(&root)?;
        *self.watcher.lock().unwrap() = None; // drop the old watcher first
        *self.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))? = ws;
        if let Ok(mut idx) = self.search.lock() {
            idx.set_root(&root);
        }
        self.start_watching(app, root.clone());
        let cfg = AppConfig { workspace_root: Some(root.display().to_string()) };
        if let Some(dir) = self.config_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| AppError::io("create config dir", e))?;
        }
        crate::storage::atomic_write(&self.config_path, serde_json::to_string_pretty(&cfg).unwrap().as_bytes())?;
        let _ = app.emit("workspace-changed", vec![watcher::ChangeEvent { scope: "settings".into(), project: None }]);
        Ok(())
    }

    /// Replace the globally registered quick-capture shortcut. Best-effort: an invalid or already-taken
    /// combo logs a warning instead of failing the whole settings update.
    /// Registers both global shortcuts (quick capture, "Clipboard to Inbox"). The error of each
    /// (None = fine) is kept for the settings page (`hotkey_status`).
    pub fn register_hotkeys(app: &AppHandle, capture: &str, clipboard: &str) {
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();
        let mut errs: [Option<String>; 2] = [None, None];
        if let Err(e) = gs.register(capture) {
            eprintln!("[dreamer] could not register hotkey {capture:?}: {e}");
            errs[0] = Some(e.to_string());
        }
        match clipboard.parse::<tauri_plugin_global_shortcut::Shortcut>() {
            Ok(sc) => {
                if let Err(e) = gs.register(sc) {
                    eprintln!("[dreamer] could not register hotkey {clipboard:?}: {e}");
                    errs[1] = Some(e.to_string());
                } else if let Ok(mut c) = CLIPBOARD_SHORTCUT.lock() {
                    *c = Some(sc);
                }
            }
            Err(e) => errs[1] = Some(e.to_string()),
        }
        if errs[1].is_some() {
            if let Ok(mut c) = CLIPBOARD_SHORTCUT.lock() {
                *c = None;
            }
        }
        if let Ok(mut s) = HOTKEY_ERRORS.lock() {
            *s = errs;
        }
    }
}
