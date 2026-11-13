"use client";

import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_MAIN_SESSION_SETTINGS, type MainSessionSettings } from "@/lib/main-session-settings-core";

// Settings › Main session, shared by the Settings tab, the sidebar row and the shell. One load per
// page; a save updates every subscriber. Until the load answers the feature counts as off, so the
// sidebar never flashes the row of a feature the user has not turned on.

export interface MainSessionSettingsState {
  settings: MainSessionSettings;
  loaded: boolean;
  saving: boolean;
  error: string | null;
}

const ENDPOINT = "/api/main-session-settings";
const INITIAL: MainSessionSettingsState = { settings: DEFAULT_MAIN_SESSION_SETTINGS, loaded: false, saving: false, error: null };

let state = INITIAL;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<MainSessionSettingsState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

async function readResponse(response: Response): Promise<MainSessionSettings> {
  const body = await response.json().catch(() => ({})) as Partial<MainSessionSettings> & { error?: string };
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return {
    enabled: body.enabled === true,
    autoContinue: body.autoContinue === true,
    takeoverMinutes: typeof body.takeoverMinutes === "number" ? body.takeoverMinutes : DEFAULT_MAIN_SESSION_SETTINGS.takeoverMinutes,
  };
}

export function loadMainSessionSettings(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = fetch(ENDPOINT, { cache: "no-store" })
    .then(readResponse)
    .then((settings) => setState({ settings, loaded: true, error: null }))
    .catch((error: unknown) => setState({ loaded: true, error: error instanceof Error ? error.message : String(error) }));
  return loading;
}

/** Optimistic; rolled back with `error` set when the save fails. Resolves whether it saved. */
export async function saveMainSessionSettings(patch: Partial<MainSessionSettings>): Promise<boolean> {
  const previous = state.settings;
  setState({ settings: { ...previous, ...patch }, saving: true, error: null });
  try {
    const response = await fetch(ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setState({ settings: await readResponse(response), saving: false, loaded: true });
    return true;
  } catch (error) {
    setState({ settings: previous, saving: false, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

export function useMainSessionSettings(): MainSessionSettingsState {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => { void loadMainSessionSettings(); }, []);
  return current;
}

/** Test hook: forget the loaded value. */
export function resetMainSessionSettingsStore(): void {
  state = INITIAL;
  loading = null;
}
