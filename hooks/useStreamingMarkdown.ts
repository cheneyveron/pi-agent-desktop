"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { streamingMarkdownInterval } from "@/lib/streaming-markdown";

const motionQuery = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (notify: () => void) => {
  const query = window.matchMedia(motionQuery);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const getReducedMotion = () => window.matchMedia(motionQuery).matches;
// SSR and hydration show the authoritative text without an animation backlog.
const getServerReducedMotion = () => true;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, getReducedMotion, getServerReducedMotion);
}

/** Coalesce preprocessing; completion, cancellation and replacement flush now. */
export function useStreamingMarkdownText(value: string, active: boolean): string {
  const [snapshot, setSnapshot] = useState({ text: value, active });
  const lastShownAt = useRef(0);
  const reset = snapshot.active !== active || !value.startsWith(snapshot.text);
  if (reset) setSnapshot({ text: value, active });

  useEffect(() => {
    if (!active) return;
    const publish = () => {
      lastShownAt.current = Date.now();
      setSnapshot({ text: value, active });
    };
    const wait = reset ? 0 : lastShownAt.current + streamingMarkdownInterval(value) - Date.now();
    if (wait <= 0) {
      publish();
      return;
    }
    const timer = setTimeout(publish, wait);
    return () => clearTimeout(timer);
  }, [value, active, reset]);

  return !active || reset ? value : snapshot.text;
}
