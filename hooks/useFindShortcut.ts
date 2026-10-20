"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { ensureFindZoneTracking, resolveFindZone, type FindZone } from "@/lib/find-zone";

/**
 * Ctrl/Cmd+F for one searchable surface. Several surfaces can be mounted at once;
 * each reacts only when `resolveFindZone()` (mouse position, then focus) names it.
 * `enabled` false leaves the shortcut to the platform.
 */
export function useFindShortcut(zone: FindZone, rootRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const [open, setOpen] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [seed, setSeed] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    ensureFindZoneTracking();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[role='dialog'], [aria-modal='true']")) return;
      if (resolveFindZone() !== zone) return;

      event.preventDefault();
      const root = rootRef.current;
      const selection = root ? window.getSelection() : null;
      const text = selection && !selection.isCollapsed && root?.contains(selection.anchorNode)
        ? selection.toString()
        : "";
      setSeed(text && text.length <= 200 && !text.includes("\n") ? text : null);
      setOpen(true);
      setFocusToken((token) => token + 1);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, zone, rootRef]);

  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  const close = useCallback(() => {
    setOpen(false);
    rootRef.current?.focus({ preventScroll: true });
  }, [rootRef]);

  return { open: open && enabled, focusToken, seed, close };
}
