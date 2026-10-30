"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TerminalSettingsResponse } from "@/lib/api-types";
import { AppSelect } from "./AppSelect";
import { ConfigButton } from "./SettingsUi";

export function TerminalSettingsSection() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<TerminalSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch("/api/terminal/settings", { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Load failed");
        const data = await response.json() as TerminalSettingsResponse;
        if (!Array.isArray(data.options)) throw new Error("Invalid settings");
        if (!controller.signal.aborted) setSettings(data);
      })
      .catch(() => { if (!controller.signal.aborted) setError("load"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);

  const selectShell = async (shell: string) => {
    if (loading || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/terminal/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shell }),
      });
      if (!response.ok) throw new Error("Save failed");
      setSettings(await response.json() as TerminalSettingsResponse);
    } catch {
      setError("save");
    } finally {
      setSaving(false);
    }
  };

  const options = [
    { value: "auto", label: settings?.defaultShell ? t("settings.terminalAutomatic", { shell: settings.defaultShell }) : t("settings.terminalAuto") },
    ...(settings?.options ?? []),
    ...(settings?.unavailable ? [{ value: settings.shell, label: t("settings.terminalUnavailable"), disabled: true }] : []),
  ];

  return (
    <section className="settings-general-section settings-terminal-section">
      <h3 className="settings-general-heading">{t("settings.terminal")}</h3>
      <p className="settings-general-description" id="settings-terminal-hint">{t("settings.terminalHint")}</p>
      <div className="settings-option-list"><div className="settings-option settings-terminal-option">
        <span className="settings-option-text">
          <span className="settings-option-title" id="settings-terminal-label">{t("settings.terminalDefault")}</span>
        </span>
        <AppSelect value={settings?.shell ?? "auto"} options={options}
          onValueChange={shell => void selectShell(shell)} disabled={loading || saving}
          aria-label={t("settings.terminalDefault")} aria-describedby="settings-terminal-hint"
          aria-busy={loading || saving} title={settings?.shell === "auto" ? undefined : settings?.shell} />
      </div></div>
      {error && <p role="alert" className="settings-general-error">
        {t(error === "load" ? "settings.terminalLoadError" : "settings.terminalSaveError")}
        {error === "load" && <ConfigButton variant="secondary" size="small" onClick={() => setAttempt(value => value + 1)}>{t("common.retry")}</ConfigButton>}
      </p>}
      {settings?.unavailable && <p role="status" className="settings-general-error">{t("settings.terminalMissing")}</p>}
    </section>
  );
}
