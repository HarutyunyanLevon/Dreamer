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
pub fn update_settings(state: State<AppState>, patch: SettingsPatch) -> Result<Settings> {
    let before = with_ws(&state, |ws| ws.get_settings())?.spritecook_url;
    let settings = with_ws(&state, |ws| ws.update_settings(patch))?;
    // The sidecar gets the SpriteCook server at spawn: a new URL needs a fresh one.
    if settings.spritecook_url != before {
        crate::sidecar::shutdown(&state);
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

/// "Link repo…" confirmed: sets and confirms the folder the design pack is written into.
#[tauri::command(async)]
pub fn link_repo(state: State<AppState>, slug: String, path: String) -> Result<ProjectSummary> {
    with_ws(&state, |ws| ws.link_repo(&slug, &path))
}
#[tauri::command(async)]
pub fn load_project(state: State<AppState>, slug: String) -> Result<ProjectData> {
    with_ws(&state, |ws| ws.load_project(&slug))
}

#[tauri::command(async)]
pub fn save_canvas(state: State<AppState>, slug: String, canvas: Canvas) -> Result<()> {
    with_ws(&state, |ws| ws.save_canvas(&slug, &canvas))
}

/// Why the workspace opened read-only (a failed layout migration), or null.
#[tauri::command(async)]
pub fn migration_status(state: State<AppState>) -> Result<Option<String>> {
    with_ws(&state, |ws| Ok(ws.read_only()))
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
pub fn restore_card(state: State<AppState>, slug: String, id: String) -> Result<Value> {
    with_ws(&state, |ws| ws.restore_item(&slug, &id))
}

#[tauri::command(async)]
pub fn empty_trash(state: State<AppState>, slug: String) -> Result<usize> {
    with_ws(&state, |ws| ws.empty_trash(&slug))
}

/// Saves one or more files under `media/`; returns their paths in order.
#[tauri::command(async)]
pub fn save_media(state: State<AppState>, slug: String, files: Vec<MediaUpload>) -> Result<Vec<String>> {
    with_ws(&state, |ws| ws.save_media_many(&slug, &files))
}

#[tauri::command(async)]
pub fn add_attachment(state: State<AppState>, slug: String, card: String, attachment: Attachment) -> Result<Card> {
    with_ws(&state, |ws| ws.add_attachment(&slug, &card, attachment))
}

#[tauri::command(async)]
pub fn update_attachment(state: State<AppState>, slug: String, card: String, att_id: String, patch: Value) -> Result<Card> {
    with_ws(&state, |ws| ws.update_attachment(&slug, &card, &att_id, &patch))
}

#[tauri::command(async)]
pub fn remove_attachment(state: State<AppState>, slug: String, card: String, att_id: String) -> Result<Card> {
    with_ws(&state, |ws| ws.remove_attachment(&slug, &card, &att_id))
}

#[tauri::command(async)]
pub fn reorder_attachments(state: State<AppState>, slug: String, card: String, ids: Vec<String>) -> Result<Card> {
    with_ws(&state, |ws| ws.reorder_attachments(&slug, &card, &ids))
}

/// Removes a card's pending Claude proposal (after the UI applied it, or the user dismissed it).
#[tauri::command(async)]
pub fn dismiss_proposal(state: State<AppState>, slug: String, id: String) -> Result<()> {
    with_ws(&state, |ws| ws.delete_proposal(&slug, &id))
}

/// Puts a dismissed proposal back (Undo of "Dismiss all").
#[tauri::command(async)]
pub fn restore_proposal(state: State<AppState>, slug: String, id: String, proposal: Value) -> Result<()> {
    with_ws(&state, |ws| ws.write_proposal(&slug, &id, &proposal))
}

/// The project's memory (normalized text, word count, cap). The Inbox has none.
#[tauri::command(async)]
pub fn memory_get(state: State<AppState>, slug: String) -> Result<crate::memory::View> {
    with_ws(&state, |ws| crate::memory::view(ws, &slug))
}

/// The Memory modal's Save (`source` "user") and the seed's Keep / Start empty ("seed").
#[tauri::command(async)]
pub fn memory_save(state: State<AppState>, slug: String, text: String, source: String) -> Result<crate::memory::View> {
    with_ws(&state, |ws| {
        crate::memory::save_text(&ws.existing_project_dir(&slug)?, &text, &source)?;
        crate::memory::view(ws, &slug)
    })
}

/// Change log entries, newest first: {at, source, thread, ops, before, after}.
#[tauri::command(async)]
pub fn memory_history(state: State<AppState>, slug: String) -> Result<Vec<Value>> {
    with_ws(&state, |ws| Ok(crate::memory::history(&ws.existing_project_dir(&slug)?, 200)))
}

#[tauri::command(async)]
pub fn memory_revert(state: State<AppState>, slug: String, at: String) -> Result<crate::memory::View> {
    with_ws(&state, |ws| {
        crate::memory::revert(&ws.existing_project_dir(&slug)?, &at)?;
        crate::memory::view(ws, &slug)
    })
}

/// Undo on a chat turn's "Memory updated" line: reverts its log entries and removes the decision
/// lines it drafted onto a card.
#[tauri::command(async)]
pub fn memory_undo(state: State<AppState>, slug: String, ats: Vec<String>, card: Option<String>, lines: Option<Vec<String>>) -> Result<()> {
    with_ws(&state, |ws| {
        let dir = ws.existing_project_dir(&slug)?;
        for at in ats.iter().rev() {
            crate::memory::revert(&dir, at)?;
        }
        if let (Some(id), Some(lines)) = (&card, &lines) {
            crate::memory::remove_card_decisions(ws, &slug, id, lines)?;
        }
        Ok(())
    })
}

/// Starts the one-time seed query for a project with no memory yet; the draft arrives as a `memory-event`.
#[tauri::command(async)]
pub fn memory_seed(app: AppHandle, state: State<AppState>, slug: String) -> Result<()> {
    crate::memory::seed(&app, &state, &slug)
}

/// Fetches a page (8s, 3 MB cap) into a new clip attachment; its files land under `media/`.
/// Never fails on the network side: a failed fetch returns a bare clip with `fetch_error`.
/// The UI adds the returned attachment to the card (so the add is one undoable card edit).
#[tauri::command]
pub async fn fetch_clip(state: State<'_, AppState>, slug: String, url: String) -> Result<Attachment> {
    with_ws(&state, |ws| ws.project_dir(&slug).map(|_| ()))?;
    let id = ulid::Ulid::generate().to_string();
    let fetched = crate::clip::fetch(&url).await;
    with_ws(&state, |ws| ws.store_clip(&slug, &id, &url, fetched))
}

/// Re-fetches a clip in place (same id, caption kept). On failure only `fetch_error` changes.
#[tauri::command]
pub async fn refresh_clip(state: State<'_, AppState>, slug: String, card: String, att_id: String) -> Result<Card> {
    let url = with_ws(&state, |ws| {
        let c = ws.read_card(&slug, &card)?;
        c.meta.attachments.iter().find_map(|a| match a {
            Attachment::Clip { id, url, .. } if id == &att_id => Some(url.clone()),
            _ => None,
        }).ok_or_else(|| AppError::NotFound(format!("clip {att_id}")))
    })?;
    let fetched = crate::clip::fetch(&url).await;
    with_ws(&state, |ws| {
        let patch = if let Some(err) = &fetched.error {
            serde_json::json!({ "fetch_error": err, "fetched_at": crate::storage::now() })
        } else {
            let mut v = serde_json::to_value(ws.store_clip(&slug, &att_id, &url, fetched)?).map_err(|e| AppError::Invalid(e.to_string()))?;
            let o = v.as_object_mut().expect("clip serializes to an object");
            o.remove("caption");
            for k in ["title", "description", "site", "favicon", "thumb", "excerpt", "fetch_error"] {
                o.entry(k).or_insert(Value::Null);
            }
            v
        };
        ws.update_attachment(&slug, &card, &att_id, &patch)
    })
}

#[tauri::command(async)]
pub fn open_url(url: String) -> Result<()> {
    crate::claude_setup::open_in_browser(&url)
}

/// Returns the file as a base64-encoded string so the UI can use it as a data: URL without an asset-protocol scope.
#[tauri::command(async)]
pub fn read_media(state: State<AppState>, slug: String, rel: String) -> Result<String> {
    use base64::Engine;
    with_ws(&state, |ws| ws.read_project_file(&slug, &rel)).map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Starts the handoff pack generation as a one-shot
/// Claude session; progress and results arrive as `handoff-event`s tagged with the returned job id.
#[tauri::command(async)]
pub fn handoff_start(app: AppHandle, state: State<AppState>, slug: String, spec: crate::handoff::ScopeSpec) -> Result<String> {
    crate::handoff::start(&app, &state, &slug, spec)
}

/// Interrupts the running handoff session; nothing it produced is written.
#[tauri::command(async)]
pub fn handoff_cancel(state: State<AppState>) -> Result<()> {
    crate::handoff::cancel(&state)
}

/// Shows the logs folder (sidecar.log) in the file manager, creating it if nothing was logged yet.
#[tauri::command(async)]
pub fn open_logs_folder() -> Result<()> {
    let dir = crate::sidecar_log::dir();
    std::fs::create_dir_all(&dir).map_err(|e| AppError::io("create the logs folder", e))?;
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program).arg(&dir).spawn().map_err(|e| AppError::io("open the folder", e))?;
    Ok(())
}

/// Native folder picker (the handoff repo target). `None` when the user cancelled.
#[tauri::command(async)]
pub fn pick_folder(app: AppHandle, title: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut d = app.dialog().file();
    if let Some(t) = title {
        d = d.set_title(t);
    }
    d.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
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
    web: Option<bool>,
    selection: Option<Vec<String>>,
    memory: Option<bool>,
    question: Option<String>,
    think: Option<bool>,
    pin: Option<String>,
    scope_ids: Option<Vec<String>>,
    scope_name: Option<String>,
    organize: Option<String>,
    organize_instruction: Option<String>,
    organize_prior: Option<serde_json::Value>,
    organize_rest: Option<bool>,
    artifact: Option<String>,
    recap_from: Option<String>,
) -> Result<()> {
    let turn = crate::sidecar::Turn {
        slug,
        id,
        text,
        context,
        thread: thread.unwrap_or_else(|| "project".into()),
        scope: crate::organize::Scope::new(organize.as_deref(), scope_name, scope_ids),
        resume,
        web: web.unwrap_or(false),
        selection: selection.unwrap_or_default(),
        memory: memory.unwrap_or(true),
        question,
        think: think.unwrap_or(false),
        pin: pin.as_deref().and_then(crate::router::Tier::parse),
        organize: organize.map(|s| if matches!(s.as_str(), "frame" | "selection") { s } else { "project".to_string() }),
        organize_instruction,
        organize_prior: organize_prior.filter(|v| v.is_object()),
        organize_rest: organize_rest.unwrap_or(false),
        artifact: artifact.filter(|a| !a.is_empty()),
        recap_from: recap_from.filter(|a| !a.is_empty()),
    };
    crate::sidecar::send_message(&app, &state, turn)
}

#[tauri::command(async)]
pub fn claude_interrupt(state: State<AppState>, hard: Option<bool>) -> Result<()> {
    crate::sidecar::interrupt(&state, hard.unwrap_or(false))
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

/// Card thread ids with a saved file, newest first.
#[tauri::command(async)]
pub fn list_chats(state: State<AppState>, slug: String) -> Result<Vec<String>> {
    with_ws(&state, |ws| ws.list_chats(&slug))
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

/// Whether a SpriteCook API key is stored (masked), and the server URL.
#[tauri::command(async)]
pub fn spritecook_key_status(state: State<AppState>) -> Result<serde_json::Value> {
    let url = with_ws(&state, |ws| ws.get_settings())?.spritecook_url;
    let key = crate::credentials::spritecook_key();
    Ok(serde_json::json!({ "hasKey": key.is_some(), "masked": key.as_deref().map(crate::credentials::mask), "url": url }))
}

/// Stores the SpriteCook API key in the OS credential store (empty = remove it). The running
/// sidecar is stopped so the next artifact turn starts one that has (or lacks) the key.
#[tauri::command(async)]
pub fn spritecook_set_key(state: State<AppState>, key: String) -> Result<serde_json::Value> {
    crate::credentials::set_spritecook_key(&key)?;
    crate::sidecar::shutdown(&state);
    spritecook_key_status(state)
}

// ---------- artifacts (artifacts.rs) ----------

#[tauri::command(async)]
pub fn claude_credit_answer(state: State<AppState>, req_id: String, allow: bool) -> Result<()> {
    crate::sidecar::credit_answer(&state, &req_id, allow);
    Ok(())
}

/// The balance arrives as a `spritecook_balance` claude-event.
#[tauri::command(async)]
pub fn spritecook_balance(app: AppHandle, state: State<AppState>) -> Result<()> {
    if crate::credentials::spritecook_key().is_none() {
        let _ = app.emit("claude-event", serde_json::json!({ "type": "spritecook_balance", "credits": null, "error": "no_key" }));
        return Ok(());
    }
    crate::sidecar::spritecook_balance(&app, &state)
}

#[tauri::command(async)]
pub fn artifact_create(state: State<AppState>, slug: String, artifact: crate::artifacts::NewArtifact) -> Result<Card> {
    let card = with_ws(&state, |ws| crate::artifacts::create(ws, &slug, artifact))?;
    if let Ok(mut idx) = state.search.lock() {
        idx.mark_dirty(Some(&slug));
    }
    Ok(card)
}

#[tauri::command(async)]
pub fn artifact_get(state: State<AppState>, slug: String, id: String) -> Result<Value> {
    with_ws(&state, |ws| crate::artifacts::view(ws, &slug, &id))
}

#[tauri::command(async)]
pub fn artifact_update(state: State<AppState>, slug: String, id: String, patch: crate::artifacts::ArtifactPatch) -> Result<Value> {
    with_ws(&state, |ws| {
        crate::artifacts::update(ws, &slug, &id, patch)?;
        crate::artifacts::view(ws, &slug, &id)
    })
}

/// One file of a version, base64 (previews and the full-size view).
#[tauri::command(async)]
pub fn artifact_file(state: State<AppState>, slug: String, id: String, version: u32, file: String) -> Result<String> {
    use base64::Engine;
    with_ws(&state, |ws| crate::artifacts::read_file(ws, &slug, &id, version, &file)).map(|b| base64::engine::general_purpose::STANDARD.encode(b))
}

/// brief.md, meta.json and notes.md of a version.
#[tauri::command(async)]
pub fn artifact_version_info(state: State<AppState>, slug: String, id: String, version: u32) -> Result<Value> {
    with_ws(&state, |ws| crate::artifacts::version_info(ws, &slug, &id, version))
}

/// `id: null` clears the active theme.
#[tauri::command(async)]
pub fn artifact_set_active_theme(state: State<AppState>, slug: String, id: Option<String>) -> Result<()> {
    with_ws(&state, |ws| crate::artifacts::set_active_theme(ws, &slug, id.as_deref()))
}

/// An HTML version bundled for the sandboxed iframe (CSP, theme tokens, files inlined).
/// `head`: extra head markup from the UI (the bundled fonts as data: @font-face rules).
#[tauri::command(async)]
pub fn artifact_html(state: State<AppState>, slug: String, id: String, version: u32, head: Option<String>) -> Result<String> {
    let head = head.unwrap_or_default();
    // Only <style> blocks may be added (fonts); nothing that runs.
    if head.to_ascii_lowercase().contains("<script") {
        return Err(AppError::Invalid("head may only add styles".into()));
    }
    with_ws(&state, |ws| crate::artifacts::render_html(ws, &slug, &id, version, &head))
}

/// The theme CSS (custom properties) an HTML version of this artifact gets.
#[tauri::command(async)]
pub fn artifact_theme_css(state: State<AppState>, slug: String, id: String) -> Result<String> {
    with_ws(&state, |ws| {
        let meta = crate::artifacts::read(ws, &slug, &id)?;
        let inherited = crate::artifacts::inherited_theme(ws, &slug, &id, &meta);
        let own = (meta.kind == "theme").then(|| meta.version(meta.current_version).and_then(|v| v.theme.clone())).flatten();
        let mode = crate::artifacts::effective_art_mode(&meta, inherited.as_ref());
        Ok(crate::artifacts::theme_css(own.as_ref().or(inherited.as_ref().map(|t| &t.spec)), mode.as_ref()))
    })
}

#[tauri::command(async)]
pub fn artifact_themes(state: State<AppState>, slug: String) -> Result<Vec<Value>> {
    with_ws(&state, |ws| Ok(crate::artifacts::themes(ws, &slug)))
}

// ----- bundles, clipboard, drop folders -----

#[tauri::command(async)]
pub fn parse_bundle(state: State<AppState>, text: String, target: Option<crate::storage::Target>) -> Result<crate::storage::ImportPlan> {
    with_ws(&state, |ws| ws.plan_bundle(&text, &target.unwrap_or_default()))
}

#[tauri::command(async)]
pub fn apply_bundle(state: State<AppState>, text: String, target: Option<crate::storage::Target>) -> Result<crate::storage::ImportResult> {
    with_ws(&state, |ws| ws.apply_bundle(&text, &target.unwrap_or_default()))
}

#[tauri::command(async)]
pub fn undo_bundle(state: State<AppState>, result: crate::storage::ImportResult) -> Result<()> {
    with_ws(&state, |ws| ws.undo_import(&result))
}

#[tauri::command(async)]
pub fn scan_imports(state: State<AppState>) -> Result<Vec<crate::storage::ImportOffer>> {
    with_ws(&state, |ws| Ok(ws.scan_imports()))
}

#[tauri::command(async)]
pub fn read_import(state: State<AppState>, path: String) -> Result<String> {
    with_ws(&state, |ws| ws.read_import(&path))
}

#[tauri::command(async)]
pub fn archive_import(state: State<AppState>, path: String) -> Result<()> {
    with_ws(&state, |ws| ws.archive_import(&path))
}
