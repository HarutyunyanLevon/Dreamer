use crate::error::{AppError, Result};
use crate::storage::Workspace;
use crate::watcher::{self, ChangeEvent, WatchHandle};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

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
        let hotkey = ws.get_settings()?.hotkey;
        let state = AppState {
            ws: Mutex::new(ws),
            claude: crate::sidecar::ClaudeState::default(),
            ollama: Default::default(),
            search: Arc::new(Mutex::new(crate::search::SearchIndex::default())),
            watcher: Mutex::new(None),
            config_path,
        };
        // The file watcher starts with the main window's first show (lib.rs), so an autostart boot stays light.
        Self::register_hotkey(app, &hotkey);
        Ok(state)
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
        match watcher::start(root, targets, move |events| {
            let mut out = Vec::new();
            for e in events {
                if e.scope == "questions" {
                    // Claude Code edited QUESTIONS.md: import new questions (our own answer writes are skipped).
                    let slug = e.project.clone().unwrap_or_default();
                    Self::import_questions(&handle, &slug, true);
                    out.push(ChangeEvent { scope: "project".into(), project: Some(slug) });
                } else {
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
    pub fn register_hotkey(app: &AppHandle, hotkey: &str) {
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();
        if let Err(e) = gs.register(hotkey) {
            eprintln!("[dreamer] could not register hotkey {hotkey:?}: {e}");
        }
    }
}
