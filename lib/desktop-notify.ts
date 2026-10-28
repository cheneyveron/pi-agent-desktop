import { isTauriDesktop } from "@/lib/desktop-updater";
import { APP_PREF_KEYS, getPrefBool } from "@/lib/app-prefs";
import { createNotificationTargetStore } from "@/lib/notification-target";

const notificationTarget = createNotificationTargetStore();

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
  /** Session opened when the user clicks the notification. */
  sessionId?: string | null;
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
    notificationTarget.set(options.sessionId);
  } catch (error) {
    console.error("Desktop notification failed:", error);
  }
}

/**
 * Call `onOpen` with the session of the last notification when the window next
 * gains focus. The desktop plugin reports no clicks, and clicking a notification
 * focuses the app, so that focus is taken as the click.
 */
export function onDesktopNotificationOpened(onOpen: (sessionId: string) => void): () => void {
  if (!isTauriDesktop()) return () => {};
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      const sessionId = notificationTarget.take();
      if (sessionId) onOpen(sessionId);
    }))
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
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
