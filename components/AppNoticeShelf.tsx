"use client";

import { useI18n } from "@/hooks/useI18n";
import {
  dismissAppNotice,
  runAppNoticeAction,
  useAppNotices,
} from "@/lib/notification-store";

export function AppNoticeShelf() {
  const notices = useAppNotices();
  const { t } = useI18n();
  if (notices.length === 0) return null;

  return (
    <div
      className="app-notice-shelf"
      role="status"
      aria-live="polite"
      aria-label={t("notifications.label")}
    >
      {notices.map((notice, index) => (
        <div
          key={notice.id}
          className={`notice-shelf-item app-notice-item is-${notice.type}${notice.exiting ? " is-exiting" : ""}`}
        >
          <span className="notice-shelf-indicator" aria-hidden="true" />
          <span className="app-notice-message">{notice.message}</span>
          {notice.action && (
            <button
              type="button"
              className="app-notice-action"
              onClick={() => void runAppNoticeAction(notice.id)}
            >
              {notice.action.label}
            </button>
          )}
          <button
            type="button"
            className="app-notice-dismiss"
            onClick={() => dismissAppNotice(notice.id)}
            aria-label={t("notifications.dismiss")}
            title={t("notifications.dismiss")}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <span className="app-notice-count" aria-hidden="true">{index + 1}</span>
        </div>
      ))}
    </div>
  );
}
