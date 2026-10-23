import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

export const CHAT_UNLOCK_TYPE = "pi-web:chat-unlock";

export interface ChatUnlockData {
  version: 1;
  unlocked: boolean;
}

/**
 * A chat starts with a shell-less loadout confined to its own folder. The user can lift that
 * for one chat ("let this chat use my computer"): the newest entry wins, so locking again is
 * another entry rather than an edit of the log.
 */
export function readChatUnlocked(entries: readonly SessionEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== CHAT_UNLOCK_TYPE) continue;
    const data = entry.data as Partial<ChatUnlockData> | undefined;
    if (data && data.version === 1 && typeof data.unlocked === "boolean") return data.unlocked;
  }
  return false;
}

export function appendChatUnlock(sessionManager: SessionManager, unlocked: boolean): void {
  sessionManager.appendCustomEntry(CHAT_UNLOCK_TYPE, { version: 1, unlocked } satisfies ChatUnlockData);
}
