"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { PluginPackageInfo, PluginSettingsField, PluginSettingsResponse } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { shortenPath } from "@/lib/display-path";
import { isSecretField } from "@/lib/plugin-settings-schema";
import { AppSelect } from "./AppSelect";
import { ConfigButton, ConfigField, ConfigSectionTitle, ConfigSwitch } from "./SettingsUi";
import {
  defaultText,
  draftFromValues,
  editableFields,
  isDraftDirty,
  secretIsSet,
  validateDraft,
  valuesFromDraft,
  type PluginSettingsDraft,
  type PluginSettingsDraftError,
} from "./plugin-settings-helpers";

type Translate = ReturnType<typeof useI18n>["t"];
type FieldErrors = Record<string, PluginSettingsDraftError>;

interface FieldProps {
  field: PluginSettingsField;
  draft: PluginSettingsDraft;
  values: Record<string, unknown>;
  error?: PluginSettingsDraftError;
  disabled: boolean;
  onText: (key: string, value: string | boolean) => void;
  onSecret: (key: string, patch: Partial<PluginSettingsDraft["secrets"][string]>) => void;
}

export function settingsErrorText(error: PluginSettingsDraftError, t: Translate): string {
  return t(`plugins.settings.error.${error.code}`, { limit: error.limit ?? "" });
}

export async function requestSettings(
  pkg: Pick<PluginPackageInfo, "source" | "scope">,
  cwd: string,
  values?: Record<string, unknown>,
): Promise<PluginSettingsResponse> {
  const response = values === undefined
    ? await fetch(`/api/plugins/settings?${new URLSearchParams({ cwd, source: pkg.source, scope: pkg.scope })}`)
    : await fetch("/api/plugins/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, source: pkg.source, scope: pkg.scope, values }),
    });
  const body = (await response.json().catch(() => ({}))) as PluginSettingsResponse & {
    error?: string;
    fieldErrors?: FieldErrors;
  };
  if (!response.ok || body.error) {
    throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { fieldErrors: body.fieldErrors });
  }
  return body;
}

function SettingsField({ field, draft, values, error, disabled, onText, onSecret }: FieldProps) {
  const { t } = useI18n();
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const label = field.title ?? field.key;
  const fallback = defaultText(field);
  const describedBy = [helpId, error ? errorId : null].filter(Boolean).join(" ");
  const invalid = error ? { "aria-invalid": true as const } : {};
  const common = { id, className: "plugin-settings-input", disabled, "aria-describedby": describedBy, ...invalid };
  const text = draft.fields[field.key];

  let control: React.ReactNode;
  let hint: string | undefined;
  if (isSecretField(field)) {
    const secret = draft.secrets[field.key] ?? { input: "", clear: false };
    const stored = secretIsSet(values, field.key);
    control = (
      <div className="plugin-settings-secret">
        <input
          {...common}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          value={secret.input}
          placeholder={t(stored ? "plugins.settings.secretNew" : "plugins.settings.secretEnter")}
          onChange={(event) => onSecret(field.key, { input: event.target.value, clear: false })}
        />
        <span className={`plugin-settings-secret-state${stored && !secret.clear ? " is-set" : ""}`}>
          {t(stored && !secret.clear ? "plugins.settings.secretSet" : "plugins.settings.secretNotSet")}
        </span>
        {stored && (
          <ConfigButton
            size="small"
            disabled={disabled}
            onClick={() => onSecret(field.key, { input: "", clear: !secret.clear })}
          >
            {t(secret.clear ? "plugins.settings.secretKeep" : "plugins.settings.secretClear")}
          </ConfigButton>
        )}
      </div>
    );
    if (secret.clear) hint = t("plugins.settings.secretWillClear");
  } else if (field.type === "boolean") {
    const checked = typeof text === "boolean" ? text : field.default === true;
    control = (
      <ConfigSwitch
        checked={checked}
        disabled={disabled}
        label={label}
        describedBy={helpId}
        onChange={(next) => onText(field.key, next)}
      />
    );
    if (fallback !== undefined) {
      hint = t("plugins.settings.defaultValue", { value: t(field.default === true ? "plugins.settings.on" : "plugins.settings.off") });
    }
  } else if (field.enum) {
    control = (
      <AppSelect
        {...common}
        value={String(text ?? "")}
        aria-label={label}
        onValueChange={(next) => onText(field.key, next)}
        options={[
          ...(field.required ? [] : [{ value: "", label: t("plugins.settings.defaultChoice") }]),
          ...field.enum.map((option) => ({ value: String(option), label: String(option) })),
        ]}
      />
    );
    if (fallback !== undefined) hint = t("plugins.settings.defaultValue", { value: fallback });
  } else if (field.type === "string[]") {
    control = (
      <textarea
        {...common}
        rows={3}
        spellCheck={false}
        value={String(text ?? "")}
        placeholder={fallback}
        onChange={(event) => onText(field.key, event.target.value)}
      />
    );
    hint = t("plugins.settings.listHint");
  } else {
    const numeric = field.type === "integer" || field.type === "number";
    control = (
      <input
        {...common}
        type={numeric ? "number" : "text"}
        min={field.minimum}
        max={field.maximum}
        step={field.type === "integer" ? 1 : numeric ? "any" : undefined}
        inputMode={field.format === "uri" ? "url" : undefined}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        value={String(text ?? "")}
        placeholder={fallback}
        onChange={(event) => onText(field.key, event.target.value)}
      />
    );
  }

  return (
    <div className="plugin-settings-field">
      <ConfigField
        label={(
          <label htmlFor={id}>
            {label}
            {field.required && <span className="plugin-settings-required">{t("plugins.settings.required")}</span>}
          </label>
        )}
      >
        {control}
      </ConfigField>
      <div id={helpId} className="plugin-settings-help">
        {field.description}
        {field.description && hint ? " " : null}
        {hint}
      </div>
      {error && <div id={errorId} className="plugin-settings-error" role="alert">{settingsErrorText(error, t)}</div>}
    </div>
  );
}

/** What the form shows; every state lives in `PluginSettingsForm`, so this renders from props alone. */
export interface PluginSettingsViewProps {
  loaded: PluginSettingsResponse;
  draft: PluginSettingsDraft;
  errors: FieldErrors;
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  saveError: string | null;
  onEdit: (draft: PluginSettingsDraft) => void;
  onSave: () => void;
  onRevert: () => void;
}

export function PluginSettingsView({
  loaded,
  draft,
  errors,
  dirty,
  saving,
  saved,
  saveError,
  onEdit,
  onSave,
  onRevert,
}: PluginSettingsViewProps) {
  const { t } = useI18n();
  const readOnly = loaded.schema.properties.filter((field) => field.type === "unsupported");
  return (
    <form
      className="plugin-settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !saving) onSave();
      }}
    >
      <ConfigSectionTitle>{loaded.schema.title ?? t("plugins.settings.title")}</ConfigSectionTitle>
      {loaded.schema.description && <div className="plugin-settings-help">{loaded.schema.description}</div>}
      <div className="plugin-settings-note">
        {t("plugins.settings.file", { path: shortenPath(loaded.file) })}
        {!loaded.exists && ` ${t("plugins.settings.fileMissing")}`}
      </div>

      {editableFields(loaded.schema).map((field) => (
        <SettingsField
          key={field.key}
          field={field}
          draft={draft}
          values={loaded.values}
          error={errors[field.key]}
          disabled={saving}
          onText={(key, value) => onEdit({ ...draft, fields: { ...draft.fields, [key]: value } })}
          onSecret={(key, patch) => onEdit({ ...draft, secrets: { ...draft.secrets, [key]: { ...draft.secrets[key], ...patch } } })}
        />
      ))}

      {readOnly.map((field) => (
        <div className="plugin-settings-field" key={field.key}>
          <ConfigField label={field.title ?? field.key}>
            <pre className="plugin-settings-json">{JSON.stringify(loaded.values[field.key] ?? null, null, 2)}</pre>
          </ConfigField>
          <div className="plugin-settings-help">{t("plugins.settings.readOnly")}</div>
        </div>
      ))}

      <div className="plugin-settings-actions">
        <ConfigButton variant="primary" size="small" onClick={onSave} disabled={!dirty || saving}>
          {t(saving ? "plugins.settings.saving" : "plugins.settings.save")}
        </ConfigButton>
        <ConfigButton size="small" onClick={onRevert} disabled={!dirty || saving}>
          {t("plugins.settings.revert")}
        </ConfigButton>
        <span className="plugin-settings-status" role="status">
          {saveError
            ? <span className="plugin-settings-error">{saveError}</span>
            : saved && !dirty
              ? <span className="plugin-settings-saved">{t("plugins.settings.saved")}</span>
              : dirty
                ? t("plugins.settings.unsaved")
                : null}
        </span>
      </div>
    </form>
  );
}

/**
 * The Settings section of a package that declares `pi.settings`: a form
 * generated from its JSON Schema, saved to the file the plugin reads itself
 * (see lib/plugin-settings.ts). Secrets are never loaded, only "Set / Not set".
 */
export function PluginSettingsForm({ pkg, cwd }: { pkg: PluginPackageInfo; cwd: string }) {
  const { t } = useI18n();
  // The package list reloads after every action; only a different package or install reloads the form.
  const { source, scope, installedPath } = pkg;
  const [loaded, setLoaded] = useState<PluginSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PluginSettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [showErrors, setShowErrors] = useState(false);

  const adopt = useCallback((response: PluginSettingsResponse) => {
    setLoaded(response);
    setDraft(draftFromValues(response.schema, response.values));
    setServerErrors({});
    setShowErrors(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setDraft(null);
    setLoadError(null);
    setSaved(false);
    setSaveError(null);
    requestSettings({ source, scope }, cwd)
      .then((response) => { if (!cancelled) adopt(response); })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [adopt, cwd, source, scope, installedPath]);

  const initial = useMemo(
    () => (loaded ? draftFromValues(loaded.schema, loaded.values) : null),
    [loaded],
  );
  const clientErrors = useMemo<FieldErrors>(
    () => (loaded && draft && initial ? validateDraft(loaded.schema, draft, initial, loaded.values) : {}),
    [loaded, draft, initial],
  );
  const errors = useMemo<FieldErrors>(
    () => ({ ...serverErrors, ...(showErrors || Object.keys(serverErrors).length > 0 ? clientErrors : {}) }),
    [clientErrors, serverErrors, showErrors],
  );

  if (loadError || !loaded || !draft || !initial) {
    return (
      <div className="plugin-settings">
        <ConfigSectionTitle>{t("plugins.settings.title")}</ConfigSectionTitle>
        {loadError
          ? <div className="plugin-settings-error" role="alert">{t("plugins.settings.loadFailed", { error: loadError })}</div>
          : <div className="plugin-settings-help" role="status">{t("plugins.settings.loading")}</div>}
      </div>
    );
  }

  const save = async () => {
    if (Object.keys(clientErrors).length > 0) {
      setShowErrors(true);
      setSaveError(t("plugins.settings.fixFields"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      adopt(await requestSettings({ source, scope }, cwd, valuesFromDraft(loaded.schema, draft, initial)));
      setSaved(true);
    } catch (error) {
      const fieldErrors = (error as { fieldErrors?: FieldErrors }).fieldErrors;
      if (fieldErrors) setServerErrors(fieldErrors);
      setSaveError(
        fieldErrors
          ? t("plugins.settings.fixFields")
          : t("plugins.settings.saveFailed", { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <PluginSettingsView
      loaded={loaded}
      draft={draft}
      errors={errors}
      dirty={isDraftDirty(loaded.schema, draft, initial)}
      saving={saving}
      saved={saved}
      saveError={saveError}
      onEdit={(next) => {
        setDraft(next);
        setSaved(false);
        setSaveError(null);
        setServerErrors({});
      }}
      onSave={() => void save()}
      onRevert={() => {
        adopt(loaded);
        setSaved(false);
        setSaveError(null);
      }}
    />
  );
}
