// Settings › Main session values without any Node import: the browser bundle, the app server and
// the main-session service (native type stripping) all load this file. Reading the file is in
// main-session-settings.ts.

export interface MainSessionSettings {
  /** The whole feature: close-outs, the service's checks and model turns, the page. Off by default. */
  enabled: boolean;
  /** The main session may hand a step to a task's session on its own (its `continue`). Off by default. */
  autoContinue: boolean;
  /** Idle minutes after a run before the session's close-out reaches the main session. */
  takeoverMinutes: number;
}

export const MAIN_SESSION_TAKEOVER_MINUTES = [1, 2, 5, 10, 15, 30, 60] as const;

export const DEFAULT_MAIN_SESSION_SETTINGS: MainSessionSettings = Object.freeze({
  enabled: false,
  autoContinue: false,
  takeoverMinutes: 5,
});

const MAX_TAKEOVER_MINUTES = 24 * 60;

function parseMinutes(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const minutes = Math.round(value);
  return minutes >= 1 && minutes <= MAX_TAKEOVER_MINUTES ? minutes : undefined;
}

/** The stored `mainSession` value with every missing or malformed field at its default. */
export function parseMainSessionSettings(raw: unknown): MainSessionSettings {
  const value = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    enabled: value.enabled === true,
    autoContinue: value.autoContinue === true,
    takeoverMinutes: parseMinutes(value.takeoverMinutes) ?? DEFAULT_MAIN_SESSION_SETTINGS.takeoverMinutes,
  };
}

/** Validates a partial update; throws with a message for the HTTP 400. */
export function parseMainSessionSettingsPatch(raw: unknown): Partial<MainSessionSettings> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("body must be an object");
  const value = raw as Record<string, unknown>;
  const patch: Partial<MainSessionSettings> = {};
  for (const key of ["enabled", "autoContinue"] as const) {
    if (!(key in value)) continue;
    if (typeof value[key] !== "boolean") throw new Error(`${key} must be a boolean`);
    patch[key] = value[key] as boolean;
  }
  if ("takeoverMinutes" in value) {
    const minutes = parseMinutes(value.takeoverMinutes);
    if (minutes === undefined) throw new Error(`takeoverMinutes must be a whole number from 1 to ${MAX_TAKEOVER_MINUTES}`);
    patch.takeoverMinutes = minutes;
  }
  if (Object.keys(patch).length === 0) throw new Error("enabled, autoContinue or takeoverMinutes is required");
  return patch;
}
