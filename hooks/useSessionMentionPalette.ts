"use client";

// Fork-owned: the composer's `#` session-mention palette (state, the session
// index fetch and completion). ChatInput (upstream-owned) keeps the keyboard
// branch and the call sites; the menu renders in components/SessionMentionMenu.tsx.

import React, { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  buildSessionMentionText, extractAtQuery, extractHashQuery, filterSessionEntries,
  type AtQueryMatch, type HashQueryMatch, type SessionMentionEntry,
} from "@/lib/file-fuzzy";
import type { SessionInfo } from "@/lib/types";

interface UseSessionMentionPaletteOptions {
  cwd?: string | null;
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  setAtQuery: Dispatch<SetStateAction<AtQueryMatch | null>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useSessionMentionPalette({ cwd, value, setValue, setAtQuery, textareaRef }: UseSessionMentionPaletteOptions) {
  const [hashQuery, setHashQuery] = useState<HashQueryMatch | null>(null);
  const [hashMenuOpen, setHashMenuOpen] = useState(false);
  const [hashActiveIndex, setHashActiveIndex] = useState(0);
  const [sessionIndex, setSessionIndex] = useState<{ entries: SessionMentionEntry[]; fetchedAt: number } | null>(null);
  const hashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const sessionIndexFetchingRef = useRef(false);
  // Visible mention name -> session id, resolved into the message on send.
  const sessionMentionTargetsRef = useRef(new Map<string, string>());

  const updateHashQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setHashQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setHashQuery(extractHashQuery(text.slice(0, pos)));
  }, [cwd]);

  const hashQueryText = hashQuery?.query ?? null;
  const hashMatches: SessionMentionEntry[] = React.useMemo(() => (
    hashQueryText !== null && sessionIndex
      ? filterSessionEntries(sessionIndex.entries, hashQueryText)
      : []
  ), [hashQueryText, sessionIndex]);

  const hashTokenKey = hashQuery === null ? null : `${hashQuery.start}:${hashQuery.quoted ? 1 : 0}:${hashQuery.query}`;
  useEffect(() => {
    if (hashTokenKey === null) {
      setHashMenuOpen(false);
      setHashActiveIndex(0);
      return;
    }
    setHashMenuOpen(true);
    setHashActiveIndex(0);
  }, [hashTokenKey]);

  // Sessions use the # palette. Keep this list lightweight by
  // using the existing session summary endpoint; full content is fetched only
  // when a selected session mention is sent.
  useEffect(() => {
    if (!hashQuery || !cwd) return;
    if (sessionIndex && Date.now() - sessionIndex.fetchedAt < 10_000) return;
    if (sessionIndexFetchingRef.current) return;
    sessionIndexFetchingRef.current = true;
    fetch("/api/sessions")
      .then((res) => {
        if (!res.ok) throw new Error(`session index failed: ${res.status}`);
        return res.json() as Promise<{ sessions?: SessionInfo[] }>;
      })
      .then((data) => {
        const entries = (data.sessions ?? []).map((session): SessionMentionEntry => ({
          kind: "session",
          id: session.id,
          name: session.name,
          firstMessage: session.firstMessage,
          modified: session.modified,
          messageCount: session.messageCount,
        }));
        setSessionIndex({ entries, fetchedAt: Date.now() });
      })
      .catch(() => {})
      .finally(() => {
        sessionIndexFetchingRef.current = false;
      });
  }, [hashQuery, cwd, sessionIndex]);

  const applyHashCompletion = useCallback((entry: SessionMentionEntry) => {
    if (!hashQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, hashQuery.start);
    let after = value.slice(cursor);
    if (hashQuery.quoted && after.startsWith('"')) after = after.slice(1);
    const sessionDisplayName = entry.name?.trim() || entry.firstMessage.trim() || "Untitled session";
    const visibleSessionName = sessionDisplayName.replace(/"/g, "'").replace(/\n/g, " ");
    sessionMentionTargetsRef.current.set(visibleSessionName, entry.id);
    const text = buildSessionMentionText(visibleSessionName);
    const newValue = before + text + after;
    const newPos = before.length + text.length;
    setValue(newValue);
    setHashQuery(extractHashQuery(newValue.slice(0, newPos)));
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  }, [hashQuery, setAtQuery, setValue, textareaRef, value]);

  useEffect(() => {
    hashItemRefs.current.length = hashMatches.length;
  }, [hashMatches.length]);

  useEffect(() => {
    if (!hashMenuOpen) return;
    hashItemRefs.current[hashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [hashActiveIndex, hashMenuOpen]);

  useEffect(() => {
    if (hashActiveIndex >= hashMatches.length) {
      setHashActiveIndex(Math.max(0, hashMatches.length - 1));
    }
  }, [hashMatches.length, hashActiveIndex]);

  return {
    hashQuery, setHashQuery, hashMenuOpen, setHashMenuOpen, hashActiveIndex, setHashActiveIndex,
    hashMatches, hashItemRefs, sessionIndex, sessionMentionTargetsRef, updateHashQuery, applyHashCompletion,
  };
}
