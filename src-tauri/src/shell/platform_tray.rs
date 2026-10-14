#[cfg(not(any(target_os = "linux", target_os = "macos")))]
use tauri::menu::{Menu, MenuItem};
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(target_os = "linux")]
use tauri::AppHandle;
// Brings `default_window_icon` / `app_handle` into scope, as lib.rs's glob
// `tauri::Manager` import did before the shell modules were split out.
#[cfg(not(target_os = "macos"))]
#[allow(unused_imports)]
use tauri::Manager;

#[cfg(not(target_os = "macos"))]
use super::{quit_application, show_main_window};

#[cfg(target_os = "linux")]
const LINUX_TRAY_SHOW_LABEL: &str = "Show Pi Agent";
#[cfg(target_os = "linux")]
const LINUX_TRAY_QUIT_LABEL: &str = "Quit Pi Agent";

#[cfg(target_os = "linux")]
struct LinuxTray {
    app: AppHandle,
    icon: ksni::Icon,
}

#[cfg(target_os = "linux")]
impl ksni::Tray for LinuxTray {
    fn id(&self) -> String {
        "pi-agent-desktop".into()
    }

    fn title(&self) -> String {
        "Pi Agent".into()
    }

    fn icon_name(&self) -> String {
        "pi-agent-desktop".into()
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        vec![self.icon.clone()]
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: "Pi Agent".into(),
            ..Default::default()
        }
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        show_main_window_on_main_thread(&self.app);
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        let show_app = self.app.clone();
        let quit_app = self.app.clone();

        vec![
            visible_linux_tray_item(LINUX_TRAY_SHOW_LABEL, move |_| {
                show_main_window_on_main_thread(&show_app)
            }),
            visible_linux_tray_item(LINUX_TRAY_QUIT_LABEL, move |_| {
                quit_application_on_main_thread(&quit_app)
            }),
        ]
    }
}

#[cfg(target_os = "linux")]
fn visible_linux_tray_item<T: 'static>(
    label: &str,
    activate: impl Fn(&mut T) + 'static,
) -> ksni::MenuItem<T> {
    ksni::menu::StandardItem {
        label: label.into(),
        enabled: true,
        visible: true,
        activate: Box::new(activate),
        ..Default::default()
    }
    .into()
}

#[cfg(target_os = "linux")]
fn show_main_window_on_main_thread(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || show_main_window(&app_handle));
}

#[cfg(target_os = "linux")]
fn quit_application_on_main_thread(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || quit_application(&app_handle));
}

#[cfg(target_os = "linux")]
fn linux_tray_icon(icon: &tauri::image::Image<'_>) -> ksni::Icon {
    let mut data = Vec::with_capacity(icon.rgba().len());
    for rgba in icon.rgba().chunks_exact(4) {
        data.extend_from_slice(&[rgba[3], rgba[0], rgba[1], rgba[2]]);
    }

    ksni::Icon {
        width: icon.width() as i32,
        height: icon.height() as i32,
        data,
    }
}

#[cfg(target_os = "linux")]
pub fn build_linux_tray(app: &tauri::App) -> Result<(), std::io::Error> {
    let icon = app
        .default_window_icon()
        .ok_or_else(|| std::io::Error::other("missing default window icon"))?;
    let service = ksni::TrayService::new(LinuxTray {
        app: app.handle().clone(),
        icon: linux_tray_icon(icon),
    });

    std::thread::spawn(move || {
        if let Err(error) = service.run() {
            eprintln!("Pi Agent Linux tray stopped: {error}");
        }
    });
    Ok(())
}

// macOS has no tray icon: the Dock icon re-shows a hidden window (the `Reopen`
// handler below) and the app menu owns Quit, so a menu-bar item would only
// duplicate both. Windows keeps it, since it is the only way back to a window
// hidden on close.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn build_platform_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "Show Pi Agent", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Pi Agent", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| std::io::Error::other("missing default window icon"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Pi Agent")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => quit_application(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{visible_linux_tray_item, LinuxTray, LINUX_TRAY_QUIT_LABEL, LINUX_TRAY_SHOW_LABEL};

    #[test]
    fn linux_tray_menu_items_publish_visible_labels() {
        for label in [LINUX_TRAY_SHOW_LABEL, LINUX_TRAY_QUIT_LABEL] {
            let item = visible_linux_tray_item(label, |_: &mut LinuxTray| {});
            let ksni::MenuItem::Standard(item) = item else {
                panic!("Linux tray command must be a standard menu item");
            };

            assert_eq!(item.label, label);
            assert!(item.enabled);
            assert!(item.visible);
        }
    }
}
