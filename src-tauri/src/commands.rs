//! Tauri commands exposed to the UI. Sync fns marked `async` run off the main thread,
//! so file IO never blocks the window.

use crate::error::{AppError, Result};
use crate::model::*;
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub root: String,
    pub is_default: bool,
}

fn with_ws<T>(state: &State<AppState>, f: impl FnOnce(&crate::storage::Workspace) -> Result<T>) -> Result<T> {
    let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
    f(&guard)
}

/// Built from the already-locked workspace. It must not call anything that locks `state.ws` again:
/// std's `Mutex` is not re-entrant, and the old version (which called `state.is_default_root()`
/// here) deadlocked the whole core the first time the delete-project dialog asked for the path.
pub fn info_for(ws: &crate::storage::Workspace) -> WorkspaceInfo {
    WorkspaceInfo { root: ws.root.display().to_string(), is_default: ws.root == crate::state::default_root() }
}

#[tauri::command(async)]
pub fn workspace_info(state: State<AppState>) -> Result<WorkspaceInfo> {
    with_ws(&state, |ws| Ok(info_for(ws)))
}

#[tauri::command(async)]
pub fn set_workspace_root(app: AppHandle, state: State<AppState>, path: String) -> Result<WorkspaceInfo> {
    state.switch_root(&app, std::path::PathBuf::from(path))?;
    workspace_info(state)
}

#[tauri::command(async)]
pub fn get_settings(state: State<AppState>) -> Result<Settings> {
    with_ws(&state, |ws| ws.get_settings())
}

#[tauri::command(async)]
pub fn update_settings(app: AppHandle, state: State<AppState>, patch: SettingsPatch) -> Result<Settings> {
    let rehook = patch.hotkey.clone();
    let settings = with_ws(&state, |ws| ws.update_settings(patch))?;
    if rehook.is_some() {
        AppState::register_hotkey(&app, &settings.hotkey);
    }
    Ok(settings)
}

#[tauri::command(async)]
pub fn list_projects(state: State<AppState>) -> Result<Vec<ProjectSummary>> {
    with_ws(&state, |ws| ws.list_projects())
}

#[tauri::command(async)]
pub fn create_project(state: State<AppState>, name: String) -> Result<ProjectSummary> {
    with_ws(&state, |ws| ws.create_project(&name))
}

#[tauri::command(async)]
pub fn update_project(state: State<AppState>, slug: String, patch: ProjectPatch) -> Result<ProjectSummary> {
    with_ws(&state, |ws| ws.update_project(&slug, patch))
}

#[tauri::command(async)]
pub fn load_project(state: State<AppState>, slug: String) -> Result<ProjectData> {
    with_ws(&state, |ws| ws.load_project(&slug))
}

#[tauri::command(async)]
pub fn save_canvas(state: State<AppState>, slug: String, canvas: Canvas) -> Result<()> {
    with_ws(&state, |ws| ws.save_canvas(&slug, &canvas))
}

#[tauri::command(async)]
pub fn create_card(state: State<AppState>, slug: String, card: NewCard) -> Result<Card> {
    with_ws(&state, |ws| ws.create_card(&slug, card))
}

#[tauri::command(async)]
pub fn read_card(state: State<AppState>, slug: String, id: String) -> Result<Card> {
    with_ws(&state, |ws| ws.read_card(&slug, &id))
}

#[tauri::command(async)]
pub fn update_card(state: State<AppState>, slug: String, id: String, patch: CardPatch) -> Result<Card> {
    with_ws(&state, |ws| ws.update_card(&slug, &id, patch))
}

#[tauri::command(async)]
pub fn delete_card(state: State<AppState>, slug: String, id: String) -> Result<TrashItem> {
    with_ws(&state, |ws| ws.delete_card(&slug, &id))
}

/// Trash a card with a custom reason (e.g. "lost to <winner title>" when picking a fork's winner).
#[tauri::command(async)]
pub fn lose_card(state: State<AppState>, slug: String, id: String, reason: String) -> Result<TrashItem> {
    with_ws(&state, |ws| ws.trash_card(&slug, &id, &reason))
}

#[tauri::command(async)]
pub fn list_trash(state: State<AppState>, slug: String) -> Result<Vec<TrashItem>> {
    with_ws(&state, |ws| ws.list_trash(&slug))
}

#[tauri::command(async)]
pub fn restore_card(state: State<AppState>, slug: String, id: String) -> Result<Card> {
    with_ws(&state, |ws| ws.restore_card(&slug, &id))
}

#[tauri::command(async)]
pub fn empty_trash(state: State<AppState>, slug: String) -> Result<usize> {
    with_ws(&state, |ws| ws.empty_trash(&slug))
}

#[tauri::command(async)]
pub fn save_media(state: State<AppState>, slug: String, name_hint: String, bytes: Vec<u8>) -> Result<String> {
    with_ws(&state, |ws| ws.save_media(&slug, &name_hint, &bytes))
}

/// Returns the file as a base64-encoded string so the UI can use it as a data: URL without an asset-protocol scope.
#[tauri::command(async)]
pub fn read_media(state: State<AppState>, slug: String, rel: String) -> Result<String> {
    use base64::Engine;
    with_ws(&state, |ws| ws.read_project_file(&slug, &rel)).map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command(async)]
pub fn export_brief(state: State<AppState>, slug: String, id: String) -> Result<String> {
    with_ws(&state, |ws| ws.export_brief(&slug, &id))
}

#[tauri::command(async)]
pub fn list_custom_themes(state: State<AppState>) -> Result<Vec<Value>> {
    with_ws(&state, |ws| ws.list_custom_themes())
}

#[tauri::command(async)]
pub fn save_custom_theme(state: State<AppState>, id: String, theme: Value) -> Result<()> {
    with_ws(&state, |ws| ws.save_custom_theme(&id, theme))
}

#[tauri::command(async)]
pub fn delete_custom_theme(state: State<AppState>, id: String) -> Result<()> {
    with_ws(&state, |ws| ws.delete_custom_theme(&id))
}

#[tauri::command(async)]
pub fn claude_status(state: State<AppState>) -> crate::claude_setup::ClaudeStatus {
    crate::sidecar::claude_status(&state)
}

#[tauri::command(async)]
pub fn claude_install(app: AppHandle, state: State<AppState>) -> Result<()> {
    crate::claude_setup::start_install(&app, &state.claude.setup)
}

#[tauri::command(async)]
pub fn claude_login(app: AppHandle, state: State<AppState>) -> Result<()> {
    crate::claude_setup::start_login(&app, &state.claude.setup)
}

#[tauri::command(async)]
pub fn claude_setup_cancel(state: State<AppState>) {
    state.claude.setup.cancel();
}

#[tauri::command(async)]
pub fn claude_open_login_url(url: String) -> Result<()> {
    crate::claude_setup::open_login_url(&url)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn claude_send(
    app: AppHandle,
    state: State<AppState>,
    slug: String,
    id: String,
    text: String,
    context: Option<String>,
    thread: Option<String>,
    resume: Option<String>,
) -> Result<()> {
    crate::sidecar::send_message(&app, &state, crate::sidecar::Turn { slug, id, text, context, thread: thread.unwrap_or_else(|| "project".into()), resume })
}

#[tauri::command(async)]
pub fn claude_interrupt(state: State<AppState>) -> Result<()> {
    crate::sidecar::interrupt(&state)
}

/// Keyword search over card files (title > tags > fields > body). `project: None` searches
/// every project. Read-only; used by the Ctrl+K box and, via the sidecar, by Claude.
#[tauri::command(async)]
pub fn search_cards(state: State<AppState>, query: String, project: Option<String>, limit: Option<usize>) -> Result<Vec<crate::search::SearchHit>> {
    if let Some(p) = &project {
        crate::storage::check_slug(p)?;
    }
    state.with_search(|idx| idx.search(&query, project.as_deref(), limit.unwrap_or(20)))
}

/// User action from the sidebar (with an "Are you sure?" dialog). Moves the project folder to the
/// Recycle Bin when possible. Not exposed to Claude in any form.
/// The file watcher is stopped for the duration (dropping it releases its directory handle on
/// Windows) and started again afterwards; storage retries briefly on "in use" errors and never
/// half-deletes a folder that something still holds open (see `Workspace::delete_project`).
#[tauri::command(async)]
pub fn delete_project(app: AppHandle, state: State<AppState>, slug: String) -> Result<DeletedProject> {
    let out = state.with_watcher_paused(&app, || with_ws(&state, |ws| ws.delete_project(&slug, true)));
    if let Ok(mut idx) = state.search.lock() {
        idx.mark_dirty(None);
    }
    // The paused watcher didn't see the folder go: tell the UI directly (also on failure, so it
    // reloads whatever state the folder is in).
    let _ = app.emit("workspace-changed", vec![crate::watcher::ChangeEvent { scope: "project".into(), project: Some(slug.clone()) }]);
    out
}

#[tauri::command(async)]
pub fn load_chat(state: State<AppState>, slug: String, thread: String) -> Result<Value> {
    with_ws(&state, |ws| ws.load_chat(&slug, &thread))
}

#[tauri::command(async)]
pub fn save_chat(state: State<AppState>, slug: String, thread: String, data: Value) -> Result<()> {
    with_ws(&state, |ws| ws.save_chat(&slug, &thread, &data))
}

/// Clears one chat thread's file and tells the sidecar to drop that thread's Claude session, so
/// the next message starts a fresh one.
#[tauri::command(async)]
pub fn reset_chat(state: State<AppState>, slug: String, thread: String) -> Result<()> {
    with_ws(&state, |ws| ws.reset_chat(&slug, &thread))?;
    crate::sidecar::reset_thread(&state, &slug, &thread);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_info_reads_only_the_locked_workspace() {
        // Regression (fix pass #3, item 8): building the info while the workspace lock is held
        // must not need the lock again.
        let dir = tempfile::TempDir::new().unwrap();
        let lock = std::sync::Mutex::new(crate::storage::Workspace::open(dir.path().join("w")).unwrap());
        let guard = lock.lock().unwrap();
        let info = info_for(&guard);
        assert!(info.root.ends_with('w') && !info.is_default);
        assert!(lock.try_lock().is_err(), "the lock is still held by us, and info_for didn't need it");
    }

    #[test]
    fn no_command_touches_state_again_inside_with_ws() {
        // std::sync::Mutex isn't re-entrant: anything inside a `with_ws` closure that goes back to
        // `state` (and so possibly to `state.ws`) can deadlock every later command.
        let needle = ["with_ws(&state, ", "|"].concat();
        for (i, line) in include_str!("commands.rs").lines().enumerate() {
            if let Some(pos) = line.find(&needle) {
                let rest = &line[pos + needle.len()..];
                assert!(!rest.contains("state."), "commands.rs:{}: a with_ws closure uses `state` again: {line}", i + 1);
            }
        }
    }
}
