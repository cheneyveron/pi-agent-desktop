"use client";

import { useEffect, useState } from "react";
import { PREVIEW_RUNTIME_PATH, type PreviewRuntime } from "./html-preview";

// Loads public/preview-runtime/ once per page. The page fetches it (same
// origin) because the sandboxed preview frames cannot: Chromium blocks their
// requests to localhost. A failed load is forgotten so the next preview retries.

let pending: Promise<PreviewRuntime> | null = null;
let loaded: PreviewRuntime | null = null;

async function fetchText(path: string): Promise<string> {
  const response = await fetch(`${PREVIEW_RUNTIME_PATH}${path}`, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load the React preview runtime (${path}: HTTP ${response.status})`);
  return response.text();
}

export function loadPreviewRuntime(): Promise<PreviewRuntime> {
  if (loaded) return Promise.resolve(loaded);
  pending ??= (async () => {
    const manifest = JSON.parse(await fetchText("manifest.json")) as { modules?: PreviewRuntime["modules"] };
    if (!manifest.modules) throw new Error("The React preview runtime manifest is invalid");
    const [react, sucrase, tailwind] = await Promise.all([
      fetchText("react.js"),
      fetchText("sucrase.js"),
      fetchText("tailwind.js"),
    ]);
    loaded = { react, sucrase, tailwind, modules: manifest.modules };
    return loaded;
  })().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

export type PreviewRuntimeState =
  | { status: "idle" | "loading"; runtime?: undefined; error?: undefined }
  | { status: "ready"; runtime: PreviewRuntime; error?: undefined }
  | { status: "error"; runtime?: undefined; error: string };

/** The runtime once `enabled` (a React preview is about to show); idle otherwise. */
export function usePreviewRuntime(enabled: boolean): PreviewRuntimeState {
  const [state, setState] = useState<PreviewRuntimeState>(() => (
    loaded ? { status: "ready", runtime: loaded } : { status: "idle" }
  ));
  useEffect(() => {
    if (!enabled || state.status === "ready") return;
    let cancelled = false;
    setState({ status: "loading" });
    loadPreviewRuntime().then(
      (runtime) => { if (!cancelled) setState({ status: "ready", runtime }); },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
    // Re-run only when a preview starts needing it; a ready state is final.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return state;
}

/** Test hook. */
export function resetPreviewRuntime(): void {
  pending = null;
  loaded = null;
}
