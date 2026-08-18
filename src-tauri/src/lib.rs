mod menu;
mod server;

use std::io::Write;
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

/// Fit the main window to the current screen so it always fits on small
/// laptop displays, while never growing past a comfortable default on large
/// monitors. Strategy: take the smaller of
///   - the configured default size (1150x740), and
///   - 92%/90% of the monitor's logical work area.
/// A 1366x768 laptop (100% DPI) therefore gets ~1058x691; a 4K monitor keeps
/// the 1150x740 default instead of scaling up with the screen.
fn fit_window_to_screen(win: &tauri::WebviewWindow) {
    use tauri::LogicalSize;
    const DEFAULT_W: f64 = 1150.0;
    const DEFAULT_H: f64 = 740.0;
    const MAX_FRACTION_W: f64 = 0.92;
    const MAX_FRACTION_H: f64 = 0.90;

    let Some(monitor) = win.current_monitor().ok().flatten() else {
        return;
    };
    let size = monitor.size(); // PhysicalSize of the full monitor
    let scale = monitor.scale_factor();
    // Logical (DPI-scaled) monitor size.
    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;

    // Cap by the screen, then by the default: small screens shrink, large
    // screens stay at the default instead of ballooning. LogicalSize keeps
    // the same unit as tauri.conf.json's width/height (logical pixels).
    let target_w = DEFAULT_W.min(logical_w * MAX_FRACTION_W);
    let target_h = DEFAULT_H.min(logical_h * MAX_FRACTION_H);
    let _ = win.set_size(LogicalSize::new(target_w, target_h));
}

fn append_webview_errors(result: &str) {
    let Ok(entries) = serde_json::from_str::<String>(result) else {
        return;
    };
    if entries.is_empty() {
        return;
    }

    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let path = home.join(".dsh").join("dsh-desktop-webview.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    const MAX_LOG_BYTES: u64 = 1024 * 1024;
    let truncate = std::fs::metadata(&path)
        .map(|metadata| metadata.len() >= MAX_LOG_BYTES)
        .unwrap_or(false);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!truncate)
        .truncate(truncate)
        .open(path);
    if let Ok(mut file) = file {
        let _ = writeln!(file, "{entries}");
    }
}

/// Keep native window state in sync and drain errors captured by the injected
/// legacy-WebKit bootstrap. The remote Harness page never receives Tauri IPC
/// permissions; Rust polls both values through the existing eval callback.
/// The harness toggles `data-ds-dark-theme` on <body> when the user picks a
/// dark appearance. We poll it from Rust (the harness page is a remote
/// origin, so it cannot invoke Tauri commands without risky IPC grants) and
/// mirror it into the window theme, which drives title bar colors on
/// Windows/macOS. Polling stops after the window is closed.
fn sync_webview_state(app: tauri::AppHandle) {
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
                // eval_with_callback delivers the JSON-encoded value, so a
                // string result arrives as `"dark"` (with quotes). Unwrap it.
                let trimmed = result.trim().trim_matches('"');
                let dark = trimmed == "dark";
                let theme = if dark { Theme::Dark } else { Theme::Light };
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.set_theme(Some(theme));
                }
            });
            let drain_errors = r#"
                (() => {
                  try {
                    const queue = globalThis.__DSH_DESKTOP_ERRORS__;
                    if (!Array.isArray(queue) || queue.length === 0) return '';
                    return queue.splice(0).map((entry) => JSON.stringify(entry)).join('\n');
                  } catch { return ''; }
                })()
            "#;
            let _ = win.eval_with_callback(drain_errors, |result| {
                append_webview_errors(&result);
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
            sync_webview_state(app.handle().clone());
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
