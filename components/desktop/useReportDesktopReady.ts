"use client";

import { useEffect } from "react";

import { reportDesktopReadyNative } from "@/lib/desktop-native";

/**
 * Reports that the screen the user is looking at has its content, so the
 * desktop shell can show its window. Inert in a browser and after the first
 * report; pass `ready` once the content (not a spinner) is on screen.
 */
export function useReportDesktopReady(ready: boolean, source: string): void {
  useEffect(() => {
    if (ready) void reportDesktopReadyNative(source);
  }, [ready, source]);
}
