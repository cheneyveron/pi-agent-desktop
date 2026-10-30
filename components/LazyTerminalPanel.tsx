"use client";

import { useEffect, useState, type ComponentProps } from "react";
import type { TerminalPanel as TerminalComponent } from "./TerminalPanel";

type Panel = typeof TerminalComponent;
let loadedPanel: Panel | undefined;
let loading: Promise<Panel> | undefined;

/** Load renderer code only; never create a shell before the user opens a tab. */
export function preloadTerminalPanel(): Promise<Panel> {
  return loading ??= import("./TerminalPanel").then(
    (module) => (loadedPanel = module.TerminalPanel),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
}

// next/dynamic creates its own React.lazy state even if import() was prewarmed.
// Its first render still suspends and can incur React's 300ms fallback throttle.
// Render the cached component synchronously, or publish it when loading finishes.
export function LazyTerminalPanel(props: ComponentProps<Panel>) {
  const [Component, setComponent] = useState<Panel | undefined>(() => loadedPanel);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (Component) return;
    let cancelled = false;
    void preloadTerminalPanel().then(
      (panel) => { if (!cancelled) setComponent(() => panel); },
      (reason: unknown) => { if (!cancelled) setError(reason); },
    );
    return () => { cancelled = true; };
  }, [Component]);

  if (error) throw error;
  return Component ? <Component {...props} /> : null;
}
