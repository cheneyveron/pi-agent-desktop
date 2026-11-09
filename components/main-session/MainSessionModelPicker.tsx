"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { setMainSessionModel, setMainSessionThinkingLevel, useMainSession } from "@/hooks/useMainSession";
import { MAIN_SESSION_THINKING_LEVELS, type MainSessionThinkingLevel } from "@/lib/main-session-client";
import { AppSelect } from "../AppSelect";
import { modelPickerOptions, thinkingPickerOptions, type PickerModel } from "./main-session-helpers";

/**
 * The models the app offers for selection (GET /api/models, scoped by enabledModels like the
 * composer's selector). The route only answers for folders on the file-access allow-list, and
 * the home folder the main session's turns run in is not one: asking for it returns 403 and
 * the picker would offer only "none". The chat workspace is an allowed root with the same
 * global (project-free) model scope, so the list is taken from there, as the Chats settings
 * picker does.
 */
interface ConfiguredModels {
  models: PickerModel[];
  /** Supported thinking levels per `provider/id`, as /api/models reports them. */
  thinkingLevels: Record<string, string[]>;
  loading: boolean;
}

let cached: Promise<Omit<ConfiguredModels, "loading">> | undefined;

function loadConfiguredModels(): Promise<Omit<ConfiguredModels, "loading">> {
  cached ??= fetch("/api/chat-workspace", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then((data: { cwd?: string }) => fetch(`/api/models${data.cwd ? `?cwd=${encodeURIComponent(data.cwd)}` : ""}`, { cache: "no-store" }))
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then((data: { modelList?: PickerModel[]; thinkingLevels?: Record<string, string[]> }) => ({
      models: Array.isArray(data.modelList) ? data.modelList : [],
      thinkingLevels: data.thinkingLevels && typeof data.thinkingLevels === "object" ? data.thinkingLevels : {},
    }))
    .catch(() => {
      cached = undefined; // the picker then offers only "none" and the current choice; retry next mount
      return { models: [], thinkingLevels: {} };
    });
  return cached;
}

function useConfiguredModels(): ConfiguredModels {
  const [models, setModels] = useState<PickerModel[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void loadConfiguredModels().then((data) => {
      if (cancelled) return;
      setModels(data.models);
      setThinkingLevels(data.thinkingLevels);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);
  return { models, thinkingLevels, loading };
}

interface Props {
  id?: string;
  className?: string;
}

/**
 * Picks the model for the main session's judgment turns and read-only checks. Writes through
 * POST /api/main-session/model; the service saves it in its state dir and uses it from the next
 * turn. Renders nothing for a service that predates the picker.
 */
export function MainSessionModelPicker({ id, className }: Props) {
  const { t } = useI18n();
  const state = useMainSession();
  const { models, loading } = useConfiguredModels();
  const choice = state.service?.model;
  if (!choice) return null;
  const locked = choice.source === "env";
  return (
    <AppSelect
      id={id}
      className={["ms-model-select", className].filter(Boolean).join(" ")}
      aria-label={t("mainSession.model.label")}
      title={locked ? t("mainSession.model.env") : choice.ref ?? undefined}
      value={choice.ref ?? ""}
      disabled={locked || state.modelSaving}
      placeholder={loading ? t("mainSession.model.loading") : undefined}
      onValueChange={(value) => { void setMainSessionModel(value || null); }}
      options={modelPickerOptions(models, choice.ref, t)}
    />
  );
}

/**
 * The reasoning level of the main session's turns, beside the model picker. Offers the levels
 * /api/models reports for the chosen model (all of them when it reports none); hidden until a
 * model is chosen, and for services older than 1.1.0, which always ran with reasoning off.
 */
export function MainSessionThinkingPicker({ id, className }: Props) {
  const { t } = useI18n();
  const state = useMainSession();
  const { thinkingLevels } = useConfiguredModels();
  const choice = state.service?.model;
  if (!choice?.ref || !choice.thinkingLevel) return null;
  const supported = thinkingLevels[choice.ref];
  const levels = supported?.length
    ? MAIN_SESSION_THINKING_LEVELS.filter((level) => level === "off" || supported.includes(level))
    : MAIN_SESSION_THINKING_LEVELS;
  return (
    <AppSelect
      id={id}
      className={["ms-thinking-select", className].filter(Boolean).join(" ")}
      aria-label={t("mainSession.thinking.label")}
      title={t("mainSession.thinking.label")}
      value={choice.thinkingLevel}
      disabled={state.modelSaving}
      onValueChange={(value) => { void setMainSessionThinkingLevel((value || "off") as MainSessionThinkingLevel); }}
      options={thinkingPickerOptions(levels, choice.thinkingLevel, t)}
    />
  );
}
