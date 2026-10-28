/**
 * The session a native desktop notification points at.
 *
 * Tauri's notification plugin reports no clicks on desktop (it only forwards
 * title, body, icon and sound to the OS), so a click is seen as the window
 * gaining focus after the notification was posted. The latest notification
 * wins, and a target is used once.
 */

/** A notification older than this no longer decides where focus lands. */
export const NOTIFICATION_TARGET_TTL_MS = 30 * 60 * 1000;

export interface NotificationTargetStore {
  /** Remember the session of a notification just posted (null clears it). */
  set(sessionId: string | null | undefined, now?: number): void;
  /** The session to open on focus, consumed by this call. */
  take(now?: number): string | null;
}

export function createNotificationTargetStore(ttlMs = NOTIFICATION_TARGET_TTL_MS): NotificationTargetStore {
  let pending: { sessionId: string; at: number } | null = null;
  return {
    set(sessionId, now = Date.now()) {
      pending = sessionId ? { sessionId, at: now } : null;
    },
    take(now = Date.now()) {
      const target = pending;
      pending = null;
      if (!target || now - target.at > ttlMs) return null;
      return target.sessionId;
    },
  };
}
