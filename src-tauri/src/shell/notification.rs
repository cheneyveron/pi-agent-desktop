//! Native notifications that report a click on their body.
//!
//! The notification plugin's `show()` is fire-and-forget on desktop, so the UI
//! never learns that a notification was clicked. Each notification here waits
//! for the user on its own thread; a click brings the main window forward and
//! emits [`NOTIFICATION_CLICKED_EVENT`] with the session the notification is
//! about. Dismissing it or letting it expire does nothing.

use tauri::{AppHandle, Emitter};

use crate::logging::desktop_log;

/// Emitted with the clicked notification's session id.
pub const NOTIFICATION_CLICKED_EVENT: &str = "pi-agent-notification-clicked";

#[tauri::command]
pub fn show_session_notification(
    app: AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Same identity the notification plugin uses; whichever sets it first wins.
        let identifier = app.config().identifier.clone();
        let _ = mac_notification_sys::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &identifier
        });
    }

    std::thread::Builder::new()
        .name("notification".into())
        .spawn(move || {
            if !wait_for_click(&app, &title, &body) {
                return;
            }
            super::show_main_window(&app);
            if let Some(session_id) = session_id {
                if let Err(error) = app.emit(NOTIFICATION_CLICKED_EVENT, session_id) {
                    desktop_log(&app, &format!("notification click event failed: {error}"));
                }
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Shows the notification and blocks until it is clicked (true) or goes away (false).
#[cfg(target_os = "macos")]
fn wait_for_click(app: &AppHandle, title: &str, body: &str) -> bool {
    use mac_notification_sys::{Notification, NotificationResponse};

    // notify-rust only waits on macOS when the notification has buttons, so this
    // asks mac-notification-sys to wait for a click on the body directly.
    match Notification::new()
        .title(title)
        .message(body)
        .wait_for_click(true)
        .send()
    {
        Ok(response) => response == NotificationResponse::Click,
        Err(error) => {
            desktop_log(app, &format!("notification failed: {error}"));
            false
        }
    }
}

/// Shows the notification and blocks until it is clicked (true) or goes away (false).
#[cfg(not(target_os = "macos"))]
fn wait_for_click(app: &AppHandle, title: &str, body: &str) -> bool {
    use notify_rust::{Notification, NotificationResponse};

    let mut notification = Notification::new();
    notification.summary(title).body(body).auto_icon();
    #[cfg(windows)]
    if let Some(app_id) = windows_app_id(app) {
        notification.app_id(&app_id);
    }
    // XDG servers report a click on the body as the "default" action, but only
    // when the notification offers one.
    #[cfg(all(unix, not(target_os = "macos")))]
    notification.action("default", "Open");

    let handle = match notification.show() {
        Ok(handle) => handle,
        Err(error) => {
            desktop_log(app, &format!("notification failed: {error}"));
            return false;
        }
    };
    let mut clicked = false;
    let _ = handle.wait_for_response(|response: &NotificationResponse| {
        clicked = *response == NotificationResponse::Default;
    });
    clicked
}

/// The installed app's AppUserModelID, as the notification plugin sets it; a
/// binary run from `target/` has none registered, so the default is kept.
#[cfg(windows)]
fn windows_app_id(app: &AppHandle) -> Option<String> {
    use std::path::MAIN_SEPARATOR as SEP;

    let exe = tauri::utils::platform::current_exe().ok()?;
    let dir = exe.parent()?.display().to_string();
    if dir.ends_with(&format!("{SEP}target{SEP}debug"))
        || dir.ends_with(&format!("{SEP}target{SEP}release"))
    {
        return None;
    }
    Some(app.config().identifier.clone())
}
