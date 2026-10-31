//! Recovery from WebView2 child-process failures (Windows).
//!
//! When WebView2's renderer or GPU process dies or hangs, the window stays
//! black or white until the host reloads it; nothing in the page or the server
//! notices, and the agent keeps running behind a dead screen (#169). The
//! `ProcessFailed` event is the only signal, so the main window subscribes to
//! it, writes what failed to `desktop.log`, and reloads the page. When the
//! browser process itself is gone the WebView cannot be reloaded at all, so the
//! window is destroyed and built again on the same URL.
//!
//! The kind and reason numbers are WebView2's `COREWEBVIEW2_PROCESS_FAILED_*`
//! values; the mapping is plain data so it is tested on every platform.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url};

use crate::logging::desktop_log;
use crate::shell::{build_window, show_main_window, WINDOW_LABEL};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Recovery {
    /// Reload the page in the same WebView.
    Reload,
    /// The WebView is gone: destroy the window and build a new one.
    Rebuild,
    /// The main frame is unaffected; log only.
    LogOnly,
}

pub(crate) fn kind_name(kind: i32) -> &'static str {
    match kind {
        0 => "browser process exited",
        1 => "render process exited",
        2 => "render process unresponsive",
        3 => "frame render process exited",
        4 => "utility process exited",
        5 => "sandbox helper process exited",
        6 => "GPU process exited",
        7 => "PPAPI plugin process exited",
        8 => "PPAPI broker process exited",
        9 => "unknown process exited",
        _ => "unrecognised process failure",
    }
}

pub(crate) fn reason_name(reason: i32) -> &'static str {
    match reason {
        0 => "unexpected",
        1 => "unresponsive",
        2 => "terminated",
        3 => "crashed",
        4 => "launch failed",
        5 => "out of memory",
        6 => "profile deleted",
        _ => "unknown",
    }
}

pub(crate) fn recovery_for(kind: i32) -> Recovery {
    match kind {
        0 => Recovery::Rebuild,
        // The GPU process restarts on its own, but the composited surface it
        // drew can stay black until the page paints again.
        1 | 2 | 6 => Recovery::Reload,
        // An iframe (artifact preview) or a helper: the page itself still works.
        _ => Recovery::LogOnly,
    }
}

/// At most `MAX_RECOVERIES` reloads/rebuilds per `RECOVERY_WINDOW`. A renderer
/// that dies again on every load must not turn into an endless reload loop;
/// past the budget the failure is still logged and the user can reload by hand.
const RECOVERY_WINDOW: Duration = Duration::from_secs(60);
const MAX_RECOVERIES: usize = 3;

#[derive(Default)]
pub(crate) struct RecoveryBudget {
    recent: Vec<Instant>,
}

impl RecoveryBudget {
    pub(crate) fn try_spend(&mut self, now: Instant) -> bool {
        self.recent
            .retain(|at| now.saturating_duration_since(*at) < RECOVERY_WINDOW);
        if self.recent.len() >= MAX_RECOVERIES {
            return false;
        }
        self.recent.push(now);
        true
    }
}

static BUDGET: Mutex<RecoveryBudget> = Mutex::new(RecoveryBudget { recent: Vec::new() });
/// The URL the main window was built on, for a rebuild.
static MAIN_URL: Mutex<Option<Url>> = Mutex::new(None);
/// Set from the moment the dead window is destroyed until its replacement is
/// built, so the "last window closed" exit request in between is refused.
static REBUILDING: AtomicBool = AtomicBool::new(false);
static WAS_VISIBLE: AtomicBool = AtomicBool::new(false);

pub(crate) fn remember_main_url(url: &Url) {
    if let Ok(mut slot) = MAIN_URL.lock() {
        *slot = Some(url.clone());
    }
}

/// True while the main window is being replaced; the run loop then keeps the
/// app alive although no window exists.
pub fn is_rebuilding_main_window() -> bool {
    REBUILDING.load(Ordering::SeqCst)
}

/// Builds the replacement once the dead window is really gone (its label is
/// only free after `Destroyed`). Built from a worker thread: on Windows,
/// building a window inside an event handler deadlocks (wry#583).
pub fn on_main_window_destroyed(app: &AppHandle) {
    if !is_rebuilding_main_window() {
        return;
    }
    let app = app.clone();
    let _ = thread::Builder::new()
        .name("rebuild-main-window".into())
        .spawn(move || {
            let url = MAIN_URL.lock().ok().and_then(|slot| slot.clone());
            match url.map(|url| build_window(&app, url)) {
                Some(Ok(_)) => {
                    desktop_log(&app, "webview recovery: main window rebuilt");
                    if WAS_VISIBLE.load(Ordering::SeqCst) {
                        let on_main = app.clone();
                        let _ = app.run_on_main_thread(move || show_main_window(&on_main));
                    }
                }
                Some(Err(error)) => {
                    desktop_log(&app, &format!("webview recovery: rebuild failed: {error}"));
                }
                None => desktop_log(&app, "webview recovery: rebuild skipped, no window URL"),
            }
            REBUILDING.store(false, Ordering::SeqCst);
        });
}

/// Logs one failure and starts the recovery its kind calls for.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn handle_process_failure(app: &AppHandle, kind: i32, details: Option<(i32, i32)>) {
    let recovery = recovery_for(kind);
    let mut line = format!("webview {} (kind {kind}", kind_name(kind));
    if let Some((reason, exit_code)) = details {
        line.push_str(&format!(
            ", reason {}, exit code {:#010x}",
            reason_name(reason),
            exit_code as u32
        ));
    }
    line.push(')');

    let allowed = recovery == Recovery::LogOnly
        || BUDGET
            .lock()
            .map(|mut budget| budget.try_spend(Instant::now()))
            .unwrap_or(false);
    let action = match (recovery, allowed) {
        (Recovery::LogOnly, _) => "no action",
        (_, false) => "not recovering: too many failures in the last minute",
        (Recovery::Reload, true) => "reloading the page",
        (Recovery::Rebuild, true) => "rebuilding the window",
    };
    desktop_log(app, &format!("{line}; {action}"));
    if !allowed {
        return;
    }

    // Deferred to the event loop: never re-enter WebView2 from inside its own
    // event callback.
    let on_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = on_main.get_webview_window(WINDOW_LABEL) else {
            return;
        };
        match recovery {
            Recovery::Reload => {
                if let Err(error) = window.reload() {
                    desktop_log(&on_main, &format!("webview recovery: reload failed: {error}"));
                }
            }
            Recovery::Rebuild => {
                WAS_VISIBLE.store(window.is_visible().unwrap_or(false), Ordering::SeqCst);
                REBUILDING.store(true, Ordering::SeqCst);
                if let Err(error) = window.destroy() {
                    REBUILDING.store(false, Ordering::SeqCst);
                    desktop_log(&on_main, &format!("webview recovery: destroy failed: {error}"));
                }
            }
            Recovery::LogOnly => {}
        }
    });
}

/// Subscribes the window's WebView2 to `ProcessFailed`.
#[cfg(windows)]
pub fn watch_process_failures(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_REASON,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface as _;

    let app = window.app_handle().clone();
    let log_app = app.clone();
    let result = window.with_webview(move |platform| {
        let handler_app = app.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(-1);
            // SAFETY: plain out-parameter getters on a live COM object.
            unsafe { args.ProcessFailedKind(&mut kind)? };
            let details = args
                .cast::<ICoreWebView2ProcessFailedEventArgs2>()
                .ok()
                .map(|args| {
                    let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON(-1);
                    let mut exit_code = 0_i32;
                    unsafe {
                        let _ = args.Reason(&mut reason);
                        let _ = args.ExitCode(&mut exit_code);
                    }
                    (reason.0, exit_code)
                });
            handle_process_failure(&handler_app, kind.0, details);
            Ok(())
        }));
        let mut token = 0_i64;
        // SAFETY: called on the UI thread that owns the controller.
        let subscribed = unsafe {
            platform
                .controller()
                .CoreWebView2()
                .and_then(|webview| webview.add_ProcessFailed(&handler, &mut token))
        };
        if let Err(error) = subscribed {
            desktop_log(
                &app,
                &format!("webview recovery: could not watch process failures: {error}"),
            );
        }
    });
    if let Err(error) = result {
        desktop_log(
            &log_app,
            &format!("webview recovery: could not reach the webview: {error}"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_killing_failures_reload_and_a_dead_browser_rebuilds() {
        assert_eq!(recovery_for(0), Recovery::Rebuild);
        assert_eq!(recovery_for(1), Recovery::Reload);
        assert_eq!(recovery_for(2), Recovery::Reload);
        assert_eq!(recovery_for(6), Recovery::Reload);
        // An artifact iframe crashing leaves the page usable.
        assert_eq!(recovery_for(3), Recovery::LogOnly);
        assert_eq!(recovery_for(4), Recovery::LogOnly);
        assert_eq!(recovery_for(-1), Recovery::LogOnly);
    }

    #[test]
    fn failure_names_cover_the_out_of_memory_case() {
        assert_eq!(kind_name(1), "render process exited");
        assert_eq!(reason_name(5), "out of memory");
        assert_eq!(reason_name(42), "unknown");
    }

    #[test]
    fn recovery_budget_stops_a_reload_loop_and_refills() {
        let mut budget = RecoveryBudget::default();
        let start = Instant::now();
        for _ in 0..MAX_RECOVERIES {
            assert!(budget.try_spend(start));
        }
        assert!(!budget.try_spend(start + Duration::from_secs(1)));
        assert!(budget.try_spend(start + RECOVERY_WINDOW));
    }
}
