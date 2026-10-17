"use client";

import { useEffect, useState } from "react";

import { isTauriDesktop } from "@/lib/desktop-updater";
import { getDesktopPlatform, type DesktopPlatform } from "@/lib/desktop-window";

export interface DesktopChrome {
  /** OS family when running inside the packaged app, otherwise null. */
  platform: DesktopPlatform;
  /** True only in the Tauri shell — always false in a browser. */
  isDesktop: boolean;
  /** macOS keeps its native traffic lights, so the top bar insets instead of drawing controls. */
  isMacOS: boolean;
  /** Spread onto the element that should drag the frameless window. */
  dragRegionProps: { "data-tauri-drag-region"?: true };
}

/**
 * Pure platform-to-chrome mapping, kept separate from the hook so the branch
 * conditions are testable without a React renderer.
 */
export function desktopChromeFor(platform: DesktopPlatform): DesktopChrome {
  return {
    platform,
    isDesktop: platform !== null,
    isMacOS: platform === "macos",
    dragRegionProps: platform ? { "data-tauri-drag-region": true } : {},
  };
}

/**
 * Window-chrome facts for a shell that has no native title bar.
 *
 * Resolves after mount rather than during render: the server and the first
 * client pass must agree, and `window.__TAURI_INTERNALS__` only exists in the
 * browser. In a plain web build every field stays inert.
 */
export function useDesktopChrome(): DesktopChrome {
  const [platform, setPlatform] = useState<DesktopPlatform>(null);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    setPlatform(getDesktopPlatform());
  }, []);

  return desktopChromeFor(platform);
}
