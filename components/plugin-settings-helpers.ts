import type {
  PluginSettingsErrorCode,
  PluginSettingsField,
  PluginSettingsFieldError,
  PluginSettingsSchema,
} from "@/lib/api-types";
import { isSecretField, validatePluginSettingsValue } from "@/lib/plugin-settings-schema";

// The pure half of the Settings › Plugins form (components/PluginSettingsForm.tsx):
// turning the server's values into editable text, and the edited text back
// into the PUT body. Only fields the user changed are sent, so a value
// the form could not show (or a secret it never held) is never rewritten.

/** A secret field's pending edit: a new value, or a request to remove the stored one. */
export interface SecretDraft {
  input: string;
  clear: boolean;
}

export interface PluginSettingsDraft {
  /** Editable text per field; a boolean is `true`/`false`, or undefined while it follows the default. "" means not set. */
  fields: Record<string, string | boolean | undefined>;
  secrets: Record<string, SecretDraft>;
}

/** A field problem in a form the UI can translate. */
export interface PluginSettingsDraftError {
  code: PluginSettingsErrorCode;
  limit?: number;
}

/** The fields the form can edit, in schema order. */
export function editableFields(schema: PluginSettingsSchema): PluginSettingsField[] {
  return schema.properties.filter((field) => field.type !== "unsupported");
}

function textFromValue(field: PluginSettingsField, value: unknown): string | boolean | undefined {
  if (field.type === "boolean") return typeof value === "boolean" ? value : undefined;
  if (value === undefined || value === null) return "";
  if (field.type === "string[]") return Array.isArray(value) ? value.map(String).join("\n") : "";
  return String(value);
}

/** The draft that shows `values` (the GET response's `values`) unchanged. */
export function draftFromValues(schema: PluginSettingsSchema, values: Record<string, unknown>): PluginSettingsDraft {
  const draft: PluginSettingsDraft = { fields: {}, secrets: {} };
  for (const field of editableFields(schema)) {
    if (isSecretField(field)) draft.secrets[field.key] = { input: "", clear: false };
    else draft.fields[field.key] = textFromValue(field, values[field.key]);
  }
  return draft;
}

/** Whether the secret is stored, from the GET marker `{__secret, set}`. */
export function secretIsSet(values: Record<string, unknown>, key: string): boolean {
  const marker = values[key];
  return typeof marker === "object" && marker !== null && (marker as { set?: unknown }).set === true;
}

/** The typed value of one edited field, or null for "not set". NaN stands for text that is not a number. */
function valueFromText(field: PluginSettingsField, text: string | boolean | undefined): unknown {
  if (field.type === "boolean") return typeof text === "boolean" ? text : null;
  const raw = typeof text === "string" ? text : "";
  if (field.type === "string[]") {
    const items = raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : null;
  }
  if (raw.trim() === "") return null;
  if (field.type === "integer" || field.type === "number") {
    const parsed = Number(raw.trim());
    // An enum of numbers arrives as text from the select; Number() restores it.
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return raw;
}

function changedFieldKeys(schema: PluginSettingsSchema, draft: PluginSettingsDraft, initial: PluginSettingsDraft): string[] {
  const keys: string[] = [];
  for (const field of editableFields(schema)) {
    if (isSecretField(field)) {
      const secret = draft.secrets[field.key];
      if (secret && (secret.clear || secret.input !== "")) keys.push(field.key);
    } else if (draft.fields[field.key] !== initial.fields[field.key]) {
      keys.push(field.key);
    }
  }
  return keys;
}

export function isDraftDirty(schema: PluginSettingsSchema, draft: PluginSettingsDraft, initial: PluginSettingsDraft): boolean {
  return changedFieldKeys(schema, draft, initial).length > 0;
}

/** Problems with the edited fields, by key. Checks what the server would, so most are caught before the request. */
export function validateDraft(
  schema: PluginSettingsSchema,
  draft: PluginSettingsDraft,
  initial: PluginSettingsDraft,
  values: Record<string, unknown>,
): Record<string, PluginSettingsDraftError> {
  const errors: Record<string, PluginSettingsDraftError> = {};
  const changed = new Set(changedFieldKeys(schema, draft, initial));
  for (const field of editableFields(schema)) {
    let problem: PluginSettingsFieldError | null = null;
    let missing = false;
    if (isSecretField(field)) {
      const secret = draft.secrets[field.key];
      missing = secret ? (secret.clear || (!secretIsSet(values, field.key) && secret.input === "")) : true;
    } else {
      const value = valueFromText(field, draft.fields[field.key]);
      missing = value === null;
      if (!missing && changed.has(field.key)) problem = validatePluginSettingsValue(field, value);
    }
    if (problem) errors[field.key] = { code: problem.code, limit: problem.limit };
    else if (missing && field.required && field.default === undefined) errors[field.key] = { code: "required" };
  }
  return errors;
}

/** The PUT body's `values`: only changed fields; "not set" is null, an untouched secret is left out. */
export function valuesFromDraft(
  schema: PluginSettingsSchema,
  draft: PluginSettingsDraft,
  initial: PluginSettingsDraft,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of changedFieldKeys(schema, draft, initial)) {
    const field = schema.properties.find((item) => item.key === key);
    if (!field) continue;
    if (isSecretField(field)) {
      const secret = draft.secrets[key];
      values[key] = secret.clear ? null : secret.input;
    } else {
      values[key] = valueFromText(field, draft.fields[key]);
    }
  }
  return values;
}

/** The text of a default for a hint; arrays one per line. */
export function defaultText(field: PluginSettingsField): string | undefined {
  if (field.default === undefined) return undefined;
  if (Array.isArray(field.default)) return field.default.join(", ");
  return String(field.default);
}
