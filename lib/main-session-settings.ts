import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Settings › Main session: whether the main session runs at all, whether it may continue work
// on its own, and how long a session has to sit idle before its close-out hands it over.
// Kept under `mainSession` in Pi Web's settings file (`<agentDir>/pi-web/settings.json`), which
// both the app (close-out extension, sidebar, stream client) and the main-session service read.
// Node-only imports: the service loads this file with native type stripping.

import { DEFAULT_MAIN_SESSION_SETTINGS, parseMainSessionSettings, type MainSessionSettings } from "./main-session-settings-core.ts";

export * from "./main-session-settings-core.ts";

/** `<agentDir>/pi-web/settings.json`, with the agent dir found as the SDK finds it. */
export function piWebSettingsFile(agentDir: string = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): string {
  return join(agentDir, "pi-web", "settings.json");
}

/** An unreadable file reads as the defaults: the feature stays off rather than half on. */
export function readMainSessionSettings(settingsPath: string = piWebSettingsFile()): MainSessionSettings {
  try {
    if (!existsSync(settingsPath)) return { ...DEFAULT_MAIN_SESSION_SETTINGS };
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    const stored = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).mainSession : undefined;
    return parseMainSessionSettings(stored);
  } catch {
    return { ...DEFAULT_MAIN_SESSION_SETTINGS };
  }
}
