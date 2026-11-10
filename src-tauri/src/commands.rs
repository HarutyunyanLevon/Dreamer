//! Tauri commands exposed to the UI. Sync fns marked `async` run off the main thread,
//! so file IO never blocks the window.

use crate::error::{AppError, Result};
use crate::model::*;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub root: String,
    pub is_default: bool,
}

fn with_ws<T>(state: &State<AppState>, f: impl FnOnce(&crate::storage::Workspace) -> Result<T>) -> Result<T> {
    let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
    f(&guard)
}

#[tauri::command(async)]
pub fn workspace_info(state: State<AppState>) -> Result<WorkspaceInfo> {
    with_ws(&state, |ws| Ok(WorkspaceInfo { root: ws.root.display().to_string(), is_default: state.is_default_root() }))
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
pub fn claude_status() -> crate::sidecar::ClaudeStatus {
    crate::sidecar::claude_status()
}

#[tauri::command(async)]
pub fn claude_send(app: AppHandle, state: State<AppState>, slug: String, id: String, text: String, context: Option<String>) -> Result<()> {
    crate::sidecar::send_message(&app, &state, slug, id, text, context)
}

#[tauri::command(async)]
pub fn claude_interrupt(state: State<AppState>) -> Result<()> {
    crate::sidecar::interrupt(&state)
}
