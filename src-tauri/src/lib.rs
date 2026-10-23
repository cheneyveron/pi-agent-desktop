use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

use tauri::{AppHandle, Emitter, Manager, RunEvent, Url};

mod backend;
mod logging;
mod native_prefs;
mod shell;

use logging::{desktop_log, install_panic_hook, mark_process_start, since_process_start_ms};
use native_prefs::{
    clear_app_cache, reconcile_webview_cache_for_version, set_ui_theme, write_last_version,
};
#[cfg(feature = "custom-protocol")]
use native_prefs::{read_last_server_port, write_last_server_port};
#[cfg(target_os = "macos")]
use shell::build_macos_app_menu;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
use shell::build_platform_tray;
use shell::popup::{show_popup_menu, PopupMenuSelection, POPUP_ID_PREFIX};
use shell::{
    app_ready, build_window, launched_at_login, open_external, quit_app, quit_application,
    schedule_reveal_deadline, set_close_quits, show_main_window_cmd, window_painted, CloseQuits,
    DesktopApiToken, DesktopServer, AUTOSTART_ARG, WINDOW_LABEL,
};
#[cfg(target_os = "linux")]
use shell::{build_linux_tray, show_main_window};

const DESKTOP_API_TOKEN_ENV: &str = "PI_DESKTOP_API_TOKEN";
const DESKTOP_INSTANCE_ID_ENV: &str = "PI_DESKTOP_INSTANCE_ID";
const DESKTOP_INSTANCE_ID_HEADER: &str = "x-pi-desktop-instance";
#[cfg(not(feature = "custom-protocol"))]
const DEV_SERVER_URL: &str = "http://127.0.0.1:30141";
/// Preferred localhost port for the packaged Next server. Keeping this stable
/// matters because the webview's localStorage is origin-scoped (`host:port`).
#[cfg(feature = "custom-protocol")]
const DESKTOP_SERVER_PORT: u16 = 38471;
#[cfg(feature = "custom-protocol")]
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(30);
/// How often startup checks whether the server answers. The probe is a local
/// socket round trip, so a short interval costs nothing and trims up to this
/// much off every launch.
#[cfg(feature = "custom-protocol")]
const SERVER_START_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// Env var read by `desktop/server-launcher.cjs`: where Node keeps its compiled
/// code cache. Deliberately not `NODE_COMPILE_CACHE`, which every node process
/// the agent starts (tools, scripts) would inherit.
#[cfg(feature = "custom-protocol")]
const COMPILE_CACHE_DIR_ENV: &str = "PI_DESKTOP_COMPILE_CACHE_DIR";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn generate_random_hex() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn load_or_generate_desktop_api_token() -> Result<String, String> {
    if let Ok(value) = env::var(DESKTOP_API_TOKEN_ENV) {
        let value = value.trim();
        if value.len() >= 32 {
            return Ok(value.to_string());
        }
    }

    generate_random_hex()
}

#[tauri::command]
fn get_desktop_api_token(token: tauri::State<'_, DesktopApiToken>) -> String {
    token.0.clone()
}

fn open_path_with_default_app(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // explorer.exe applies the default file association without going
        // through the cmd parser, where `&` or `^` in an otherwise legal path
        // (`C:\src\R&D\notes.txt`) would be read as a command separator.
        Command::new("explorer.exe")
            .arg(path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Opening local paths is unsupported on this platform".into())
}

fn reveal_path_in_file_manager(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .args(["-R"])
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Reveal in folder is unsupported on this platform".into())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("Only http, https, and mailto URLs can be opened externally".into());
    }
    open_external(&parsed);
    Ok(())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open_path_with_default_app(Path::new(&path))
}

/// Opens the app log directory (`desktop.log`, `server.log`) in the file
/// manager. Takes no path from the UI: the directory is fixed, so the command
/// cannot be turned into a general "open anything" primitive.
#[tauri::command]
fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    open_path_with_default_app(&dir)
}

#[tauri::command]
fn reveal_item_in_dir(path: String) -> Result<(), String> {
    reveal_path_in_file_manager(Path::new(&path))
}

/// Launch Services' answer to Finder's "Open With": every application that can
/// open `argv[0]`, the default one first. Nested bundles (Xcode's Instruments)
/// and cache copies (Playwright's Chrome for Testing) are noise in a context
/// menu, so they are dropped here rather than in the UI. The path travels as
/// an argument, never spliced into the script.
///
/// Launch Services is generous with text: Word, Excel, Numbers and Notes all
/// claim `public.plain-text`, so a `.mjs` file would list them next to the code
/// editors. When the file's type has a specific family (source code, JSON,
/// markdown, ...), only apps that declare a document type inside that family
/// stay, plus the default app and the system's default text editor. Anything
/// that cannot be classified (no extension, a dynamic type, macOS < 11) keeps
/// the full list, as does a filter that would leave nothing to offer.
#[cfg(target_os = "macos")]
const LIST_APPS_FOR_FILE_JXA: &str = r#"
ObjC.import("AppKit");
// Too broad to say anything about an app: nearly every text claim reaches one.
const GENERIC_TYPES = [
  "public.item", "public.data", "public.content", "public.composite-content",
  "public.text", "public.plain-text", "public.executable",
];
function utTypeClass() {
  const framework = $.NSBundle.bundleWithPath("/System/Library/Frameworks/UniformTypeIdentifiers.framework");
  if (!framework || framework.isNil() || !framework.load) return null;
  const cls = $.NSClassFromString("UTType");
  return cls && !cls.isNil() ? cls : null;
}
// The file type's family: the widest of its own and ancestor types that is not
// generic, so `.mjs` maps to source code and `.json` stays JSON.
function familyOf(UTType, path) {
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/") + 1 || dot === path.length - 1) return null;
  const type = UTType.typeWithFilenameExtension(path.slice(dot + 1));
  if (!type || type.isNil() || ObjC.unwrap(type.dynamic)) return null;
  const candidates = [type];
  const supertypes = type.supertypes.allObjects;
  for (let i = 0; i < supertypes.count; i++) candidates.push(supertypes.objectAtIndex(i));
  let family = null;
  for (const candidate of candidates) {
    if (GENERIC_TYPES.indexOf(ObjC.unwrap(candidate.identifier)) !== -1) continue;
    if (!family || family.conformsToType(candidate)) family = candidate;
  }
  return family;
}
function claimsFamily(UTType, appPath, family) {
  const info = $.NSBundle.bundleWithPath(appPath).infoDictionary;
  const docs = info && !info.isNil() ? ObjC.deepUnwrap(info.objectForKey("CFBundleDocumentTypes")) : null;
  for (const doc of docs || []) {
    const ids = (doc.LSItemContentTypes || []).map((id) => UTType.typeWithIdentifier(id));
    for (const ext of doc.CFBundleTypeExtensions || []) ids.push(UTType.typeWithFilenameExtension(ext));
    for (const type of ids) {
      if (type && !type.isNil() && type.conformsToType(family)) return true;
    }
  }
  return false;
}
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const workspace = $.NSWorkspace.sharedWorkspace;
  const fileManager = $.NSFileManager.defaultManager;
  const preferred = workspace.URLForApplicationToOpenURL(url);
  const preferredPath = preferred ? ObjC.unwrap(preferred.path) : null;
  const urls = workspace.URLsForApplicationsToOpenURL(url);
  const seen = {};
  const apps = [];
  for (let i = 0; i < urls.count; i++) {
    const appPath = ObjC.unwrap(urls.objectAtIndex(i).path);
    if (seen[appPath]) continue;
    seen[appPath] = true;
    if (appPath.slice(0, -4).indexOf(".app/") !== -1) continue;
    if (appPath.indexOf("/Library/Caches/") !== -1) continue;
    apps.push({
      name: ObjC.unwrap(fileManager.displayNameAtPath(appPath)),
      path: appPath,
      isDefault: appPath === preferredPath,
    });
  }
  let kept = apps;
  const UTType = utTypeClass();
  const family = UTType ? familyOf(UTType, argv[0]) : null;
  if (family) {
    const textEditor = workspace.URLForApplicationToOpenContentType(UTType.typeWithIdentifier("public.plain-text"));
    const textEditorPath = textEditor && !textEditor.isNil() ? ObjC.unwrap(textEditor.path) : null;
    const narrowed = apps.filter((app) =>
      app.isDefault || app.path === textEditorPath || claimsFamily(UTType, app.path, family));
    if (narrowed.length > 0) kept = narrowed;
  }
  kept.sort((a, b) => (b.isDefault - a.isDefault) || a.name.localeCompare(b.name));
  return JSON.stringify(kept.slice(0, 40));
}
"#;

#[cfg(target_os = "macos")]
fn list_apps_for_file_macos(path: &Path) -> Result<serde_json::Value, String> {
    if !path.is_absolute() {
        return Err("An absolute path is required".into());
    }
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }
    let output = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", LIST_APPS_FOR_FILE_JXA])
        .arg(path)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn open_path_with_app_macos(path: &Path, app: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("An absolute path is required".into());
    }
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }
    let is_app_bundle = app.is_absolute()
        && app.is_dir()
        && app
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
    if !is_app_bundle {
        return Err(format!("Not an application bundle: {}", app.display()));
    }
    let output = Command::new("/usr/bin/open")
        .arg("-a")
        .arg(app)
        .arg(path)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Applications that can open `path`, default first. Empty off macOS, where the
/// UI offers no "Open With" menu yet.
#[tauri::command]
async fn list_apps_for_file(path: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        // osascript takes ~150ms; keep it off the IPC thread.
        return tauri::async_runtime::spawn_blocking(move || {
            list_apps_for_file_macos(Path::new(&path))
        })
        .await
        .map_err(|error| error.to_string())?;
    }

    #[allow(unreachable_code)]
    {
        let _ = path;
        Ok(serde_json::Value::Array(Vec::new()))
    }
}

/// Opens `path` with the application bundle at `app` (Finder's "Open With").
#[tauri::command]
async fn open_path_with(path: String, app: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            open_path_with_app_macos(Path::new(&path), Path::new(&app))
        })
        .await
        .map_err(|error| error.to_string())?;
    }

    #[allow(unreachable_code)]
    {
        let _ = (path, app);
        Err("Open With is only supported on macOS".into())
    }
}

#[cfg(all(feature = "custom-protocol", unix))]
fn login_shell_path() -> Option<String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = Command::new(shell)
        .args(["-l", "-c", "/usr/bin/env"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix("PATH="))
        .map(str::to_string)
        .filter(|path| !path.is_empty())
}

#[cfg(all(feature = "custom-protocol", windows))]
fn login_shell_path() -> Option<String> {
    env::var("PATH").ok().filter(|path| !path.is_empty())
}

#[cfg(all(feature = "custom-protocol", target_os = "macos"))]
fn bundled_node_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("resources/Pi Agent Server.app/Contents/MacOS/node")
}

#[cfg(all(feature = "custom-protocol", target_os = "windows"))]
fn bundled_node_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("resources/node/node.exe")
}

#[cfg(all(feature = "custom-protocol", target_os = "linux"))]
fn bundled_node_path(resource_dir: &Path) -> PathBuf {
    // Resolution order: explicit override (distro packs point this at their
    // own node, e.g. Nix store or /opt prefixes) > bundled runtime > the FHS
    // default. Next.js requires Node >= 20.9.
    if let Ok(p) = env::var("PI_DESKTOP_NODE") {
        let path = PathBuf::from(&p);
        if !p.is_empty() && path.is_file() {
            return path;
        }
    }
    let bundled = resource_dir.join("resources/node/node");
    if bundled.is_file() {
        bundled
    } else {
        PathBuf::from("/usr/bin/node")
    }
}

#[cfg(feature = "custom-protocol")]
fn child_process_compatible_path(path: &Path) -> PathBuf {
    // Tauri resolves its Windows resource directory from a canonicalized
    // executable path. `std::fs::canonicalize` uses the verbatim `\\?\C:\...`
    // form on Windows, but Node's entry-point resolver is not verbatim-path
    // aware and reduces that argument to the bare drive (`C:`). Simplify the
    // path before it crosses the process boundary. On non-Windows platforms
    // this is intentionally a no-op.
    dunce::simplified(path).to_path_buf()
}

#[cfg(feature = "custom-protocol")]
fn server_process_path(node_path: &Path) -> Option<std::ffi::OsString> {
    let inherited = login_shell_path().unwrap_or_default();
    let mut paths = vec![node_path.parent()?.to_path_buf()];
    paths.extend(env::split_paths(&inherited));
    env::join_paths(paths).ok()
}

#[cfg(feature = "custom-protocol")]
fn choose_port(app: &AppHandle) -> io::Result<u16> {
    let mut candidates = Vec::with_capacity(36);
    if let Some(last) = read_last_server_port(app) {
        candidates.push(last);
    }
    candidates.push(DESKTOP_SERVER_PORT);
    for offset in 1u16..=32 {
        candidates.push(DESKTOP_SERVER_PORT.saturating_add(offset));
    }

    for port in candidates {
        if let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
            let chosen = listener.local_addr()?.port();
            drop(listener);
            write_last_server_port(app, chosen);
            return Ok(chosen);
        }
    }

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let chosen = listener.local_addr()?.port();
    drop(listener);
    write_last_server_port(app, chosen);
    Ok(chosen)
}

#[cfg(feature = "custom-protocol")]
fn response_has_instance_id(response: &[u8], expected_instance_id: &str) -> bool {
    let Ok(response) = std::str::from_utf8(response) else {
        return false;
    };
    let Some((headers, _)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let mut lines = headers.lines();
    let Some(status) = lines.next() else {
        return false;
    };
    if !(status.starts_with("HTTP/1.1 204 ") || status.starts_with("HTTP/1.0 204 ")) {
        return false;
    }

    lines.any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case(DESKTOP_INSTANCE_ID_HEADER)
                && value.trim() == expected_instance_id
        })
    })
}

#[cfg(feature = "custom-protocol")]
fn server_identity_matches(address: SocketAddr, expected_instance_id: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(200)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }

    let request = format!(
        "GET /api/desktop/identity HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 512];
    while response.len() < 8 * 1024 {
        let Ok(read) = stream.read(&mut chunk) else {
            return false;
        };
        if read == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..read]);
        if response.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    response_has_instance_id(&response, expected_instance_id)
}

/// How often the monitor checks the server, and how many failed probes in a
/// row count as "not answering". A probe waits at most ~1.2 s, so a blocked
/// event loop is reported roughly 10 s after it stops responding.
#[cfg(feature = "custom-protocol")]
const SERVER_MONITOR_INTERVAL: Duration = Duration::from_secs(5);
#[cfg(feature = "custom-protocol")]
const SERVER_UNRESPONSIVE_AFTER: u32 = 2;

/// Watches the packaged server and records what happened in `desktop.log`:
/// the process dying on its own (with its exit status) and the process staying
/// alive but no longer answering HTTP, which is what a hung UI looks like from
/// the outside. Observation only: nothing is restarted or killed here.
#[cfg(feature = "custom-protocol")]
fn spawn_server_monitor(app: AppHandle, address: SocketAddr, instance_id: String) {
    let _ = thread::Builder::new()
        .name("server-monitor".into())
        .spawn(move || {
            let mut failures = 0_u32;
            let mut first_failure: Option<Instant> = None;
            loop {
                thread::sleep(SERVER_MONITOR_INTERVAL);
                let Some(server) = app.try_state::<DesktopServer>() else {
                    return;
                };
                match server.try_wait_child() {
                    Ok(None) => {}
                    Ok(Some(status)) => {
                        desktop_log(
                            &app,
                            &format!("server process exited unexpectedly ({status}); see server.log"),
                        );
                        return;
                    }
                    Err(error) => {
                        desktop_log(&app, &format!("server status check failed: {error}"));
                        return;
                    }
                }

                if server_identity_matches(address, &instance_id) {
                    if let Some(since) = first_failure.take() {
                        if failures >= SERVER_UNRESPONSIVE_AFTER {
                            desktop_log(
                                &app,
                                &format!(
                                    "server answering again after {:.1}s",
                                    since.elapsed().as_secs_f32()
                                ),
                            );
                        }
                    }
                    failures = 0;
                } else {
                    failures += 1;
                    let since = *first_failure.get_or_insert_with(Instant::now);
                    if failures == SERVER_UNRESPONSIVE_AFTER {
                        desktop_log(
                            &app,
                            &format!(
                                "server process is alive but not answering ({failures} probes failed over {:.1}s)",
                                since.elapsed().as_secs_f32()
                            ),
                        );
                    }
                }
            }
        });
}

#[cfg(feature = "custom-protocol")]
fn wait_for_server(
    child: &mut Child,
    address: SocketAddr,
    expected_instance_id: &str,
    log_path: &Path,
) -> io::Result<()> {
    let deadline = Instant::now() + SERVER_START_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!(
                "Pi Agent server exited early with {status}; see {}",
                log_path.display()
            )));
        }
        if server_identity_matches(address, expected_instance_id) {
            // Re-check after the HTTP handshake. A losing child can exit with
            // EADDRINUSE while another process is answering on the same port.
            if let Some(status) = child.try_wait()? {
                return Err(io::Error::other(format!(
                    "Pi Agent server exited during startup with {status}; see {}",
                    log_path.display()
                )));
            }
            return Ok(());
        }
        thread::sleep(SERVER_START_POLL_INTERVAL);
    }

    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!(
            "Pi Agent server did not start within {} seconds; see {}",
            SERVER_START_TIMEOUT.as_secs(),
            log_path.display()
        ),
    ))
}

#[cfg(feature = "custom-protocol")]
fn start_packaged_server(
    app: &tauri::AppHandle,
    desktop_api_token: &str,
    desktop_instance_id: &str,
) -> Result<(Url, DesktopServer), Box<dyn std::error::Error>> {
    let resource_dir = child_process_compatible_path(&app.path().resource_dir()?);
    let node_path = bundled_node_path(&resource_dir);
    if !node_path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "Node.js runtime is missing: {} (Linux: set PI_DESKTOP_NODE or install 'nodejs')",
                node_path.display()
            ),
        )
        .into());
    }

    let server_dir = resource_dir.join("resources/server");
    let server_script = server_dir.join("desktop-server.cjs");
    if !server_script.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "Bundled Next.js server is missing: {}",
                server_script.display()
            ),
        )
        .into());
    }

    let log_dir = app.path().app_log_dir()?;
    fs::create_dir_all(&log_dir)?;
    let log_path = log_dir.join("server.log");
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let stderr = stdout.try_clone()?;

    let port = choose_port(app)?;
    let mut command = Command::new(&node_path);
    if let Ok(cache_dir) = app.path().app_cache_dir() {
        command.env(COMPILE_CACHE_DIR_ENV, cache_dir.join("node-compile-cache"));
    }
    command
        .arg(&server_script)
        .current_dir(&server_dir)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("PI_WEB_PARENT_PID", std::process::id().to_string())
        .env(DESKTOP_API_TOKEN_ENV, desktop_api_token)
        .env(DESKTOP_INSTANCE_ID_ENV, desktop_instance_id)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    if let Some(path) = server_process_path(&node_path) {
        command.env("PATH", path);
    }

    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn()?;

    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    if let Err(error) = wait_for_server(&mut child, address, desktop_instance_id, &log_path) {
        let server = DesktopServer::running(child);
        server.stop();
        return Err(error.into());
    }

    let url = format!("http://127.0.0.1:{port}").parse()?;
    Ok((url, DesktopServer::running(child)))
}

#[cfg(all(test, feature = "custom-protocol"))]
mod tests {
    use super::shell::popup::PopupMenuEntry;
    use super::{child_process_compatible_path, response_has_instance_id};
    use super::{logging::format_utc_millis, native_prefs::is_inline_frame_document};

    use std::path::{Path, PathBuf};

    #[test]
    fn inline_frame_documents_stay_in_the_app() {
        let parse = |url: &str| tauri::Url::parse(url).unwrap();
        assert!(is_inline_frame_document(&parse("about:srcdoc")));
        assert!(is_inline_frame_document(&parse("about:blank")));
        assert!(!is_inline_frame_document(&parse("about:config")));
        assert!(!is_inline_frame_document(&parse(
            "https://example.com/srcdoc"
        )));
        assert!(!is_inline_frame_document(&parse("data:text/html,x")));
    }

    #[test]
    fn log_timestamps_are_utc_iso() {
        assert_eq!(format_utc_millis(0), "1970-01-01T00:00:00.000Z");
        // 2024-02-29 (leap day) 23:59:59.999
        assert_eq!(
            format_utc_millis(1_709_251_199_999),
            "2024-02-29T23:59:59.999Z"
        );
        assert_eq!(
            format_utc_millis(1_791_784_131_078),
            "2026-10-12T05:48:51.078Z"
        );
    }

    #[test]
    fn popup_menu_entries_parse_the_shape_the_ui_sends() {
        // Mirrors `toPopupSpec` in lib/desktop-menu-model.ts.
        let entries: Vec<PopupMenuEntry> = serde_json::from_str(
            r#"[
                {"kind":"item","id":"0","text":"Open","enabled":true},
                {"kind":"item","id":"1","text":"Pinned","enabled":false,"checked":true},
                {"kind":"separator"},
                {"kind":"submenu","text":"Open With","enabled":true,"items":[
                    {"kind":"item","id":"2","text":"Editor","enabled":true}
                ]},
                {"kind":"predefined","item":"Copy"},
                {"kind":"predefined","item":"Paste","text":"Einfügen"}
            ]"#,
        )
        .expect("entries parse");
        assert_eq!(entries.len(), 6);
        assert!(matches!(
            &entries[1],
            PopupMenuEntry::Item {
                checked: Some(true),
                enabled: false,
                ..
            }
        ));
        assert!(matches!(&entries[3], PopupMenuEntry::Submenu { items, .. } if items.len() == 1));
        assert!(
            matches!(&entries[5], PopupMenuEntry::Predefined { text: Some(text), .. } if text == "Einfügen")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn lists_applications_that_can_open_a_text_file() {
        let file = std::env::temp_dir().join(format!("pi-open-with-{}.txt", std::process::id()));
        std::fs::write(&file, "hello").unwrap();
        let apps = super::list_apps_for_file_macos(&file);
        let _ = std::fs::remove_file(&file);

        let apps = apps.unwrap();
        let apps = apps.as_array().expect("an array of apps");
        assert!(!apps.is_empty(), "TextEdit at least can open a .txt file");
        for app in apps {
            let path = app["path"].as_str().expect("path");
            assert!(path.ends_with(".app"), "{path}");
            assert!(!app["name"].as_str().expect("name").is_empty());
            assert!(app["isDefault"].is_boolean());
        }
        let defaults = apps.iter().filter(|app| app["isDefault"] == true).count();
        assert!(defaults <= 1);
        if defaults == 1 {
            assert_eq!(apps[0]["isDefault"], true, "default app is listed first");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn source_code_files_skip_apps_that_only_claim_plain_text() {
        let file = std::env::temp_dir().join(format!("pi-open-with-{}.mjs", std::process::id()));
        std::fs::write(&file, "export {};").unwrap();
        let apps = super::list_apps_for_file_macos(&file);
        let _ = std::fs::remove_file(&file);

        let apps = apps.unwrap();
        for app in apps.as_array().expect("an array of apps") {
            let path = app["path"].as_str().expect("path");
            for office in ["Microsoft Word.app", "Microsoft Excel.app", "Numbers.app", "Notes.app"] {
                assert!(!path.ends_with(office), "{path} only claims generic text");
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn open_with_refuses_relative_missing_and_non_bundle_targets() {
        let file =
            std::env::temp_dir().join(format!("pi-open-with-guard-{}.txt", std::process::id()));
        std::fs::write(&file, "hello").unwrap();
        let bundle = Path::new("/System/Applications/TextEdit.app");

        assert!(super::open_path_with_app_macos(Path::new("relative.txt"), bundle).is_err());
        assert!(super::open_path_with_app_macos(&file.with_extension("missing"), bundle).is_err());
        // A regular file, or a folder that is not an .app bundle, is never launched.
        assert!(super::open_path_with_app_macos(&file, &file).is_err());
        assert!(super::open_path_with_app_macos(&file, Path::new("/usr/bin")).is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[cfg(windows)]
    #[test]
    fn simplifies_verbatim_windows_path_before_launching_node() {
        let path = Path::new(
            r"\\?\C:\Users\毕良霞\AppData\Local\Pi Agent\resources\server\desktop-server.cjs",
        );

        assert_eq!(
            child_process_compatible_path(path),
            PathBuf::from(
                r"C:\Users\毕良霞\AppData\Local\Pi Agent\resources\server\desktop-server.cjs"
            )
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn leaves_non_windows_path_unchanged() {
        let path = Path::new("/Applications/Pi Agent.app/Contents/Resources/server");
        assert_eq!(child_process_compatible_path(path), PathBuf::from(path));
    }

    #[test]
    fn packaged_server_handshake_requires_the_expected_instance_header() {
        let expected = "instance-123";
        let matching = b"HTTP/1.1 204 No Content\r\nx-pi-desktop-instance: instance-123\r\n\r\n";
        let wrong = b"HTTP/1.1 204 No Content\r\nx-pi-desktop-instance: other\r\n\r\n";
        let body_spoof = b"HTTP/1.1 204 No Content\r\nContent-Type: text/plain\r\n\r\ninstance-123";

        assert!(response_has_instance_id(matching, expected));
        assert!(!response_has_instance_id(wrong, expected));
        assert!(!response_has_instance_id(body_spoof, expected));
    }
}

#[cfg(not(feature = "custom-protocol"))]
fn start_development_server(
    _app: &tauri::AppHandle,
) -> Result<(Url, DesktopServer), Box<dyn std::error::Error>> {
    Ok((DEV_SERVER_URL.parse()?, DesktopServer::empty()))
}

/// Single-instance guard (Linux only). Launching the app binary again starts a
/// brand-new process instead of focusing the running one, which left multiple
/// server/window copies in the background. We claim a PID lock file; a later
/// launch asks the live instance to raise its window via a request file and
/// exits without starting another server. macOS already gets that behavior
/// from the OS (LaunchServices + the `Reopen` handler below), and Windows has
/// its own semantics, so this mechanism is intentionally Linux-scoped and
/// keeps its `/proc`-based liveness probe off the other platforms.
///
/// Focus signalling deliberately uses a polled request file instead of a
/// signal: JavaScriptCore owns SIGUSR1 on Linux (its GC suspension signal),
/// and raising it from a second launch would land in JSC's GC handler and
/// corrupt the process (SEGV).
#[cfg(target_os = "linux")]
const FOCUS_REQUEST_FILE: &str = "focus.request";

#[cfg(target_os = "linux")]
fn instance_lock_path() -> Option<PathBuf> {
    let base = env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var("XDG_CONFIG_HOME")
                .ok()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            env::var("HOME")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|value| PathBuf::from(value).join(".config"))
        });
    base.map(|value| value.join("com.abcwyc.pi-agent").join("pi-agent.lock"))
}

#[cfg(target_os = "linux")]
fn process_is_our_app(pid: i32) -> bool {
    fs::read_to_string(format!("/proc/{pid}/cmdline"))
        .map(|content| {
            let lowered = content.to_lowercase();
            lowered.contains("pi-agent") || lowered.contains("pi agent")
        })
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn read_lock_pid(path: &Path) -> Option<i32> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| raw.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0)
}

/// Ask a live instance recorded in the lock file to raise its window, if any.
#[cfg(target_os = "linux")]
fn focus_existing_instance(path: &Path) -> bool {
    if let Some(pid) = read_lock_pid(path) {
        if process_is_our_app(pid) && unsafe { libc::kill(pid, 0) } == 0 {
            // The primary's focus monitor polls this file (see
            // `spawn_focus_monitor`); the secondary never signals it.
            if let Some(request) = focus_request_path() {
                let _ = fs::write(&request, b"1");
            }
            return true;
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn focus_request_path() -> Option<PathBuf> {
    instance_lock_path().map(|lock| match lock.parent() {
        Some(parent) => parent.join(FOCUS_REQUEST_FILE),
        None => lock,
    })
}

/// Returns true when this process should become the primary instance. When
/// another live instance already owns the lock, this asks it to show its
/// window and returns false so the caller can exit.
#[cfg(target_os = "linux")]
fn ensure_single_instance() -> bool {
    let Some(path) = instance_lock_path() else {
        return true;
    };

    // An existing live instance owns the lock: focus it and stay secondary.
    if focus_existing_instance(&path) {
        return false;
    }

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // The lock file can outlive its owner: a crashed, killed, or panicked
    // instance never removes it, and a launch interrupted between open() and
    // write() leaves an empty file. Reclaim it only when the recorded PID is
    // no longer a live copy of this app, so a genuinely running instance is
    // never displaced by a mistaken cleanup.
    if path.exists() {
        let owner_live = read_lock_pid(&path)
            .map(|pid| process_is_our_app(pid) && unsafe { libc::kill(pid, 0) } == 0)
            .unwrap_or(false);
        if !owner_live {
            let _ = fs::remove_file(&path);
        }
    }

    // Claim the lock atomically so two near-simultaneous launches cannot both
    // become primary. `create_new` (O_CREAT | O_EXCL) fails if the file exists.
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            let _ = file.write_all(std::process::id().to_string().as_bytes());
            let _ = file.sync_all();
            // Clear a focus request left behind by a crashed previous primary.
            if let Some(request) = focus_request_path() {
                let _ = fs::remove_file(request);
            }
            true
        }
        Err(_) => {
            // Lost the race: defer to the instance that won the lock.
            focus_existing_instance(&path);
            false
        }
    }
}

#[cfg(target_os = "linux")]
fn remove_instance_lock() {
    if let Some(path) = instance_lock_path() {
        // Only remove a lock this process owns; never delete a lock that a
        // racing launch reclaimed after our shutdown began.
        if read_lock_pid(&path) == Some(std::process::id() as i32) {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(target_os = "linux")]
fn spawn_focus_monitor(app: AppHandle) {
    thread::spawn(move || loop {
        if let Some(request) = focus_request_path() {
            if request.exists() {
                // Consume the request before dispatching so a repeat request
                // while the window cannot be raised still triggers a retry.
                let _ = fs::remove_file(&request);
                let value = app.clone();
                let _ = app.run_on_main_thread(move || show_main_window(&value));
            }
        }
        thread::sleep(Duration::from_millis(120));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    mark_process_start();
    install_panic_hook();

    // Become the single instance (Linux). If another live instance owns the
    // lock, focus it and exit without starting a second server/window.
    #[cfg(target_os = "linux")]
    {
        if !ensure_single_instance() {
            std::process::exit(0);
        }
    }

    let desktop_api_token = load_or_generate_desktop_api_token()
        .expect("failed to create desktop API authorization token");
    let desktop_instance_id =
        generate_random_hex().expect("failed to create desktop server instance id");
    #[cfg(feature = "custom-protocol")]
    let server_api_token = desktop_api_token.clone();
    #[cfg(feature = "custom-protocol")]
    let server_instance_id = desktop_instance_id.clone();
    let app = tauri::Builder::default()
        // Launch at login. The OS entry (LaunchAgent / registry Run key /
        // .desktop file) is the source of truth; the UI reads it back through
        // the plugin instead of keeping its own copy. The flag lets a login
        // launch start hidden in the tray rather than pop a window over the
        // user's desktop.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        // Restores the window's size, position and maximized state on the next
        // launch and saves them when it closes or the app exits. Only those
        // three: VISIBLE would resurrect a window the user hid to the tray
        // before quitting (this app owns show/hide itself), and DECORATIONS
        // would fight the custom window chrome.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .on_menu_event(|app, event| {
            if backend::menu_event(app, event.id().as_ref()) {
                return;
            }
            if event.id().as_ref() == "settings-backend" {
                if let Err(error) = backend::show_settings(app) {
                    eprintln!("Backend settings failed: {error}");
                }
                return;
            }
            // A popup menu's click: hand it to the command waiting on it.
            if event.id().as_ref().starts_with(POPUP_ID_PREFIX) {
                if let Some(state) = app.try_state::<PopupMenuSelection>() {
                    if let Ok(slot) = state.0.lock() {
                        if let Some(sender) = slot.as_ref() {
                            let _ = sender.send(event.id().as_ref().to_string());
                        }
                    }
                }
                return;
            }
            let action = match event.id().as_ref() {
                "new-session" => Some("new-session"),
                "settings-general" => Some("settings-general"),
                "settings-models" => Some("settings-models"),
                _ => None,
            };
            let Some(action) = action else { return };
            if let Err(error) = app.emit("pi-agent-menu-action", action) {
                eprintln!("Pi Agent menu action failed: {error}");
            }
        })
        .manage(backend::SwitcherMenu::default())
        .manage(CloseQuits(Mutex::new(false)))
        .manage(PopupMenuSelection::default())
        .manage(DesktopApiToken(desktop_api_token))
        .invoke_handler(tauri::generate_handler![
            backend::get_backends,
            backend::save_backend,
            backend::remove_backend,
            backend::activate_backend,
            get_desktop_api_token,
            open_external_url,
            open_path,
            open_log_dir,
            reveal_item_in_dir,
            list_apps_for_file,
            open_path_with,
            show_popup_menu,
            set_close_quits,
            quit_app,
            show_main_window_cmd,
            app_ready,
            window_painted,
            set_ui_theme,
            clear_app_cache
        ])
        .setup(move |app| {
            desktop_log(
                app.handle(),
                &format!(
                    "startup v{} pid {} ({})",
                    env!("CARGO_PKG_VERSION"),
                    std::process::id(),
                    env::consts::OS
                ),
            );
            // The updater public key is embedded at compile time by the release
            // workflow. Local development builds intentionally omit it, which
            // keeps unsigned builds from accepting production updates.
            if let Some(public_key) = option_env!("PI_AGENT_DESKTOP_UPDATER_PUBLIC_KEY")
                .map(str::trim)
                .filter(|key| !key.is_empty())
            {
                app.handle().plugin(
                    tauri_plugin_updater::Builder::new()
                        .pubkey(public_key)
                        .build(),
                )?;
            }

            // Clear stale webview caches when the app version changed since the
            // last successful launch (fixes WebKitGTK loading stale hashed
            // Next.js assets after an upgrade).
            reconcile_webview_cache_for_version(app.handle());
            match backend::read(app.handle()) {
                Ok(Some(url)) => {
                    app.manage(DesktopServer::empty());
                    backend::build_remote_window(app.handle(), url)?;
                }
                Ok(None) => {
                    #[cfg(feature = "custom-protocol")]
                    let started =
                        start_packaged_server(app.handle(), &server_api_token, &server_instance_id);
                    #[cfg(not(feature = "custom-protocol"))]
                    let started = start_development_server(app.handle());
                    match started {
                        Ok((url, server)) => {
                            desktop_log(app.handle(), &format!("server ready at {url}"));
                            desktop_log(
                                app.handle(),
                                &format!(
                                    "startup timing: server ready (+{}ms)",
                                    since_process_start_ms()
                                ),
                            );
                            app.manage(server);
                            #[cfg(feature = "custom-protocol")]
                            if let Some(port) = url.port() {
                                spawn_server_monitor(
                                    app.handle().clone(),
                                    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                                    server_instance_id.clone(),
                                );
                            }
                            build_window(app.handle(), url)?;
                            // Safety net: whatever the page does, the hidden window appears.
                            schedule_reveal_deadline(app.handle());
                        }
                        Err(error) => {
                            eprintln!("Local backend failed to start: {error}");
                            app.manage(DesktopServer::empty());
                            backend::show_settings(app.handle())?;
                        }
                    }
                }
                Err(_) => {
                    app.manage(DesktopServer::empty());
                    backend::show_settings(app.handle())?;
                }
            }
            if launched_at_login() {
                for label in [WINDOW_LABEL, backend::REMOTE_WINDOW] {
                    if let Some(window) = app.get_webview_window(label) {
                        let _ = window.hide();
                    }
                }
            }
            // Record the current version only after the window built cleanly,
            // so a startup crash keeps the cache clear flagged on relaunch.
            write_last_version(app.handle());

            #[cfg(target_os = "linux")]
            build_linux_tray(app)?;
            // Keep the standard macOS menu even while the web UI draws its own
            // top bar; only this path owns Edit commands and Cmd+,/Cmd+M.
            #[cfg(target_os = "macos")]
            build_macos_app_menu(app.handle())?;
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            build_platform_tray(app)?;

            #[cfg(target_os = "linux")]
            spawn_focus_monitor(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == WINDOW_LABEL || window.label() == backend::REMOTE_WINDOW {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let quit = window
                        .app_handle()
                        .try_state::<CloseQuits>()
                        .and_then(|state| state.0.lock().ok().map(|guard| *guard))
                        .unwrap_or(false);
                    if quit {
                        quit_application(window.app_handle());
                    } else {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Pi Agent desktop app");

    app.run(|app_handle, event| match event {
        RunEvent::Exit => {
            desktop_log(app_handle, "exit");
            #[cfg(target_os = "linux")]
            remove_instance_lock();
            if let Some(server) = app_handle.try_state::<DesktopServer>() {
                server.stop();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } if !has_visible_windows => {
            shell::show_main_window(app_handle);
        }
        _ => {}
    });
}
