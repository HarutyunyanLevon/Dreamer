use crate::error::{AppError, Result};
use crate::storage::Workspace;
use crate::watcher::{self, WatchHandle};
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
            search: Arc::new(Mutex::new(crate::search::SearchIndex::default())),
            watcher: Mutex::new(None),
            config_path,
        };
        state.start_watching(app, root);
        Self::register_hotkey(app, &hotkey);
        Ok(state)
    }

    pub fn is_default_root(&self) -> bool {
        self.ws.lock().map(|w| w.root == default_root()).unwrap_or(false)
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
        match watcher::start(root, move |events| {
            if let Ok(mut idx) = search.lock() {
                for e in &events {
                    if e.scope == "project" {
                        idx.mark_dirty(e.project.as_deref());
                    }
                }
            }
            let _ = handle.emit("workspace-changed", events);
        }) {
            Ok(w) => *self.watcher.lock().unwrap() = Some(w),
            Err(e) => eprintln!("[dreamer] file watcher unavailable: {e}"),
        }
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
