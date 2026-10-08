use std::fs;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const REMOTE_WINDOW: &str = "remote-backend";
const SETTINGS_WINDOW: &str = "backend-settings";

pub fn parse_url(value: &str) -> Result<Option<Url>, String> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    let url = Url::parse(value.trim()).map_err(|_| "Enter a complete http:// or https:// URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Enter a complete http:// or https:// URL".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Use the server URL without credentials, query parameters, or a fragment".into(),
        );
    }
    if url.path() != "/" {
        return Err("Use the server root URL, without a path such as /api".into());
    }
    Ok(Some(url))
}

pub fn read(app: &AppHandle) -> Result<Option<Url>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("backend-url.txt");
    match fs::read_to_string(path) {
        Ok(value) => parse_url(&value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        window.show()?;
        return window.set_focus();
    }
    WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW,
        WebviewUrl::App("desktop-backend.html".into()),
    )
    .title("Backend Connection · 后端连接")
    .inner_size(520.0, 440.0)
    .resizable(false)
    .build()?;
    Ok(())
}

#[tauri::command]
pub fn get_backend_url(app: AppHandle, window: WebviewWindow) -> Result<String, String> {
    if window.label() != SETTINGS_WINDOW {
        return Err("Unavailable in this window".into());
    }
    read(&app).map(|url| url.map(|url| url.to_string()).unwrap_or_default())
}

#[tauri::command]
pub fn set_backend_url(app: AppHandle, window: WebviewWindow, url: String) -> Result<(), String> {
    if window.label() != SETTINGS_WINDOW {
        return Err("Unavailable in this window".into());
    }
    let url = parse_url(&url)?;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("backend-url.txt");
    let pending = dir.join("backend-url.tmp");
    fs::write(&pending, url.map(|url| url.to_string()).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    fs::rename(pending, path).map_err(|e| e.to_string())?;
    app.request_restart();
    Ok(())
}

pub fn build_remote_window(app: &AppHandle, url: Url) -> tauri::Result<WebviewWindow> {
    let origin = url.clone();
    // Separate label: remote pages receive none of the local desktop capabilities,
    // even when the user connects to another loopback server.
    WebviewWindowBuilder::new(app, REMOTE_WINDOW, WebviewUrl::External(url))
        .title("Pi Agent — Remote")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .disable_drag_drop_handler()
        .initialization_script(
            "Object.defineProperty(window, '__PI_REMOTE_BACKEND__', { value: true });",
        )
        .on_navigation(move |url| {
            if super::same_origin(url, &origin) {
                true
            } else {
                super::open_external(url);
                false
            }
        })
        .on_new_window(|url, _| {
            super::open_external(&url);
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::parse_url;

    #[test]
    fn accepts_local_default_and_http_origins() {
        assert_eq!(parse_url(" \n").unwrap(), None);
        for input in [
            "https://pi.example.com",
            " http://localhost:30141/ ",
            "http://[::1]:30141",
        ] {
            assert!(parse_url(input).unwrap().is_some());
        }
        assert_eq!(
            parse_url(" https://pi.example.com ")
                .unwrap()
                .unwrap()
                .as_str(),
            "https://pi.example.com/"
        );
    }

    #[test]
    fn rejects_non_server_urls_and_embedded_secrets() {
        for input in [
            "pi.example.com",
            "file:///tmp/a",
            "javascript:alert(1)",
            "https://user:secret@host",
            "https://host/?token=secret",
            "https://host/#token",
            "https://host/api",
            "https://host/chat/123",
        ] {
            assert!(parse_url(input).is_err(), "{input}");
        }
    }
}
