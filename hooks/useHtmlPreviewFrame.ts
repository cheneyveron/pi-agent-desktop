"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { isTauriDesktop, openExternal } from "@/lib/desktop-native";
import {
  HTML_PREVIEW_ERROR_MESSAGE,
  HTML_PREVIEW_OPEN_MESSAGE,
  HTML_PREVIEW_SIZE_MESSAGE,
  type HtmlPreviewMessages,
  type HtmlPreviewOptions,
} from "@/lib/html-preview";

type ThemeColors = NonNullable<HtmlPreviewOptions["theme"]>;

function readThemeColors(dark: boolean): ThemeColors | undefined {
  if (typeof document === "undefined" || !document.body) return undefined;
  const style = getComputedStyle(document.body);
  return { scheme: dark ? "dark" : "light", background: style.backgroundColor, text: style.color };
}

/**
 * Build options for preview documents: the app's colours (applied only to
 * pages that set none) and, in the desktop app, link routing to the system
 * browser. Colours are read after the theme class lands, hence the effect.
 */
export function useHtmlPreviewOptions(): HtmlPreviewOptions {
  const { isDark } = useTheme();
  const [theme, setTheme] = useState<ThemeColors | undefined>(() => readThemeColors(isDark));
  useEffect(() => {
    const next = readThemeColors(isDark);
    setTheme((current) => (
      current && next && current.scheme === next.scheme && current.background === next.background && current.text === next.text
        ? current
        : next
    ));
  }, [isDark]);
  const routeLinksToParent = typeof window !== "undefined" && isTauriDesktop();
  const { t } = useI18n();
  const loadingLabel = t("preview.loadingComponent");
  // The frame fills these placeholders itself, so each is passed through as
  // its own literal token.
  const token = (name: string) => `{${name}}`;
  const scriptErrorHidden = t("preview.msg.scriptErrorHidden");
  const failedToLoad = t("preview.msg.failedToLoad", { resource: token("resource") });
  const unhandledRejection = t("preview.msg.unhandledRejection", { reason: token("reason") });
  const runtimeMissing = t("preview.msg.runtimeMissing");
  const compileFailed = t("preview.msg.compileFailed", { error: token("error") });
  const noDefaultExport = t("preview.msg.noDefaultExport");
  const packagesNeedNetwork = t("preview.msg.packagesNeedNetwork", { packages: token("packages"), error: token("error") });
  const messages = useMemo<HtmlPreviewMessages>(
    () => ({ scriptErrorHidden, failedToLoad, unhandledRejection, runtimeMissing, compileFailed, noDefaultExport, packagesNeedNetwork }),
    [scriptErrorHidden, failedToLoad, unhandledRejection, runtimeMissing, compileFailed, noDefaultExport, packagesNeedNetwork],
  );
  return useMemo(
    () => ({ theme, routeLinksToParent, loadingLabel, messages }),
    [theme, routeLinksToParent, loadingLabel, messages],
  );
}

interface FrameMessageHandlers {
  onSize?: (height: number) => void;
  onError?: (message: string) => void;
}

/**
 * Listens to one preview frame. Messages are matched by `event.source`, so a
 * page cannot speak for another frame; a link is opened only when it is an
 * http(s) URL, whatever the page sent.
 */
export function useHtmlPreviewFrameMessages(
  frameRef: RefObject<HTMLIFrameElement | null>,
  handlers: FrameMessageHandlers,
  active = true,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const lastOpenRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown; message?: unknown; url?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === HTML_PREVIEW_SIZE_MESSAGE && typeof data.height === "number") {
        handlersRef.current.onSize?.(data.height);
      } else if (data.type === HTML_PREVIEW_ERROR_MESSAGE && typeof data.message === "string") {
        handlersRef.current.onError?.(data.message.slice(0, 500));
      } else if (data.type === HTML_PREVIEW_OPEN_MESSAGE && typeof data.url === "string") {
        let url: URL;
        try {
          url = new URL(data.url);
        } catch {
          return;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        // Only for a click the user made in this frame (it then holds focus),
        // at most once a second: a page must not open browser windows by itself.
        if (document.activeElement !== frame) return;
        const now = Date.now();
        if (now - lastOpenRef.current < 1000) return;
        lastOpenRef.current = now;
        void openExternal(url.href).catch((error) => console.error("Failed to open link:", error));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef, active]);
}

/** Errors a frame reported, cleared whenever the document it shows changes. */
export function useHtmlPreviewErrors(documentKey: string): {
  errors: string[];
  addError: (message: string) => void;
  dismiss: () => void;
} {
  const [state, setState] = useState<{ key: string; errors: string[]; dismissed: boolean }>({ key: documentKey, errors: [], dismissed: false });
  const current = state.key === documentKey ? state : { key: documentKey, errors: [], dismissed: false };
  return {
    errors: current.dismissed ? [] : current.errors,
    addError: (message) => setState((previous) => {
      const base = previous.key === documentKey ? previous : { key: documentKey, errors: [], dismissed: false };
      return base.errors.includes(message) ? base : { ...base, errors: [...base.errors, message] };
    }),
    dismiss: () => setState({ key: documentKey, errors: current.errors, dismissed: true }),
  };
}
