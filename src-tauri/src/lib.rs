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

/// Fit the main window to the current screen's available work area so it
/// fits on small laptop displays: at most 92% of the work-area width/height,
/// never exceeding the configured maximum size.
fn fit_window_to_screen(win: &tauri::WebviewWindow) {
    use tauri::PhysicalSize;
    let Some(monitor) = win.current_monitor().ok().flatten() else {
        return;
    };
    let size = monitor.size(); // PhysicalSize of the full monitor
    let scale = monitor.scale_factor();
    // Scale factor of 1.25 on a 1366x768 laptop → logical 1092x614.
    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;
    let target_w = (logical_w * 0.92).round() as u32;
    let target_h = (logical_h * 0.90).round() as u32;
    let _ = win.set_size(PhysicalSize::new(target_w, target_h));
}

/// Keep the window's native title bar theme in sync with the harness UI.
/// The harness toggles `data-ds-dark-theme` on <body> when the user picks a
/// dark appearance. We poll it from Rust (the harness page is a remote
/// origin, so it cannot invoke Tauri commands without risky IPC grants) and
/// mirror it into the window theme, which drives title bar colors on
/// Windows/macOS. Polling stops after the window is closed.
fn sync_titlebar_theme(app: tauri::AppHandle) {
    use tauri::Theme;
    tauri::async_runtime::spawn(async move {
        loop {
            let Some(win) = app.get_webview_window("main") else {
                break;
            };
            // Ask the page whether dark theme is active. eval_with_callback
            // runs the snippet in the page and delivers the result string.
            // The harness's theme presenter (dsh-client-ui-layout) writes
            // `body[data-ds-dark-theme]` and `html { color-scheme: dark }`
            // when the user picks dark — check both, since body may not be
            // ready during early page load.
            let js = r#"
                (() => {
                  try {
                    const bodyDark = document.body && document.body.hasAttribute('data-ds-dark-theme');
                    const htmlScheme = document.documentElement && document.documentElement.style.colorScheme;
                    return (bodyDark || htmlScheme === 'dark') ? 'dark' : 'light';
                  } catch { return 'light'; }
                })()
            "#;
            let handle = app.clone();
            let _ = win.eval_with_callback(js, move |result| {
                let dark = result.trim() == "dark";
                let theme = if dark { Theme::Dark } else { Theme::Light };
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.set_theme(Some(theme));
                }
            });
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch focuses the existing window instead of
            // starting another server.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![server_start, server_stop])
        .setup(|app| {
            menu::setup(app.handle())?;
            // Fit the window to the screen before showing, then keep the
            // title bar theme in sync with the harness UI.
            if let Some(win) = app.get_webview_window("main") {
                fit_window_to_screen(&win);
            }
            sync_titlebar_theme(app.handle().clone());
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
