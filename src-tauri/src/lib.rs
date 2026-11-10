mod commands;
mod error;
mod model;
mod state;
mod storage;
mod watcher;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::ShortcutState;

/// Lazily creates (or shows) the small always-on-top "Catch a thought" popup.
fn show_capture_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "capture", WebviewUrl::App("index.html?capture=1".into()))
        .title("Catch a thought")
        .inner_size(440.0, 176.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(true)
        .focused(true)
        .build();
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
                "quit" => app.exit(0),
                _ => {}
            });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Minimize to tray: closing the main window hides it instead of quitting the app.
            if let Some(w) = app.get_webview_window("main") {
                let handle = w.clone();
                w.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = handle.hide();
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
            commands::list_trash,
            commands::restore_card,
            commands::empty_trash,
            commands::save_media,
            commands::read_media,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dreamer");
}
