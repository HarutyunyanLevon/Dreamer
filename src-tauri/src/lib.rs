mod artifacts;
mod bundle;
mod claude_setup;
mod clip;
mod commands;
mod credentials;
mod ctx;
mod error;
mod handoff;
mod memory;
mod model;
mod organize;
mod organize_pipeline;
mod proc_guard;
mod router;
mod search;
mod sidecar;
mod sidecar_log;
mod state;
mod storage;
mod watcher;

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Ends the Claude sidecar's whole process tree, then exits. `RunEvent::Exit` below also stops
/// the sidecar, for any other way out.
pub fn quit(app: &AppHandle) {
    sidecar::shutdown(&app.state::<state::AppState>());
    app.exit(0);
}

/// Shows the main window, creating it on first use.
fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Dreamer")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1100.0, 600.0)
        // Without this Windows swallows file drops, so the page never sees dropped images or bundles.
        .disable_drag_drop_handler()
        .build();
    if built.is_err() {
        return;
    }
    let state = app.state::<state::AppState>();
    if let Ok(root) = state.ws.lock().map(|w| w.root.clone()) {
        state.start_watching(app, root);
    }
}

/// The app's compiled config and assets (shared with the headless reliability harness).
pub(crate) fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // One taskbar identity for the pinned shortcut and the window: the identifier, which the NSIS installer
    // also stamps on the Start menu shortcut.
    #[cfg(windows)]
    {
        let id: Vec<u16> = "app.dreamer.desktop".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
    }
    tauri::Builder::default()
        // A second launch (Start menu, double-click) just shows the running instance's window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = state::AppState::init(app.handle())?;
            app.manage(state);

            show_main_window(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_info,
            commands::set_workspace_root,
            commands::get_settings,
            commands::update_settings,
            commands::list_projects,
            commands::create_project,
            commands::update_project,
            commands::link_repo,
            commands::load_project,
            commands::save_canvas,
            commands::migration_status,
            commands::create_card,
            commands::read_card,
            commands::update_card,
            commands::delete_card,
            commands::lose_card,
            commands::list_trash,
            commands::restore_card,
            commands::empty_trash,
            commands::save_media,
            commands::add_attachment,
            commands::update_attachment,
            commands::remove_attachment,
            commands::reorder_attachments,
            commands::read_media,
            commands::fetch_clip,
            commands::refresh_clip,
            commands::open_url,
            commands::claude_status,
            commands::claude_install,
            commands::claude_login,
            commands::claude_setup_cancel,
            commands::claude_open_login_url,
            commands::claude_send,
            commands::claude_interrupt,
            commands::search_cards,
            commands::handoff_start,
            commands::handoff_cancel,
            commands::open_logs_folder,
            commands::pick_folder,
            commands::delete_project,
            commands::load_chat,
            commands::save_chat,
            commands::reset_chat,
            commands::list_chats,
            commands::dismiss_proposal,
            commands::restore_proposal,
            commands::memory_get,
            commands::memory_save,
            commands::memory_history,
            commands::memory_revert,
            commands::memory_undo,
            commands::memory_seed,
            commands::artifact_create,
            commands::artifact_get,
            commands::artifact_update,
            commands::artifact_file,
            commands::artifact_version_info,
            commands::artifact_set_active_theme,
            commands::artifact_themes,
            commands::artifact_theme_css,
            commands::artifact_html,
            commands::claude_credit_answer,
            commands::spritecook_balance,
            commands::spritecook_key_status,
            commands::spritecook_set_key,
            commands::parse_bundle,
            commands::apply_bundle,
            commands::undo_bundle,
            commands::scan_imports,
            commands::read_import,
            commands::archive_import,
        ])
        .build(context())
        .expect("error while building Dreamer")
        .run(|app, event| {
            // However the app ends (app.exit, last window gone), the sidecar tree goes too.
            if let RunEvent::Exit = event {
                sidecar::shutdown(&app.state::<state::AppState>());
            }
        });
}
