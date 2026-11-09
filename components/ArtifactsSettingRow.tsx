"use client";

import { useI18n } from "@/hooks/useI18n";
import { ServerSwitchSettingRow } from "./ServerSwitchSettingRow";

/**
 * Settings › General › Chat: whether sessions tell the model it can answer
 * with artifacts. Rendering `:::artifact` blocks does not depend on it.
 */
export function ArtifactsSettingRow() {
  const { t } = useI18n();
  return (
    <ServerSwitchSettingRow
      endpoint="/api/artifacts/settings"
      label={t("settings.artifacts")}
      hint={t("settings.artifactsHint")}
      failedHint={t("settings.artifactsFailed")}
      defaultEnabled
    />
  );
}

/**
 * Settings › General › Chat: name a new session automatically (#201). The
 * server does it from the first message; see `lib/session-auto-name.ts`.
 * On by default in this fork (`isAutoTitleEnabled()`).
 */
export function AutoTitleSettingRow() {
  const { t } = useI18n();
  return (
    <ServerSwitchSettingRow
      endpoint="/api/session-title/settings"
      label={t("settings.autoTitle")}
      hint={t("settings.autoTitleHint")}
      failedHint={t("settings.autoTitleFailed")}
      defaultEnabled={true}
    />
  );
}
