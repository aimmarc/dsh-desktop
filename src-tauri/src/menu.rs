//! Tray icon + native menu. Localized zh-CN / en based on the system locale.
//! The tray is the app's home: closing the window hides it; quitting happens
//! here (and only here) so the dsh server is torn down cleanly.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

/// Shared locale detection (duplicated here to keep menu.rs dependency-free;
/// server.rs has the same helper).
fn is_zh() -> bool {
    let lang = std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .unwrap_or_default()
        .to_lowercase();
    lang.starts_with("zh") || lang.starts_with("cmn")
}

pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let zh = is_zh();

    let open = MenuItem::with_id(app, "open", if zh { "打开主界面" } else { "Open" }, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", if zh { "退出" } else { "Quit" }, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let _tray = TrayIconBuilder::with_id("dsh-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "quit" => {
                // server_stop runs on RunEvent::Exit; exit(0) triggers it.
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
