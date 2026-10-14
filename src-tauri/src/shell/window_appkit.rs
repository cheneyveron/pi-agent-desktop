#[cfg(target_os = "macos")]
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
use super::window::{MAC_TRAFFIC_LIGHT_X, MAC_TRAFFIC_LIGHT_Y};

/// Marks <html> so native-theme.css can make the sidebar translucent. Removed
/// again by `apply_macos_vibrancy` if the effect view could not be attached.
#[cfg(target_os = "macos")]
pub(crate) const VIBRANCY_MARKER_SCRIPT: &str =
    r#"(function(){try{document.documentElement.classList.add("native-vibrancy");}catch(e){}})();"#;

/// Puts the system sidebar material behind the transparent webview. The
/// material follows the window theme set via `set_theme`.
#[cfg(target_os = "macos")]
pub(crate) fn apply_macos_vibrancy(window: &WebviewWindow) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    if apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        None,
    )
    .is_err()
    {
        let _ = window.eval(r#"document.documentElement.classList.remove("native-vibrancy");"#);
    }
}

// Keeping the traffic lights at MAC_TRAFFIC_LIGHT_*.
//
// tao applies the inset from its content view's `drawRect:` and re-applies it
// straight after `setTitle:`, but neither holds here. That view sits under the
// webview, so nothing redraws it until the user resizes the window. And AppKit
// re-lays the title bar out *after* tao's re-apply, putting the buttons back
// at their default spot (centre ~14pt instead of 24pt). The page sets the
// window title on load and on every session switch, so the lights jumped up
// on launch and whenever the title changed, until the next resize. Measured
// with Accessibility: the reset lands exactly on the title change.
//
// So the inset is applied here at the two points that move the buttons —
// after the window is built, and on each title change. A title change is done
// in one main-thread step: set the title, run the layout AppKit has pending
// (that is the pass that resets the buttons), then move them. tao keeps
// applying the same values on its own redraws, so the two never disagree.

#[cfg(target_os = "macos")]
pub fn refresh_traffic_lights(window: &WebviewWindow) {
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as usize;
    let _ =
        window.run_on_main_thread(move || unsafe { layout_and_inset_traffic_lights(ns_window) });
}

#[cfg(target_os = "macos")]
pub fn set_title_keeping_traffic_lights(window: &WebviewWindow, title: String) {
    let Ok(ns_window) = window.ns_window() else {
        let _ = window.set_title(&title);
        return;
    };
    let ns_window = ns_window as usize;
    let _ = window.run_on_main_thread(move || unsafe {
        use objc2::{msg_send, runtime::AnyObject};
        let window = ns_window as *mut AnyObject;
        if window.is_null() {
            return;
        }
        let title = objc2_foundation::NSString::from_str(&title);
        let _: () = msg_send![window, setTitle: &*title];
        layout_and_inset_traffic_lights(ns_window);
    });
}

/// Runs AppKit's pending layout first, so its reset happens before the move
/// instead of after it.
#[cfg(target_os = "macos")]
unsafe fn layout_and_inset_traffic_lights(ns_window: usize) {
    let window = ns_window as *mut objc2::runtime::AnyObject;
    if window.is_null() {
        return;
    }
    let _: () = objc2::msg_send![window, layoutIfNeeded];
    inset_traffic_lights(ns_window);
}

/// Same steps as tao's `inset_traffic_lights` (platform_impl/macos/view.rs).
#[cfg(target_os = "macos")]
unsafe fn inset_traffic_lights(ns_window: usize) {
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_foundation::NSRect;

    let ns_window = ns_window as *mut AnyObject;
    if ns_window.is_null() {
        return;
    }
    // NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton.
    let buttons: [*mut AnyObject; 3] =
        [0usize, 1, 2].map(|kind| msg_send![ns_window, standardWindowButton: kind]);
    if buttons.iter().any(|button| button.is_null()) {
        return;
    }
    let superview: *mut AnyObject = msg_send![buttons[0], superview];
    if superview.is_null() {
        return;
    }
    let container: *mut AnyObject = msg_send![superview, superview];
    if container.is_null() {
        return;
    }
    let close_frame: NSRect = msg_send![buttons[0], frame];
    let miniaturize_frame: NSRect = msg_send![buttons[1], frame];
    let window_frame: NSRect = msg_send![ns_window, frame];

    let mut bar: NSRect = msg_send![container, frame];
    bar.size.height = close_frame.size.height + MAC_TRAFFIC_LIGHT_Y;
    bar.origin.y = window_frame.size.height - bar.size.height;
    let _: () = msg_send![container, setFrame: bar];

    let spacing = miniaturize_frame.origin.x - close_frame.origin.x;
    for (index, button) in buttons.into_iter().enumerate() {
        let mut frame: NSRect = msg_send![button, frame];
        frame.origin.x = MAC_TRAFFIC_LIGHT_X + index as f64 * spacing;
        let _: () = msg_send![button, setFrameOrigin: frame.origin];
    }
}
