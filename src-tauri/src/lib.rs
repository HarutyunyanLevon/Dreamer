mod claude_setup;
mod commands;
mod error;
mod model;
mod proc_guard;
mod search;
mod sidecar;
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

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Minimize to tray: closing the main window hides it instead of quitting the app. The
            // first time, the page shows a one-time notice instead (keep running / quit), so the
            // tray behaviour is discoverable; a second X while it's showing just hides.
            if let Some(w) = app.get_webview_window("main") {
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
            commands::create_card,
            commands::read_card,
            commands::update_card,
            commands::delete_card,
            commands::lose_card,
            commands::list_trash,
            commands::restore_card,
            commands::empty_trash,
            commands::save_media,
            commands::read_media,
            commands::claude_status,
            commands::claude_install,
            commands::claude_login,
            commands::claude_setup_cancel,
            commands::claude_open_login_url,
            commands::claude_send,
            commands::claude_interrupt,
            commands::export_brief,
            commands::search_cards,
            commands::delete_project,
            commands::load_chat,
            commands::save_chat,
            commands::reset_chat,
            commands::list_custom_themes,
            commands::save_custom_theme,
            commands::delete_custom_theme,
            commands::quit_app,
            commands::hide_to_tray,
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
