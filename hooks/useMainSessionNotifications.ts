"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { onMainSessionDigest, retainMainSessionStream } from "@/hooks/useMainSession";
import { notifyDesktop } from "@/lib/desktop-notify";
import { MAIN_SESSION_NOTIFICATION_ID } from "@/lib/main-session-client";

/**
 * One desktop notification per daily digest the main session streams; clicking
 * it opens the main-session page (the shell reports the click with the
 * `main-session` sentinel id, see AppShell's notification handler).
 */
export function useMainSessionNotifications(enabled: boolean): void {
  const { t } = useI18n();
  const translate = useRef(t);
  translate.current = t;

  useEffect(() => {
    // Off in Settings › Main session: no stream to the service, so no digest to notify about.
    if (!enabled) return;
    const release = retainMainSessionStream();
    const notified = new Set<string>();
    const stop = onMainSessionDigest((digest) => {
      if (notified.has(digest.date)) return;
      notified.add(digest.date);
      const need = digest.lines.filter((line) => line.kind === "need").length;
      void notifyDesktop({
        title: translate.current("mainSession.notify.digestTitle", { date: digest.date, count: digest.lines.length }),
        body: translate.current("mainSession.notify.digestBody", { count: need }),
        sessionId: MAIN_SESSION_NOTIFICATION_ID,
      });
    });
    return () => {
      stop();
      release();
    };
  }, [enabled]);
}
