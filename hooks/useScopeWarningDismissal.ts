"use client";

// Fork-owned: the composer's `enabledModels` scope-warning banner can be dismissed.
// Kept out of hooks/useAgentSession.ts (upstream-owned) so upstream merges stay clean.

import { useCallback, useMemo, useState } from "react";
import { modelScopeWarningKey, type ModelScopeWarning } from "@/lib/model-scope-warnings";

export function useScopeWarningDismissal(modelScopeWarnings: ModelScopeWarning[]) {
  // Dismissed scope warnings are keyed per warning and reset on session switch:
  // dismissal lives for the current conversation only, never persisted.
  const [dismissedScopeWarningKeys, setDismissedScopeWarningKeys] = useState<ReadonlySet<string>>(() => new Set());
  const dismissModelScopeWarnings = useCallback(() => {
    setDismissedScopeWarningKeys((prev) => {
      const next = new Set(prev);
      for (const warning of modelScopeWarnings) next.add(modelScopeWarningKey(warning));
      return next;
    });
  }, [modelScopeWarnings]);
  const visibleModelScopeWarnings = useMemo(
    () => modelScopeWarnings.filter((warning) => !dismissedScopeWarningKeys.has(modelScopeWarningKey(warning))),
    [modelScopeWarnings, dismissedScopeWarningKeys],
  );
  return { visibleModelScopeWarnings, dismissModelScopeWarnings };
}
