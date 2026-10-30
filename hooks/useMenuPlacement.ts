"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import { placeMenuWithinViewport, type MenuAnchor } from "@/lib/menu-placement";

/**
 * Positions a fixed-position menu next to its anchor using the menu's real
 * measured size, so a menu near the bottom of the window flips upward instead
 * of running off the screen. The measurement runs in a layout effect, so the
 * corrected position is applied before the browser paints.
 */
export function useMenuPlacement(
  anchor: MenuAnchor | null,
  menuRef: RefObject<HTMLElement | null>,
): { top: number; left: number } | null {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !anchor) {
      setPosition(null);
      return;
    }
    const place = () => {
      const rect = element.getBoundingClientRect();
      const next = placeMenuWithinViewport(
        anchor,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPosition((current) =>
        current && current.top === next.top && current.left === next.left ? current : next,
      );
    };
    place();
    // The menu's height changes when it switches page (actions -> branches).
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor, menuRef]);

  return position;
}
