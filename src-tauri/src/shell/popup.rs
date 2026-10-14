use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager};

use crate::logging::desktop_log;

/// One entry of a popup menu, as the UI describes it. The menu is built here,
/// from this plain data, instead of through the JS menu API: that API keeps the
/// menu and its items as resources the page holds, routes clicks back through
/// JS channels, and its `popup` command holds the webview's resource-table lock
/// while the main thread runs the menu. A menu that never leaves Rust has none
/// of that to deadlock on.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PopupMenuEntry {
    Item {
        id: String,
        text: String,
        enabled: bool,
        checked: Option<bool>,
    },
    Separator,
    Submenu {
        text: String,
        enabled: bool,
        items: Vec<PopupMenuEntry>,
    },
    Predefined {
        item: String,
        text: Option<String>,
    },
}

/// Where a popup menu's selected item is delivered. The menu's click arrives as
/// an app-level menu event (some platforms deliver it after the popup call has
/// returned), so the command parks a sender here and waits for it.
#[derive(Default)]
pub struct PopupMenuSelection(pub Mutex<Option<std::sync::mpsc::Sender<String>>>);

pub const POPUP_ID_PREFIX: &str = "popup:";
/// How long to wait for the click after the popup call returns.
const POPUP_SELECTION_GRACE: Duration = Duration::from_millis(400);

fn build_popup_items(
    app: &AppHandle,
    nonce: u64,
    entries: &[PopupMenuEntry],
) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>>> {
    use tauri::menu::{CheckMenuItem, IsMenuItem, MenuItem, PredefinedMenuItem, Submenu};

    let mut out: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::with_capacity(entries.len());
    for entry in entries {
        match entry {
            PopupMenuEntry::Item {
                id,
                text,
                enabled,
                checked,
            } => {
                let menu_id = format!("{POPUP_ID_PREFIX}{nonce}:{id}");
                match checked {
                    Some(checked) => out.push(Box::new(CheckMenuItem::with_id(
                        app,
                        menu_id,
                        text,
                        *enabled,
                        *checked,
                        None::<&str>,
                    )?)),
                    None => out.push(Box::new(MenuItem::with_id(
                        app,
                        menu_id,
                        text,
                        *enabled,
                        None::<&str>,
                    )?)),
                }
            }
            PopupMenuEntry::Separator => out.push(Box::new(PredefinedMenuItem::separator(app)?)),
            PopupMenuEntry::Submenu {
                text,
                enabled,
                items,
            } => {
                let children = build_popup_items(app, nonce, items)?;
                let refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
                    children.iter().map(|item| item.as_ref()).collect();
                out.push(Box::new(Submenu::with_items(app, text, *enabled, &refs)?));
            }
            PopupMenuEntry::Predefined { item, text } => {
                let text = text.as_deref();
                let built = match item.as_str() {
                    "Copy" => PredefinedMenuItem::copy(app, text)?,
                    "Cut" => PredefinedMenuItem::cut(app, text)?,
                    "Paste" => PredefinedMenuItem::paste(app, text)?,
                    "SelectAll" => PredefinedMenuItem::select_all(app, text)?,
                    "Undo" => PredefinedMenuItem::undo(app, text)?,
                    "Redo" => PredefinedMenuItem::redo(app, text)?,
                    _ => continue,
                };
                out.push(Box::new(built));
            }
        }
    }
    Ok(out)
}

/// Shows `items` as a native popup menu and resolves to the id of the item the
/// user picked, or `None` when it was dismissed. Nothing runs while the menu is
/// open except the menu itself: the page gets the answer afterwards.
#[tauri::command]
pub async fn show_popup_menu(
    app: AppHandle,
    window: tauri::Window,
    items: Vec<PopupMenuEntry>,
    at: Option<tauri::LogicalPosition<f64>>,
) -> Result<Option<String>, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri::menu::{ContextMenu as _, Menu};

    static NEXT_NONCE: AtomicU64 = AtomicU64::new(1);
    let nonce = NEXT_NONCE.fetch_add(1, Ordering::Relaxed);

    // The item boxes are not `Send`; they must be gone before the first await.
    let menu = {
        let built = build_popup_items(&app, nonce, &items).map_err(|error| error.to_string())?;
        let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
            built.iter().map(|item| item.as_ref()).collect();
        Menu::with_items(&app, &refs).map_err(|error| error.to_string())?
    };

    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    if let Some(state) = app.try_state::<PopupMenuSelection>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(sender);
        }
    }

    desktop_log(
        &app,
        &format!("popup #{nonce} open ({} entries)", items.len()),
    );
    let started = Instant::now();
    // Blocks until the menu is dismissed; keep it off the shared async pool.
    let popup = tauri::async_runtime::spawn_blocking(move || match at {
        Some(position) => menu.popup_at(window, position),
        None => menu.popup(window),
    })
    .await
    .map_err(|error| error.to_string())?;
    desktop_log(
        &app,
        &format!(
            "popup #{nonce} closed after {}ms",
            started.elapsed().as_millis()
        ),
    );
    popup.map_err(|error| error.to_string())?;

    let wanted = format!("{POPUP_ID_PREFIX}{nonce}:");
    let chosen = receiver
        .recv_timeout(POPUP_SELECTION_GRACE)
        .ok()
        .and_then(|id| id.strip_prefix(&wanted).map(str::to_string));
    if let Some(state) = app.try_state::<PopupMenuSelection>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = None;
        }
    }
    desktop_log(&app, &format!("popup #{nonce} selected {chosen:?}"));
    Ok(chosen)
}
