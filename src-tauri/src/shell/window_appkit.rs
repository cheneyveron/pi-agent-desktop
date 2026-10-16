#[cfg(target_os = "macos")]
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
use super::window::{MAC_TRAFFIC_LIGHT_CENTRE_Y, MAC_TRAFFIC_LIGHT_X};

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

/// The Y tao's `traffic_light_position` needs for the buttons' centre to land
/// on MAC_TRAFFIC_LIGHT_CENTRE_Y.
///
/// tao (and `inset_traffic_lights` below) sets the title-bar container to
/// `button height + y` and leaves each button's own frame alone, so the button
/// keeps the bottom offset AppKit gave it. Its centre then sits at
/// `y + height / 2 - offset` from the top, and solving for y needs AppKit's
/// height and offset — which differ by linked SDK (button frames measured on
/// macOS 27: SDK 15.5 → 16pt tall, 6pt up, Y 22; SDK 27 → 14pt tall, 9pt up,
/// Y 26).
/// They are read from a window with tao's Overlay style that is never shown,
/// before the real one is built, because tao keeps re-applying the Y it was
/// built with on every resize. Measured once, on the main thread.
#[cfg(target_os = "macos")]
pub(crate) fn traffic_light_y() -> f64 {
    use std::sync::OnceLock;
    static Y: OnceLock<f64> = OnceLock::new();
    if let Some(y) = Y.get() {
        return *y;
    }
    match unsafe { measure_traffic_light_y() } {
        Some(y) => *Y.get_or_init(|| y),
        // Off the main thread or AppKit had no buttons: the centre itself is
        // within 2pt of either SDK's answer. Not cached, so a later call on
        // the main thread still measures.
        None => MAC_TRAFFIC_LIGHT_CENTRE_Y,
    }
}

#[cfg(target_os = "macos")]
unsafe fn measure_traffic_light_y() -> Option<f64> {
    use objc2::{
        class, msg_send,
        rc::{Allocated, Retained},
        runtime::{AnyObject, Bool},
        MainThreadMarker,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    MainThreadMarker::new()?;
    // tao's TitleBarStyle::Overlay window: Titled | Closable |
    // Miniaturizable | Resizable | FullSizeContentView, transparent title bar,
    // hidden title.
    let style_mask: usize = 1 | 2 | 4 | 8 | (1 << 15);
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(800.0, 600.0));
    let window: Allocated<AnyObject> = msg_send![class!(NSWindow), alloc];
    let window: Option<Retained<AnyObject>> = msg_send![
        window,
        initWithContentRect: rect,
        styleMask: style_mask,
        backing: 2usize,
        defer: Bool::YES
    ];
    let window = window?;
    let _: () = msg_send![&*window, setReleasedWhenClosed: Bool::NO];
    let _: () = msg_send![&*window, setTitlebarAppearsTransparent: Bool::YES];
    // NSWindowTitleHidden
    let _: () = msg_send![&*window, setTitleVisibility: 1isize];
    let _: () = msg_send![&*window, layoutIfNeeded];

    let close: *mut AnyObject = msg_send![&*window, standardWindowButton: 0usize];
    if close.is_null() {
        return None;
    }
    let superview: *mut AnyObject = msg_send![close, superview];
    if superview.is_null() {
        return None;
    }
    let frame: NSRect = msg_send![close, frame];
    let flipped: Bool = msg_send![superview, isFlipped];
    let offset = if flipped.as_bool() {
        let bounds: NSRect = msg_send![superview, bounds];
        bounds.size.height - (frame.origin.y + frame.size.height)
    } else {
        frame.origin.y
    };
    Some(MAC_TRAFFIC_LIGHT_CENTRE_Y - frame.size.height / 2.0 + offset)
}

// Keeping the traffic lights at MAC_TRAFFIC_LIGHT_X / traffic_light_y().
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
    bar.size.height = close_frame.size.height + traffic_light_y();
    bar.origin.y = window_frame.size.height - bar.size.height;
    let _: () = msg_send![container, setFrame: bar];

    let spacing = miniaturize_frame.origin.x - close_frame.origin.x;
    for (index, button) in buttons.into_iter().enumerate() {
        let mut frame: NSRect = msg_send![button, frame];
        frame.origin.x = MAC_TRAFFIC_LIGHT_X + index as f64 * spacing;
        let _: () = msg_send![button, setFrameOrigin: frame.origin];
    }
}
