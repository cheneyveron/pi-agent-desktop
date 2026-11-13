"use client";

import { useEffect, useId } from "react";
import { useI18n } from "@/hooks/useI18n";
import { refreshMainSessionHealth, useMainSession } from "@/hooks/useMainSession";
import { saveMainSessionSettings, useMainSessionSettings } from "@/hooks/useMainSessionSettings";
import { MAIN_SESSION_TAKEOVER_MINUTES } from "@/lib/main-session-settings-core";
import { AppSelect } from "../AppSelect";
import { ConfigSwitch } from "../SettingsUi";
import { MainSessionModelPicker, MainSessionThinkingPicker } from "./MainSessionModelPicker";

/**
 * Settings › Main session: the whole feature (off by default), automatic continue (off by
 * default), how long a stopped session waits before the main session takes it over, and the
 * model of its turns. The first three live in Pi Web's settings file, so they save while the
 * service is down; the model is the service's own choice.
 */
export function MainSessionSettings() {
  const { t } = useI18n();
  const { settings, loaded, saving, error } = useMainSessionSettings();
  const enabledHintId = useId();
  const continueHintId = useId();
  const takeoverHintId = useId();
  const busy = !loaded || saving;
  const takeoverOptions = MAIN_SESSION_TAKEOVER_MINUTES.map((minutes) => ({
    value: String(minutes),
    label: t("settings.mainSessionTakeoverMinutes", { count: minutes }),
  }));
  // A hand-edited value outside the list still shows as itself.
  if (!MAIN_SESSION_TAKEOVER_MINUTES.some((minutes) => minutes === settings.takeoverMinutes)) {
    takeoverOptions.push({ value: String(settings.takeoverMinutes), label: t("settings.mainSessionTakeoverMinutes", { count: settings.takeoverMinutes }) });
  }

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("settings.mainSession")}</h2>
      <div className="settings-general-columns">
        <div className="settings-general-col">
          <section className="settings-general-section">
            <div className="settings-chat-options">
              <div className="settings-chat-option settings-chat-switch-option artifacts-setting-row">
                <span className="artifacts-setting-text">
                  <span>{t("settings.mainSessionEnabled")}</span>
                  <span id={enabledHintId} className="artifacts-setting-hint" role={error ? "alert" : undefined}>
                    {error ? t("settings.mainSessionSaveFailed", { error }) : t("settings.mainSessionEnabledHint")}
                  </span>
                </span>
                <ConfigSwitch
                  checked={settings.enabled}
                  loading={busy}
                  label={t("settings.mainSessionEnabled")}
                  describedBy={enabledHintId}
                  onChange={(enabled) => void saveMainSessionSettings({ enabled })}
                />
              </div>
              <div className="settings-chat-option settings-chat-switch-option artifacts-setting-row">
                <span className="artifacts-setting-text">
                  <span>{t("settings.mainSessionAutoContinue")}</span>
                  <span id={continueHintId} className="artifacts-setting-hint">
                    {settings.enabled ? t("settings.mainSessionAutoContinueHint") : t("settings.mainSessionNeedsEnabled")}
                  </span>
                </span>
                <ConfigSwitch
                  checked={settings.enabled && settings.autoContinue}
                  disabled={!settings.enabled}
                  loading={busy}
                  label={t("settings.mainSessionAutoContinue")}
                  describedBy={continueHintId}
                  onChange={(autoContinue) => void saveMainSessionSettings({ autoContinue })}
                />
              </div>
              <div className="settings-chat-option settings-chats-field">
                <label htmlFor="settings-main-session-takeover">{t("settings.mainSessionTakeover")}</label>
                <AppSelect
                  id="settings-main-session-takeover"
                  aria-label={t("settings.mainSessionTakeover")}
                  className="settings-chats-control"
                  value={String(settings.takeoverMinutes)}
                  options={takeoverOptions}
                  disabled={busy || !settings.enabled}
                  aria-describedby={takeoverHintId}
                  onValueChange={(value) => void saveMainSessionSettings({ takeoverMinutes: Number(value) })}
                />
                <span id={takeoverHintId} className="settings-chats-hint">
                  {settings.enabled ? t("settings.mainSessionTakeoverHint") : t("settings.mainSessionNeedsEnabled")}
                </span>
              </div>
            </div>
          </section>
        </div>
        <div className="settings-general-col">
          {settings.enabled && <MainSessionModelSection />}
        </div>
      </div>
    </div>
  );
}

/** The same model picker the 主会话 page shows. Without a model the service runs no model turns. */
function MainSessionModelSection() {
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
      <h3 className="settings-general-heading">{t("settings.mainSessionModel")}</h3>
      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chats-field">
          <label htmlFor="settings-main-session-model">{t("mainSession.model.label")}</label>
          <MainSessionModelPicker id="settings-main-session-model" className="settings-chats-control" />
          <MainSessionThinkingPicker id="settings-main-session-thinking" className="settings-chats-control" />
          <span className="settings-chats-hint" role={state.modelError ? "alert" : undefined}>
            {state.modelError ? t("mainSession.model.saveFailed", { error: state.modelError }) : hint}
          </span>
        </div>
      </div>
    </section>
  );
}
