"use client";

import { useCallback, type MouseEvent } from "react";

import { startDraggingWindow, toggleMaximizeWindow } from "@/lib/desktop-window";

import { useDesktopChrome } from "./useDesktopChrome";

const NO_DRAG_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="tab"], [contenteditable="true"], [data-no-drag]';

/** Element with just enough DOM API to test the drag decision without a browser. */
interface ClosestTarget {
  closest(selector: string): unknown;
}

/**
 * True when `target` sits inside a `data-tauri-drag-region` container and
 * isn't itself an interactive descendant (or one Tauri's own direct-target
 * check would already have excluded).
 */
export function shouldStartDrag(target: ClosestTarget): boolean {
  return Boolean(target.closest("[data-tauri-drag-region]")) && !target.closest(NO_DRAG_SELECTOR);
}

/**
 * Windows/Linux workaround for a Tauri limitation: its native drag-region
 * listener only checks `event.target` itself, not ancestors, so a click on
 * anything nested inside a `data-tauri-drag-region` container (icons, text,
 * wrapper divs) silently fails to start dragging the window. This re-derives
 * the drag region with `closest()` so it also fires from a nested child, and
 * excludes interactive descendants the same way Tauri's own check would if
 * the click landed on them directly.
 *
 * macOS keeps Tauri's native handling untouched — spread the returned props
 * unconditionally; they're empty there.
 */
export function useWindowDrag(): { onMouseDown?: (event: MouseEvent<HTMLElement>) => void } {
  const { isDesktop, isMacOS } = useDesktopChrome();
  const active = isDesktop && !isMacOS;

  const onMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (!shouldStartDrag(event.target as HTMLElement)) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.detail === 2) {
      void toggleMaximizeWindow();
    } else {
      void startDraggingWindow();
    }
  }, []);

  return active ? { onMouseDown } : {};
}
