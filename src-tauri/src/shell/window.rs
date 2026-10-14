use std::env;

use tauri::{
    webview::NewWindowResponse, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

#[cfg(target_os = "macos")]
use super::window_appkit::{self, set_title_keeping_traffic_lights};
use crate::native_prefs::{
    is_inline_frame_document, read_stored_theme, same_origin, theme_bootstrap_script,
};
#[cfg(not(target_os = "macos"))]
use crate::native_prefs::{is_wayland, theme_background_color};
use crate::shell::{open_external, WINDOW_LABEL};

/// Inset of the macOS traffic lights from the window's top-left corner, in
/// logical points. The target is a vertical centre 24pt from the top: the
/// middle of the 48px top bar, of the file panel's tab strip and of the sidebar
/// header's controls row, which all share that line.
///
/// Y is not the centre itself. tao grows the title-bar container to
/// `button height + y` and leaves each button's own offset inside it alone, so
/// the centre lands below Y. SDK 15.5 used 14pt buttons with a 12pt internal
/// offset (Y = 22 centred them at 24pt). macOS 27's 16pt native buttons use a
/// 10pt offset, so Y = 26 is required for the same 24pt centre. Re-measure
/// after a macOS major update:
/// `osascript -e 'tell application "System Events" to tell process "Pi Agent"
/// to get {position, size} of buttons of window 1'` against the window's own
/// position. The horizontal clearance the web content keeps is
/// `--mac-traffic-light-inset` in native-theme.css.
#[cfg(target_os = "macos")]
pub(crate) const MAC_TRAFFIC_LIGHT_X: f64 = 14.0;
#[cfg(target_os = "macos")]
pub(crate) const MAC_TRAFFIC_LIGHT_Y: f64 = 26.0;

/// Argument the launch-at-login entry passes, so a login start can be told
/// apart from the user opening the app.
pub const AUTOSTART_ARG: &str = "--autostart";

pub fn launched_at_login() -> bool {
    env::args().any(|arg| arg == AUTOSTART_ARG)
}

pub fn build_window(app: &tauri::AppHandle, app_url: Url) -> tauri::Result<WebviewWindow> {
    let navigation_origin = app_url.clone();
    let navigation_app = app.clone();
    let stored_theme = read_stored_theme(app);

    let mut builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(app_url))
        .title("Pi Agent")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        // Pi Agent already handles browser drag/drop for image attachments.
        .disable_drag_drop_handler()
        .initialization_script(crate::backend::LOGO_SCRIPT)
        .on_navigation(move |url| {
            if crate::backend::intercept_navigation(&navigation_app, WINDOW_LABEL, url) {
                return false;
            }
            if same_origin(url, &navigation_origin) || is_inline_frame_document(url) {
                true
            } else {
                open_external(url);
                false
            }
        })
        .on_new_window(|url, _features| {
            open_external(&url);
            NewWindowResponse::Deny
        })
        .on_document_title_changed(|window, title| {
            #[cfg(target_os = "macos")]
            set_title_keeping_traffic_lights(&window, title);
            #[cfg(not(target_os = "macos"))]
            let _ = window.set_title(&title);
        });

    // Force the native window chrome/background to match an explicit UI theme
    // before the page paints — otherwise macOS dark mode flashes a black
    // webview while the user has chosen light mode.
    if let Some(theme) = stored_theme {
        let tauri_theme = if matches!(theme, "dark" | "pine") {
            Theme::Dark
        } else {
            Theme::Light
        };
        builder = builder
            .theme(Some(tauri_theme))
            .initialization_script(theme_bootstrap_script(theme));
        // Skip the native background color on Wayland: it can NULL-deref the
        // GdkSurface during window creation and crash the process.
        #[cfg(not(target_os = "macos"))]
        if !is_wayland() {
            builder = builder.background_color(theme_background_color(theme));
        }
    }

    // Lets native-theme.css apply desktop-only conventions (arrow cursors,
    // non-selectable chrome) without touching the browser build.
    builder = builder.initialization_script(DESKTOP_MARKER_SCRIPT);

    // Hide the native title bar. macOS keeps the traffic-light controls
    // (overlaid on our own top bar); other platforms go fully frameless and
    // rely on custom window controls drawn in the web content instead.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // The default inset centres the lights in a 28px title bar, but
            // our chrome rows are 48px tall (native-theme.css `.app-topbar`),
            // so they sat ~10px high. See MAC_TRAFFIC_LIGHT_* for the value.
            .traffic_light_position(tauri::LogicalPosition::new(
                MAC_TRAFFIC_LIGHT_X,
                MAC_TRAFFIC_LIGHT_Y,
            ))
            // Transparent webview over an NSVisualEffectView (see below). The
            // `native-vibrancy` class tells native-theme.css to let the sidebar
            // show through; without it the page paints opaque as before.
            .transparent(true)
            .initialization_script(window_appkit::VIBRANCY_MARKER_SCRIPT);
    }

    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    let window = builder.build()?;

    #[cfg(target_os = "macos")]
    {
        window_appkit::apply_macos_vibrancy(&window);
        window_appkit::refresh_traffic_lights(&window);
    }

    Ok(window)
}

const DESKTOP_MARKER_SCRIPT: &str =
    r#"(function(){try{document.documentElement.classList.add("native-desktop");}catch(e){}})();"#;
