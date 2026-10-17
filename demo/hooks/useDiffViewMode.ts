"use client";

import { useCallback, useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";

export type DiffViewMode = "split" | "unified";

const DEFAULT: DiffViewMode = "split";
const listeners = new Set<() => void>();

function readStored(): DiffViewMode {
  const v = getPref(APP_PREF_KEYS.diffViewMode);
  return v === "unified" || v === "split" ? v : DEFAULT;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getServerSnapshot(): DiffViewMode {
  return DEFAULT;
}

export function useDiffViewMode(): {
  mode: DiffViewMode;
  setMode: (next: DiffViewMode) => void;
} {
  const mode = useSyncExternalStore(subscribe, readStored, getServerSnapshot);

  const setMode = useCallback((next: DiffViewMode) => {
    setPref(APP_PREF_KEYS.diffViewMode, next);
    listeners.forEach((cb) => cb());
  }, []);

  return { mode, setMode };
}
