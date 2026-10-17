"use client";

// Fork-owned: pi 0.86's session automation switches (auto-compaction, auto-retry,
// steering / follow-up delivery) and the retry-backoff cancel. Kept out of
// hooks/useAgentSession.ts (upstream-owned) so upstream merges stay clean.

import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { sendAgentCommand } from "@/lib/agent-client";

export interface SessionAutomation {
  autoCompactionEnabled: boolean | null;
  autoRetryEnabled: boolean | null;
  steeringMode: string | null;
  followUpMode: string | null;
}

/** The `get_state` fields this hook mirrors. */
export interface SessionAutomationState {
  autoCompactionEnabled?: boolean;
  autoRetryEnabled?: boolean;
  steeringMode?: string;
  followUpMode?: string;
}

export type SessionAutomationChange = {
  autoCompaction?: boolean;
  autoRetry?: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
};

/** Automation flags mirrored from get_state; null while unknown (new session). */
export function useSessionAutomation() {
  const [automation, setAutomation] = useState<SessionAutomation>({
    autoCompactionEnabled: null,
    autoRetryEnabled: null,
    steeringMode: null,
    followUpMode: null,
  });

  /** Called from every get_state path (syncLiveModel); absent fields keep their value. */
  const syncAutomation = useCallback((state?: SessionAutomationState) => {
    setAutomation((prev) => ({
      autoCompactionEnabled: state?.autoCompactionEnabled ?? prev.autoCompactionEnabled,
      autoRetryEnabled: state?.autoRetryEnabled ?? prev.autoRetryEnabled,
      steeringMode: state?.steeringMode ?? prev.steeringMode,
      followUpMode: state?.followUpMode ?? prev.followUpMode,
    }));
  }, []);

  return { automation, setAutomation, syncAutomation };
}

interface SessionAutomationActionsOptions<State> {
  sessionIdRef: MutableRefObject<string | null>;
  setAutomation: Dispatch<SetStateAction<SessionAutomation>>;
  addNotice: (notice: { message: string; type?: "error" }) => void;
  /** Applies a fresh get_state after a failed write (the hook's syncLiveModel). */
  resync: (state: State | undefined) => void;
}

export function useSessionAutomationActions<State>({
  sessionIdRef, setAutomation, addNotice, resync,
}: SessionAutomationActionsOptions<State>) {
  /** Cancel an auto-retry backoff (0.86) without stopping the whole session. */
  const handleAbortRetry = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_retry" });
    } catch (e) {
      console.error("Failed to abort retry:", e);
    }
  }, [sessionIdRef]);

  /** Toggle auto-compaction / auto-retry / queue delivery modes on the live session. */
  const handleSetAutomation = useCallback(async (change: SessionAutomationChange) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    // Optimistic: revert if the command fails.
    setAutomation((prev) => ({
      autoCompactionEnabled: change.autoCompaction ?? prev.autoCompactionEnabled,
      autoRetryEnabled: change.autoRetry ?? prev.autoRetryEnabled,
      steeringMode: change.steeringMode ?? prev.steeringMode,
      followUpMode: change.followUpMode ?? prev.followUpMode,
    }));
    try {
      if (change.autoCompaction !== undefined) {
        await sendAgentCommand(sid, { type: "set_auto_compaction", enabled: change.autoCompaction });
      }
      if (change.autoRetry !== undefined) {
        await sendAgentCommand(sid, { type: "set_auto_retry", enabled: change.autoRetry });
      }
      if (change.steeringMode !== undefined) {
        await sendAgentCommand(sid, { type: "set_steering_mode", mode: change.steeringMode });
      }
      if (change.followUpMode !== undefined) {
        await sendAgentCommand(sid, { type: "set_follow_up_mode", mode: change.followUpMode });
      }
    } catch (e) {
      console.error("Failed to apply automation setting:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      // Re-sync from the server's actual state.
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        const d = await res.json() as { state?: State };
        resync(d.state);
      } catch { /* leave optimistic value; next reconcile fixes it */ }
    }
  }, [addNotice, resync, sessionIdRef, setAutomation]);

  return { handleAbortRetry, handleSetAutomation };
}
