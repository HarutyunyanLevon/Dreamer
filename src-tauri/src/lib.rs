mod commands;
mod error;
mod model;
mod state;
mod storage;
mod watcher;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = state::AppState::init(app.handle())?;
            app.manage(state);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dreamer");
}
