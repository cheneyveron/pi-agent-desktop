"use client";

import { useI18n } from "@/hooks/useI18n";

/** Formats reported errors for a fix request: one per line, fenced so markup in them stays literal. */
export function formatPreviewErrors(errors: readonly string[]): string {
  const body = errors.join("\n");
  const longestRun = Math.max(0, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${body}\n${fence}`;
}

/**
 * Shown under a preview whose page threw or failed to load a resource. "Ask
 * to fix" is offered only where a message can go to the conversation the
 * preview belongs to.
 */
export function HtmlPreviewErrorBar({
  errors,
  onFix,
  onDismiss,
}: {
  errors: readonly string[];
  onFix?: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  if (!errors.length) return null;
  const more = errors.length - 1;
  return (
    <div className="html-preview-error-bar" role="alert">
      <svg className="html-preview-error-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
      <span className="html-preview-error-text">
        <span className="html-preview-error-title">{t("preview.errorTitle")}</span>
        <span className="html-preview-error-detail" title={errors.join("\n")}>
          {errors[0]}
          {more > 0 && <span className="html-preview-error-more">{t("preview.moreErrors", { count: more })}</span>}
        </span>
      </span>
      {onFix && (
        <button type="button" className="html-preview-error-fix" onClick={onFix}>
          {t("preview.fix")}
        </button>
      )}
      <button
        type="button"
        className="html-preview-error-dismiss"
        onClick={onDismiss}
        title={t("preview.dismissError")}
        aria-label={t("preview.dismissError")}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
