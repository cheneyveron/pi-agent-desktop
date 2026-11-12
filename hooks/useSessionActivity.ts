"use client";

import { useEffect, useState } from "react";
import type { AgentTaskSnapshot } from "@/lib/types";

const REFRESH_MS = 2_000;

/**
 * What the work sessions are doing right now, by session id: running and on which step,
 * dialogs waiting for the user, how the last run ended. Polled while `enabled` and the
 * window is visible; the main-session cards read it.
 */
export function useSessionActivity(enabled: boolean): ReadonlyMap<string, AgentTaskSnapshot> {
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, AgentTaskSnapshot>>(() => new Map());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastKey = "";
    const load = async () => {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch("/api/agent/tasks", { cache: "no-store" });
          if (response.ok) {
            const data = await response.json() as { tasks: AgentTaskSnapshot[] };
            // Same answer as last time: keep the map, so nothing re-renders on a quiet poll.
            const key = JSON.stringify(data.tasks);
            if (!cancelled && key !== lastKey) {
              lastKey = key;
              setSnapshots(new Map(data.tasks.map((task) => [task.sessionId, task])));
            }
          }
        } catch {
          // The next round tries again; the cards keep what they last knew.
        }
      }
      if (!cancelled) timer = setTimeout(() => void load(), REFRESH_MS);
    };
    void load();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  return snapshots;
}

async function command(sessionId: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
}

/** Answer a confirm dialog a session is blocked on (the write gate's approval). */
export function answerSessionDialog(sessionId: string, id: string, confirmed: boolean): Promise<void> {
  return command(sessionId, { type: "extension_ui_response", id, confirmed });
}

/** Stop a session's run, like the Stop button in its composer. */
export function stopSessionRun(sessionId: string): Promise<void> {
  return command(sessionId, { type: "abort" });
}
