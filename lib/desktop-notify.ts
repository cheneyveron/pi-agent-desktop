import { isTauriDesktop } from "@/lib/desktop-updater";
import { APP_PREF_KEYS, getPrefBool } from "@/lib/app-prefs";

export function desktopNotificationsEnabled(): boolean {
  return getPrefBool(APP_PREF_KEYS.notifyOnComplete, true);
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
    // The shell posts it and reports a click on it; the plugin's own
    // sendNotification cannot tell a click from any other way back to the app.
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_session_notification", {
      title: options.title,
      body: options.body,
      sessionId: options.sessionId ?? null,
    });
  } catch (error) {
    console.error("Desktop notification failed:", error);
  }
}

/**
 * Call `onOpen` with the session of a native notification the user clicked.
 * The shell has already brought the window forward by then.
 */
export function onDesktopNotificationClicked(onOpen: (sessionId: string) => void): () => void {
  if (!isTauriDesktop()) return () => {};
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<string>("pi-agent-notification-clicked", ({ payload }) => onOpen(payload)))
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    })
    .catch((error) => {
      console.error("Failed to listen for notification clicks:", error);
    });
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
