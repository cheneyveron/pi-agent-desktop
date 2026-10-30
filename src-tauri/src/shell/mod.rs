mod macos_menu;
mod notification;
mod platform_tray;
pub mod popup;
mod server;
mod window;
#[cfg(target_os = "macos")]
mod window_appkit;

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{thread, time::Duration};

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use tauri::{AppHandle, Manager, Url};

use crate::logging::{desktop_log, since_process_start_ms};

#[cfg(target_os = "macos")]
pub use macos_menu::build_macos_app_menu;
pub use notification::show_session_notification;
#[cfg(target_os = "linux")]
pub use platform_tray::build_linux_tray;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub use platform_tray::build_platform_tray;
pub use server::{CloseQuits, DesktopApiToken, DesktopServer};
pub use window::{build_window, launched_at_login, AUTOSTART_ARG};

pub(crate) const WINDOW_LABEL: &str = "main";

/// The window is built hidden so the user never sees the webview before it has
/// content (a blank vibrancy/white rectangle while Next.js loads). It is shown
/// once, by whichever comes first: the UI saying its first screen is ready
/// (`app_ready`), the page finishing its load plus `REVEAL_AFTER_PAGE_LOAD`
/// (pages that never call `app_ready`, e.g. the login page), or
/// `REVEAL_DEADLINE` after the window was built (the page never loaded).
static MAIN_WINDOW_REVEALED: AtomicBool = AtomicBool::new(false);
const REVEAL_AFTER_PAGE_LOAD: Duration = Duration::from_millis(1500);
const REVEAL_DEADLINE: Duration = Duration::from_secs(6);

/// Shows the main window the first time it is called. A launch at login stays
/// in the tray: the window is revealed by the user, through `show_main_window`.
fn reveal_main_window(app: &AppHandle, reason: &str) {
    if launched_at_login() || MAIN_WINDOW_REVEALED.swap(true, Ordering::SeqCst) {
        return;
    }
    desktop_log(
        app,
        &format!(
            "main window revealed by {reason} (+{}ms)",
            since_process_start_ms()
        ),
    );
    show_main_window(app);
}

/// Reveals the window from a background thread after `delay`, unless something
/// else already did.
pub fn reveal_main_window_later(app: &AppHandle, delay: Duration, reason: &'static str) {
    let app = app.clone();
    let _ = thread::Builder::new()
        .name("reveal-main-window".into())
        .spawn(move || {
            thread::sleep(delay);
            if MAIN_WINDOW_REVEALED.load(Ordering::SeqCst) {
                return;
            }
            let on_main = app.clone();
            let _ = app.run_on_main_thread(move || reveal_main_window(&on_main, reason));
        });
}

pub fn schedule_reveal_deadline(app: &AppHandle) {
    reveal_main_window_later(app, REVEAL_DEADLINE, "deadline");
}

pub fn schedule_reveal_after_page_load(app: &AppHandle) {
    reveal_main_window_later(app, REVEAL_AFTER_PAGE_LOAD, "page-load fallback");
}

pub fn show_main_window(app: &AppHandle) {
    MAIN_WINDOW_REVEALED.store(true, Ordering::SeqCst);
    if let Some(window) = app
        .get_webview_window(WINDOW_LABEL)
        .or_else(|| app.get_webview_window(crate::backend::REMOTE_WINDOW))
    {
        // The paint mask is lifted only for the main window's own page; the remote
        // window loads a server page that never reports back, so it shows plainly.
        #[cfg(target_os = "macos")]
        if window.label() == WINDOW_LABEL && window_appkit::show_hidden_window_masked(app, &window) {
            return;
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        window_appkit::refresh_traffic_lights(&window);
    } else {
        let _ = crate::backend::show_settings(app);
    }
}

/// The page presented its frames after the window came back from hidden: lift
/// the alpha mask (macOS; nothing to do elsewhere).
#[tauri::command]
pub fn window_painted(app: AppHandle) {
    #[cfg(target_os = "macos")]
    window_appkit::end_paint_mask(&app, "painted");
    #[cfg(not(target_os = "macos"))]
    let _ = app;
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

/// The UI's first screen is on the page: show the (hidden) window now.
#[tauri::command]
pub fn app_ready(app: AppHandle, reason: Option<String>) -> Result<(), String> {
    let reason = reason.unwrap_or_default();
    let reason: String = reason.chars().take(80).collect();
    let label = format!("ui ready ({reason})");
    let on_main = app.clone();
    app.run_on_main_thread(move || reveal_main_window(&on_main, &label))
        .map_err(|error| error.to_string())
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
