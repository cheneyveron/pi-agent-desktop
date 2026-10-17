"use client";

// Fork-owned: how a failed compaction is reported above the composer — a no-op
// ("Nothing to compact") becomes a short notice instead of an error, and both
// banners dismiss themselves. Kept out of hooks/useAgentSession.ts
// (upstream-owned) so upstream merges stay clean.

import { useCallback, useEffect, useState } from "react";

// pi refuses a manual compact by throwing when there is nothing to fold
// (`AgentSession.compact()`); that is an answer about the session, not a failure.
// The RPC reply carries the bare message, `compaction_end` prefixes it with
// "Compaction failed: " — returns the bare message for a no-op, else null.
export function compactNoopMessage(message: string): string | null {
  const bare = message.replace(/^Compaction failed:\s*/, "");
  return /^(Nothing to compact|Already compacted)\b/.test(bare) ? bare : null;
}

interface UseCompactNoticeOptions {
  compactError: string | null;
  setCompactError: (error: string | null) => void;
  setCompactResult: (result: null) => void;
}

export function useCompactNotice({ compactError, setCompactError, setCompactResult }: UseCompactNoticeOptions) {
  const [compactNotice, setCompactNotice] = useState<string | null>(null);
  const reportCompactFailure = useCallback((message: string) => {
    const notice = compactNoopMessage(message);
    if (notice) setCompactNotice(notice);
    else setCompactError(message);
    setCompactResult(null);
  }, [setCompactError, setCompactResult]);

  // A failed compaction is a one-off answer to the last attempt, not a standing
  // state: without this the banner stayed above the composer until the next compact.
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 8000);
    return () => clearTimeout(t);
  }, [compactError, setCompactError]);

  useEffect(() => {
    if (!compactNotice) return;
    const t = setTimeout(() => setCompactNotice(null), 6000);
    return () => clearTimeout(t);
  }, [compactNotice]);

  return { compactNotice, setCompactNotice, reportCompactFailure };
}
