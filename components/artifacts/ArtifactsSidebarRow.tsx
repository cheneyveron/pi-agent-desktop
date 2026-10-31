"use client";

import { useI18n } from "@/hooks/useI18n";

interface Props {
  active: boolean;
  onOpen: () => void;
}

/** The Artifacts entry under New Session: opens the cross-session artifact page. */
export function ArtifactsSidebarRow({ active, onOpen }: Props) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`sidebar-header-row sidebar-scheduled-row sidebar-artifacts-row${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      title={t("sidebar.artifacts")}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
      <span className="sidebar-scheduled-label">{t("sidebar.artifacts")}</span>
    </button>
  );
}
