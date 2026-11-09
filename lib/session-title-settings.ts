import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";

/**
 * Whether a new session is named automatically from its first message
 * (`lib/session-auto-name.ts`). Upstream ships this off by default (the title
 * is one extra request to the session's own model); the fork named every new
 * session before the switch existed, so here it stays on until the user turns
 * it off. An unreadable settings file keeps it off.
 */
export function isAutoTitleEnabled(settingsPath = getPiWebSettingsPath()): boolean {
  try {
    return readStored(settingsPath).autoTitle !== false;
  } catch {
    return false;
  }
}

export function writeAutoTitleEnabled(enabled: boolean, settingsPath = getPiWebSettingsPath()): boolean {
  updatePiWebSettings({ autoTitle: enabled }, settingsPath);
  return isAutoTitleEnabled(settingsPath);
}
