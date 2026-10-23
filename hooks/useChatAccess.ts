"use client";

import { useCallback, useEffect, useState } from "react";
import { revealItemInDirNative } from "@/lib/desktop-native";
import { isTauriDesktop } from "@/lib/desktop-updater";

export interface ChatAccessState {
  chat: boolean;
  /** The chat's own folder (null for a legacy chat). */
  folder: string | null;
  unlocked: boolean;
  /** The chat has a folder and the server is local, so it can be unlocked. */
  available: boolean;
}

export interface ChatAccessControls {
  state: ChatAccessState;
  busy: boolean;
  error: string | null;
  reveal: () => Promise<void>;
  setUnlocked: (unlocked: boolean) => Promise<boolean>;
  clearError: () => void;
}

/**
 * The chat's folder and whether it may use the computer, read from the server (which owns
 * both). `enabled` is false for a project session and for a chat that does not exist yet.
 * `onRebuilt` runs after a change, when the server has restarted the session.
 */
export function useChatAccess(
  sessionId: string | null | undefined,
  enabled: boolean,
  onRebuilt?: () => void | Promise<void>,
): ChatAccessControls | null {
  const [state, setState] = useState<ChatAccessState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(null);
    setError(null);
    if (!enabled || !sessionId) return;
    let active = true;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat-access`, { cache: "no-store" })
      .then(async (res) => (res.ok ? await res.json() as ChatAccessState : null))
      .then((next) => { if (active && next?.chat) setState(next); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [enabled, sessionId]);

  const reveal = useCallback(async () => {
    if (!state?.folder || !sessionId) return;
    setError(null);
    try {
      if (isTauriDesktop()) {
        await revealItemInDirNative(state.folder);
        return;
      }
      const res = await fetch("/api/chat-folder/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, state?.folder]);

  const setUnlocked = useCallback(async (unlocked: boolean): Promise<boolean> => {
    if (!sessionId) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unlocked }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setState((current) => (current ? { ...current, unlocked } : current));
      await onRebuilt?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [onRebuilt, sessionId]);

  const clearError = useCallback(() => setError(null), []);

  return state ? { state, busy, error, reveal, setUnlocked, clearError } : null;
}
