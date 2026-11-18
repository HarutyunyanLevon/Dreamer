mod artifacts;
mod claude_setup;
mod clip;
mod commands;
mod credentials;
mod ctx;
mod error;
mod handoff;
mod memory;
mod model;
mod ollama;
mod organize;
mod proc_guard;
mod questions;
mod router;
mod search;
mod sidecar;
mod sidecar_log;
mod state;
mod storage;
mod watcher;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// Set while the one-time "still running in the tray" notice is on screen, so a second click on
/// the window's X hides it (never a dead X, even if the page doesn't answer).
static TRAY_NOTICE_PENDING: AtomicBool = AtomicBool::new(false);

/// Quits for real (tray "Quit", sidebar "Quit Dreamer"): ends the Claude sidecar's whole process
/// tree, then exits. `RunEvent::Exit` below also stops the sidecar, for any other way out.
pub fn quit(app: &AppHandle) {
    sidecar::shutdown(&app.state::<state::AppState>());
    app.exit(0);
}

/// Hides the main window to the tray and remembers that the tray notice has been seen.
pub fn hide_to_tray(app: &AppHandle) {
    TRAY_NOTICE_PENDING.store(false, Ordering::SeqCst);
    if let Ok(ws) = app.state::<state::AppState>().ws.lock() {
        let _ = ws.update_settings(model::SettingsPatch { tray_notice_shown: Some(true), ..Default::default() });
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}
use tauri_plugin_global_shortcut::ShortcutState;

/// When the capture popup was last shown. Losing focus within `CAPTURE_BLUR_GRACE` of being
/// shown doesn't close it: Windows' focus-stealing rules can hand a freshly shown window focus
/// and take it straight back, and hide-on-blur would then make the popup vanish before you type.
static CAPTURE_SHOWN_AT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
const CAPTURE_BLUR_GRACE: std::time::Duration = std::time::Duration::from_millis(400);

fn mark_capture_shown() {
    if let Ok(mut t) = CAPTURE_SHOWN_AT.lock() {
        *t = Some(std::time::Instant::now());
    }
}

/// Should a focus loss close the capture popup now? (Not right after it was shown.)
fn capture_blur_closes() -> bool {
    CAPTURE_SHOWN_AT.lock().ok().and_then(|t| *t).is_none_or(|t| t.elapsed() >= CAPTURE_BLUR_GRACE)
}

/// Lazily creates (or shows) the small always-on-top "Catch a thought" popup.
fn show_capture_window(app: &AppHandle) {
    mark_capture_shown();
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "capture", WebviewUrl::App("index.html?capture=1".into()))
        .title("Catch a thought")
        .inner_size(440.0, 236.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(true)
        .focused(true)
        .build();
    // Clicking anywhere outside the popup closes it (the page discards the typed text on blur).
    if let Ok(w) = built {
        let handle = w.clone();
        w.on_window_event(move |event| {
            if let WindowEvent::Focused(false) = event {
                if capture_blur_closes() {
                    let _ = handle.hide();
                }
            }
        });
    }
}

/// Shows the main window, creating it on first use. It isn't in tauri.conf.json: an autostart
/// boot (tray + hotkey only) must not pay for the webview, the shader or the file watcher.
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
        .build();
    let Ok(w) = built else { return };
    // Heavy work starts with the first show: file watcher and QUESTIONS.md import.
    app.state::<state::AppState>().refresh_questions(app, true);

    // Minimize to tray: closing the main window hides it instead of quitting the app. The
    // first time, the page shows a one-time notice instead (keep running / quit), so the
    // tray behaviour is discoverable; a second X while it's showing just hides.
    let handle = w.clone();
    w.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let seen = handle
                .state::<state::AppState>()
                .ws
                .lock()
                .ok()
                .and_then(|ws| ws.get_settings().ok())
                .map(|s| s.tray_notice_shown)
                .unwrap_or(true);
            if !seen && !TRAY_NOTICE_PENDING.swap(true, Ordering::SeqCst) {
                let _ = handle.emit("tray-notice", ());
            } else {
                hide_to_tray(handle.app_handle());
            }
        }
    });
}

/// Launched by the Windows Run entry (not by the user opening the app).
fn is_autostart_launch() -> bool {
    std::env::args().any(|a| a == "--autostart")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // One taskbar identity for the pinned shortcut, the window and the tray, however the app was
    // launched (Start menu, pin, autostart Run entry): the identifier, which the NSIS installer
    // also stamps on the Start menu shortcut.
    #[cfg(windows)]
    {
        let id: Vec<u16> = "app.dreamer.desktop".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
    }
    tauri::Builder::default()
        // A second launch (Start menu, double-click) just shows the running instance's window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        // Only used from Rust (the handoff folder picker); no dialog permission for the UI.
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        show_capture_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let state = state::AppState::init(app.handle())?;
            app.manage(state);

            let show_item = MenuItem::with_id(app, "show", "Show Dreamer", true, None::<&str>)?;
            let capture_item = MenuItem::with_id(app, "capture", "Catch a thought", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &capture_item, &quit_item])?;
            let mut tray = TrayIconBuilder::new().menu(&menu).show_menu_on_left_click(true).on_menu_event(|app, event| match event.id.0.as_str() {
                "show" => show_main_window(app),
                "capture" => show_capture_window(app),
                "quit" => quit(app),
                _ => {}
            });
            // Simplified pearl (icons/tray.svg) that stays legible at 16px.
            tray = tray.icon(tauri::include_image!("icons/tray.png")).tooltip("Dreamer");
            tray.build(app)?;

            // Keep the Run entry in step with the setting (first run, reinstalls). Never in debug
            // builds, so `tauri dev` doesn't register the dev exe.
            let settings = app.state::<state::AppState>().ws.lock().ok().and_then(|ws| ws.get_settings().ok());
            #[cfg(not(debug_assertions))]
            if settings.as_ref().is_none_or(|s| s.start_with_windows) {
                use tauri_plugin_autostart::ManagerExt;
                let al = app.autolaunch();
                if !al.is_enabled().unwrap_or(true) {
                    let _ = al.enable();
                }
            }
            if is_autostart_launch() {
                // Autostart never shows the one-time "still in the tray" notice.
                if let Ok(ws) = app.state::<state::AppState>().ws.lock() {
                    let _ = ws.update_settings(model::SettingsPatch { tray_notice_shown: Some(true), ..Default::default() });
                }
            }
            // Find and prepare a local model (Ollama) if one is installed; never blocks startup.
            ollama::spawn_auto_setup(app.handle());
            let hidden = is_autostart_launch() && settings.as_ref().is_none_or(|s| s.start_hidden);
            if !hidden {
                show_main_window(app.handle());
            }
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
            commands::load_project,
            commands::save_canvas,
            commands::save_layout,
            commands::delete_folder,
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
            commands::ollama_status,
            commands::ollama_pull,
            commands::ollama_cancel,
            commands::ollama_open_installer,
            commands::claude_interrupt,
            commands::search_cards,
            commands::handoff_start,
            commands::handoff_cancel,
            commands::list_design_versions,
            commands::read_design_doc,
            commands::open_design_folder,
            commands::open_logs_folder,
            commands::pick_folder,
            commands::delete_project,
            commands::load_chat,
            commands::save_chat,
            commands::reset_chat,
            commands::list_chats,
            commands::list_custom_themes,
            commands::save_custom_theme,
            commands::delete_custom_theme,
            commands::dismiss_proposal,
            commands::restore_proposal,
            commands::memory_get,
            commands::memory_save,
            commands::memory_history,
            commands::memory_revert,
            commands::memory_undo,
            commands::memory_seed,
            commands::quit_app,
            commands::hide_to_tray,
            commands::autostart_enabled,
            commands::set_autostart,
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building Dreamer")
        .run(|app, event| {
            // However the app ends (tray Quit, app.exit, last window gone), the sidecar tree goes too.
            if let RunEvent::Exit = event {
                sidecar::shutdown(&app.state::<state::AppState>());
            }
        });
}
