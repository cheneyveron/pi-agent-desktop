"use client";

import { useEffect } from "react";
import { useI18n } from "@/hooks/useI18n";
import { refreshMainSessionHealth, useMainSession } from "@/hooks/useMainSession";
import { MainSessionModelPicker } from "./MainSessionModelPicker";

/**
 * Settings › General › Main session: the same model picker the 主会话 page shows, beside the
 * other "which model" choices. Without a model the service runs no model turns.
 */
export function MainSessionSettingsSection() {
  const { t } = useI18n();
  const state = useMainSession();
  // The page may have loaded long ago; the last turn's error and the choice can have moved.
  useEffect(() => { void refreshMainSessionHealth(); }, []);
  const service = state.service;
  const hint = state.status === "offline"
    ? t("mainSession.model.offline")
    : state.status !== "ready" ? t("i18n.loading")
      : !service?.model ? t("mainSession.model.outdated")
        : !service.judgeEnabled ? t("mainSession.model.judgeOff")
          : service.model.source === "env" ? t("mainSession.model.env")
            : !service.model.ref ? t("mainSession.model.needs")
              : service.lastError ? t("mainSession.model.failed", { error: service.lastError })
                : t("settings.mainSessionHint");

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.mainSession")}</h3>
      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chats-field">
          <label htmlFor="settings-main-session-model">{t("settings.mainSessionModel")}</label>
          <MainSessionModelPicker id="settings-main-session-model" className="settings-chats-control" />
          <span className="settings-chats-hint" role={state.modelError ? "alert" : undefined}>
            {state.modelError ? t("mainSession.model.saveFailed", { error: state.modelError }) : hint}
          </span>
        </div>
      </div>
    </section>
  );
}
