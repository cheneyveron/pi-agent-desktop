"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { setMainSessionModel, useMainSession } from "@/hooks/useMainSession";
import { AppSelect } from "../AppSelect";
import { modelPickerOptions, type PickerModel } from "./main-session-helpers";

/**
 * The models the app offers for selection (GET /api/models, scoped by enabledModels like the
 * composer's selector), for the folder the main session's turns run in: the home folder.
 */
function useConfiguredModels(): { models: PickerModel[]; loading: boolean } {
  const [models, setModels] = useState<PickerModel[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/home", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { home?: string }) => fetch(`/api/models${data.home ? `?cwd=${encodeURIComponent(data.home)}` : ""}`, { cache: "no-store" }))
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { modelList?: PickerModel[] }) => { if (!cancelled) setModels(Array.isArray(data.modelList) ? data.modelList : []); })
      .catch(() => { /* the picker then offers only "none" and the current choice */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  return { models, loading };
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
