"use client";

import { useEffect, useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigSwitch } from "./SettingsUi";

/**
 * Settings › General › Chat: whether sessions tell the model it can answer
 * with artifacts. Rendering `:::artifact` blocks does not depend on it.
 */
export function ArtifactsSettingRow() {
  const { t } = useI18n();
  const hintId = useId();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/artifacts/settings")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { enabled?: unknown }) => {
        if (!cancelled) setEnabled(data.enabled !== false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    setFailed(false);
    fetch("/api/artifacts/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { enabled?: unknown }) => setEnabled(data.enabled !== false))
      .catch(() => {
        setEnabled(previous);
        setFailed(true);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-chat-option settings-chat-switch-option artifacts-setting-row">
      <span className="artifacts-setting-text">
        <span>{t("settings.artifacts")}</span>
        <span id={hintId} className="artifacts-setting-hint">
          {failed ? t("settings.artifactsFailed") : t("settings.artifactsHint")}
        </span>
      </span>
      <ConfigSwitch
        checked={enabled ?? true}
        loading={enabled === null || saving}
        label={t("settings.artifacts")}
        describedBy={hintId}
        onChange={update}
      />
    </div>
  );
}
