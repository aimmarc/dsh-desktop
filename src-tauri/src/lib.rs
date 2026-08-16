mod menu;
mod server;

use tauri::Manager;

/// Start the dsh server and return the canonical URL it is reachable at.
/// If a server is already answering on the target port (e.g. the user ran
/// `dsh web` themselves, or a previous instance is still alive), it is
/// reused instead of starting a second one.
#[tauri::command]
async fn server_start(app: tauri::AppHandle) -> Result<String, String> {
    server::ServerManager::start(&app).await
}

/// Stop the dsh server process we spawned (no-op if we reused an existing
/// server, which we must not kill).
#[tauri::command]
fn server_stop(app: tauri::AppHandle) -> Result<(), String> {
    server::ServerManager::stop(&app);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch focuses the existing window instead of
            // starting another server.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![server_start, server_stop])
        .setup(|app| {
            menu::setup(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it to the tray; the server keeps
            // running. Quit comes from the tray menu instead.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                server::ServerManager::stop(app_handle);
            }
        });
}
