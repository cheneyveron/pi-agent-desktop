mod macos_menu;
mod platform_tray;
pub mod popup;
mod server;
mod window;
#[cfg(target_os = "macos")]
mod window_appkit;

use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use tauri::{AppHandle, Manager, Url};

#[cfg(target_os = "macos")]
pub use macos_menu::build_macos_app_menu;
#[cfg(target_os = "linux")]
pub use platform_tray::build_linux_tray;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub use platform_tray::build_platform_tray;
pub use server::{CloseQuits, DesktopApiToken, DesktopServer};
pub use window::{build_window, launched_at_login, AUTOSTART_ARG};

pub(crate) const WINDOW_LABEL: &str = "main";

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app
        .get_webview_window(WINDOW_LABEL)
        .or_else(|| app.get_webview_window(crate::backend::REMOTE_WINDOW))
    {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        window_appkit::refresh_traffic_lights(&window);
    } else {
        let _ = crate::backend::show_settings(app);
    }
}

pub fn quit_application(app: &AppHandle) {
    if let Some(server) = app.try_state::<DesktopServer>() {
        server.stop();
    }
    app.exit(0);
}

#[tauri::command]
pub fn set_close_quits(app: AppHandle, quit: bool) -> Result<(), String> {
    if let Some(state) = app.try_state::<CloseQuits>() {
        *state
            .0
            .lock()
            .map_err(|_| "close-behavior lock poisoned".to_string())? = quit;
    }
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), String> {
    quit_application(&app);
    Ok(())
}

#[tauri::command]
pub fn show_main_window_cmd(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

pub fn open_external(url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    }

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(url.as_str()).spawn();
    }
}
