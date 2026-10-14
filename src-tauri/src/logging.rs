use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
    thread,
};

use tauri::{AppHandle, Manager};

const DESKTOP_LOG_MAX_BYTES: u64 = 256 * 1024;
static DESKTOP_LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Formats epoch milliseconds as `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC) without a
/// date-time dependency (Howard Hinnant's civil-from-days algorithm).
pub fn format_utc_millis(epoch_millis: u128) -> String {
    let millis = (epoch_millis % 1000) as u32;
    let total_secs = (epoch_millis / 1000) as u64;
    let days = (total_secs / 86_400) as i64;
    let secs_of_day = total_secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        secs_of_day / 3600,
        secs_of_day % 3600 / 60,
        secs_of_day % 60
    )
}

/// App log directory, recorded once the app exists so the panic hook (which
/// has no `AppHandle`) can still reach `desktop.log`.
/// Appends a timestamped line to `desktop.log` in `dir`. Best effort. When the
/// file passes the size cap it is moved to `desktop.log.1` (replacing the
/// previous one) so a crash entry is never lost to the rotation itself.
pub fn append_desktop_log(dir: &Path, message: &str) {
    let _ = fs::create_dir_all(dir);
    let path = dir.join("desktop.log");
    if fs::metadata(&path).is_ok_and(|meta| meta.len() > DESKTOP_LOG_MAX_BYTES) {
        let _ = fs::rename(&path, dir.join("desktop.log.1"));
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {message}", format_utc_millis(millis));
    }
}

/// Appends a line to `desktop.log` in the app log directory. The log exists so
/// a hang during a popup, a panic, or an unexpected exit leaves its last step
/// on disk.
pub fn desktop_log(app: &AppHandle, message: &str) {
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let _ = DESKTOP_LOG_DIR.set(dir.clone());
    append_desktop_log(&dir, message);
}

/// Writes panics to `desktop.log` before the default hook runs. The release
/// profile uses `panic = "abort"`, so without this a panic on any thread kills
/// the app with nothing but a macOS crash report to show for it.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = DESKTOP_LOG_DIR.get() {
            let thread = thread::current();
            let payload = info.payload();
            let message = payload
                .downcast_ref::<&str>()
                .map(|text| (*text).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "non-string panic payload".to_string());
            let location = info
                .location()
                .map(|place| format!("{}:{}:{}", place.file(), place.line(), place.column()))
                .unwrap_or_else(|| "unknown location".to_string());
            let backtrace = std::backtrace::Backtrace::force_capture();
            append_desktop_log(
                dir,
                &format!(
                    "PANIC v{} on thread '{}' at {location}: {message}\n{backtrace}",
                    env!("CARGO_PKG_VERSION"),
                    thread.name().unwrap_or("<unnamed>")
                ),
            );
        }
        previous(info);
    }));
}
