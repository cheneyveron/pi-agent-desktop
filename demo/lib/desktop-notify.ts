import { isTauriDesktop } from "@/lib/desktop-updater";
import { APP_PREF_KEYS, getPrefBool } from "@/lib/app-prefs";

export function desktopNotificationsEnabled(): boolean {
  return getPrefBool(APP_PREF_KEYS.notifyOnComplete, true);
}

async function ensurePermission(): Promise<boolean> {
  const {
    isPermissionGranted,
    requestPermission,
  } = await import("@tauri-apps/plugin-notification");
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }
  return granted;
}

/** Show a native notification when the desktop window is in the background. */
export async function notifyDesktop(options: {
  title: string;
  body: string;
}): Promise<void> {
  if (!isTauriDesktop() || !desktopNotificationsEnabled()) return;

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const focused = await getCurrentWindow().isFocused();
    if (focused) return;
  } catch {
    // If focus cannot be determined, still notify.
  }

  try {
    if (!(await ensurePermission())) return;
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title: options.title, body: options.body });
  } catch (error) {
    console.error("Desktop notification failed:", error);
  }
}

export async function focusDesktopWindow(): Promise<void> {
  if (!isTauriDesktop()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    await window.show();
    await window.unminimize();
    await window.setFocus();
  } catch {
    // ignore
  }
}
