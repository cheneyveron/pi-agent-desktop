"use client";

// Fork-owned: SDK events the fork handles that upstream's `handleAgentEvent` switch
// does not. useAgentSession (upstream-owned) delegates its `default:` branch here,
// so upstream edits to the switch merge without touching these cases. The wire
// forwards every event, so a new one is ignored unless a case exists somewhere.

import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

// Live `!command` output is buffered client-side for the pending bubble; keep
// only the tail so a chatty command cannot grow the state unbounded.
export const PENDING_BASH_OUTPUT_CAP = 16_000;

export interface PendingBash {
  command: string;
  excludeFromContext: boolean;
  output: string;
}

export interface SummarizationRetry {
  attempt: number;
  maxAttempts: number;
}

interface UseForkAgentEventsOptions {
  sessionIdRef: MutableRefObject<string | null>;
  agentRunningRef: MutableRefObject<boolean>;
  bashRunningRef: MutableRefObject<boolean>;
  setPendingBash: Dispatch<SetStateAction<PendingBash | null>>;
  setSummarizationRetry: Dispatch<SetStateAction<SummarizationRetry | null>>;
  loadSession: (sid: string) => unknown;
  onSessionForked?: (newSessionId: string) => void;
}

export function useForkAgentEvents({
  sessionIdRef, agentRunningRef, bashRunningRef, setPendingBash, setSummarizationRetry, loadSession, onSessionForked,
}: UseForkAgentEventsOptions) {
  const externalAppendRefreshAtRef = useRef(0);

  const handleForkAgentEvent = useCallback((event: { type: string; [key: string]: unknown }) => {
    switch (event.type) {
      case "summarization_retry_scheduled":
        setSummarizationRetry({
          attempt: event.attempt as number,
          maxAttempts: event.maxAttempts as number,
        });
        break;
      case "summarization_retry_attempt_start":
        // The scheduled counter already shows; the attempt itself is covered
        // by the compact indicator staying in its post-start visual state.
        break;
      case "summarization_retry_finished":
        setSummarizationRetry(null);
        break;
      case "bash_execution_update": {
        if (!bashRunningRef.current) break;
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (!delta) break;
        setPendingBash((prev) => prev
          ? { ...prev, output: (prev.output + delta).slice(-PENDING_BASH_OUTPUT_CAP) }
          : prev);
        break;
      }
      case "session_info_changed":
        // Renames from other windows/extensions arrive here; the server bumps
        // sessionListVersion on this event, so the sidebar refreshes itself.
        break;
      case "entry_appended": {
        // Entries appended outside a run (extension custom entries, cache
        // warming) — refresh the transcript, throttled, when idle.
        const sid = sessionIdRef.current;
        if (!sid || agentRunningRef.current || bashRunningRef.current) break;
        const now = Date.now();
        if (now - externalAppendRefreshAtRef.current < 2000) break;
        externalAppendRefreshAtRef.current = now;
        loadSession(sid);
        break;
      }
      case "session_replaced":
        // An extension command called ctx.newSession / fork / switchSession: the
        // server already created (or resolved) the target, so follow it like a fork.
        if (typeof event.sessionId === "string" && event.sessionId !== sessionIdRef.current) {
          onSessionForked?.(event.sessionId);
        }
        break;
    }
  }, [agentRunningRef, bashRunningRef, loadSession, onSessionForked, sessionIdRef, setPendingBash, setSummarizationRetry]);

  return { handleForkAgentEvent };
}
