"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerUpdateState } from "@/lib/server-updater";

const POLL_MS = 2_000;
// Building can take minutes; a server that stays unreachable this long did not come back.
const RESTART_GRACE_MS = 5 * 60 * 1000;

async function readState(init?: RequestInit): Promise<ServerUpdateState> {
  const response = await fetch("/api/updates/install", { cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as (ServerUpdateState & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? `HTTP ${response.status}`);
  // Render reads `status.phase`; an answer without it (another server, a stub) must not crash Settings.
  if (typeof body.status?.phase !== "string") throw new Error("Unexpected update status response.");
  return body;
}

/**
 * Drives "Upgrade" for a remote server: asks the backend to pull and install
 * the latest release, follows its progress, and reloads the page once the
 * restarted server reports a different version. A server that goes away
 * during the restart is expected, not an error.
 */
export function useServerUpgrade() {
  const [state, setState] = useState<ServerUpdateState | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startVersionRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readState().then((next) => {
      if (cancelled) return;
      setState(next);
      // Another tab (or an earlier visit) already started an update: follow it.
      if (next.supported && next.status.phase !== "idle" && next.status.phase !== "failed") {
        startVersionRef.current = next.currentVersion;
        setActive(true);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unreachableSince: number | null = null;

    const stop = (message: string | null) => {
      setActive(false);
      setError(message);
    };
    const tick = async () => {
      try {
        const next = await readState();
        if (cancelled) return;
        unreachableSince = null;
        setState(next);
        if (next.status.phase === "failed") return stop(next.status.error ?? "Update failed.");
        if (next.status.phase === "idle") {
          if (next.currentVersion !== startVersionRef.current) {
            window.location.reload();
            return;
          }
          return stop("The server came back on the previous version.");
        }
      } catch {
        if (cancelled) return;
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince > RESTART_GRACE_MS) {
          return stop("The server did not come back after restarting.");
        }
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const next = await readState({ method: "POST" });
      startVersionRef.current = next.currentVersion;
      setState(next);
      setActive(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  return {
    supported: Boolean(state?.supported),
    phase: active || state?.status.phase === "failed" ? state?.status.phase ?? "idle" : "idle",
    active,
    error,
    start,
  };
}
