#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem as MacMenuItem, PredefinedMenuItem, Submenu},
    AppHandle,
};

#[cfg(target_os = "macos")]
pub fn build_macos_app_menu(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_name = app.package_info().name.clone();
    let new_session =
        MacMenuItem::with_id(app, "new-session", "New Session", true, Some("CmdOrCtrl+N"))?;
    let general_settings = MacMenuItem::with_id(
        app,
        "settings-general",
        "General Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let model_settings = MacMenuItem::with_id(
        app,
        "settings-models",
        "Model Settings…",
        true,
        Some("CmdOrCtrl+M"),
    )?;
    let backend_settings = MacMenuItem::with_id(
        app,
        "settings-backend",
        "Backend Connection…",
        true,
        None::<&str>,
    )?;
    let about = PredefinedMenuItem::about(app, None, None)?;
    let services = PredefinedMenuItem::services(app, None)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let app_menu = Submenu::with_items(
        app,
        app_name,
        true,
        &[
            &about,
            &separator,
            &services,
            &separator,
            &hide,
            &hide_others,
            &separator,
            &quit,
        ],
    )?;
    let file_menu = Submenu::with_items(app, "File", true, &[&new_session])?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let settings_menu = Submenu::with_items(
        app,
        "Settings",
        true,
        &[&general_settings, &model_settings, &backend_settings],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &separator,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &settings_menu,
            &view_menu,
            &window_menu,
        ],
    )?;
    app.set_menu(menu)?;
    Ok(())
}
