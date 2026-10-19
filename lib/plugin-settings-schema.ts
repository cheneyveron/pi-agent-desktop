import type {
  PluginSettingsField,
  PluginSettingsFieldError,
  PluginSettingsSchema,
  PluginSettingsSecret,
} from "./api-types";

// The JSON Schema subset a package's `pi.settings.schema` may use, and the
// rules the server enforces on a PUT. No filesystem here: the form imports it
// too, so a field is validated the same way before and after the request.
//
// Supported: `type: "object"` with `properties` and `required`; property types
// string, integer, number, boolean and array of strings; `enum`, `default`,
// `title`, `description`, `minimum`, `maximum`, and `format: "password" | "uri"`
// (string only). Unknown keywords are ignored. A property of any other type is
// kept as `unsupported`: shown read-only as JSON, never written.

/** A declaration or schema the form cannot use; the message is shown as the reason. */
export class PluginSettingsSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSettingsSchemaError";
  }
}

const MAX_PROPERTIES = 200;
const FORBIDDEN_KEYS = new Set(["__proto__"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fieldType(raw: Record<string, unknown>): PluginSettingsField["type"] {
  switch (raw.type) {
    case "string":
    case "integer":
    case "number":
    case "boolean":
      return raw.type;
    case "array":
      return isRecord(raw.items) && raw.items.type === "string" ? "string[]" : "unsupported";
    default:
      return "unsupported";
  }
}

/** Whether the value has the field's JSON type. Bounds and enum are not checked. */
function hasFieldType(type: PluginSettingsField["type"], value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "string[]": return Array.isArray(value) && value.every((item) => typeof item === "string");
    default: return false;
  }
}

function parseField(key: string, raw: unknown, required: boolean): PluginSettingsField {
  const source = isRecord(raw) ? raw : {};
  const type = fieldType(source);
  const field: PluginSettingsField = { key, type, required };
  const title = optionalText(source.title);
  const description = optionalText(source.description);
  if (title) field.title = title;
  if (description) field.description = description;
  if (type === "unsupported") return field;

  if (type === "string" && (source.format === "password" || source.format === "uri")) {
    field.format = source.format;
  }
  if (type === "integer" || type === "number") {
    const minimum = finiteNumber(source.minimum);
    const maximum = finiteNumber(source.maximum);
    if (minimum !== undefined) field.minimum = minimum;
    if (maximum !== undefined) field.maximum = maximum;
  }
  if ((type === "string" || type === "integer" || type === "number") && Array.isArray(source.enum)) {
    const options = source.enum.filter((option): option is string | number => hasFieldType(type, option));
    if (options.length > 0) field.enum = options;
  }
  // A default of the wrong type would only mislead the placeholder.
  if (source.default !== undefined && hasFieldType(type, source.default)) field.default = source.default;
  return field;
}

/** Reduces a parsed JSON Schema document to the form's subset, or throws a `PluginSettingsSchemaError`. */
export function parsePluginSettingsSchema(raw: unknown): PluginSettingsSchema {
  if (!isRecord(raw)) throw new PluginSettingsSchemaError("The settings schema is not a JSON object");
  if (raw.type !== undefined && raw.type !== "object") {
    throw new PluginSettingsSchemaError('The settings schema must have type "object"');
  }
  if (!isRecord(raw.properties)) throw new PluginSettingsSchemaError("The settings schema has no properties");
  const props = raw.properties;
  const keys = Object.keys(props);
  if (keys.length > MAX_PROPERTIES) {
    throw new PluginSettingsSchemaError(`The settings schema has more than ${MAX_PROPERTIES} properties`);
  }
  if (keys.some((key) => FORBIDDEN_KEYS.has(key))) {
    throw new PluginSettingsSchemaError("The settings schema uses a reserved property name");
  }
  const required = new Set(Array.isArray(raw.required) ? raw.required.filter((key) => typeof key === "string") : []);
  const schema: PluginSettingsSchema = {
    properties: keys.map((key) => parseField(key, props[key], required.has(key))),
  };
  const title = optionalText(raw.title);
  const description = optionalText(raw.description);
  if (title) schema.title = title;
  if (description) schema.description = description;
  return schema;
}

/** Whether the field holds a secret: its value is never sent to the browser. */
export function isSecretField(field: PluginSettingsField): boolean {
  return field.type === "string" && field.format === "password";
}

function isSecretMarker(value: unknown): value is PluginSettingsSecret {
  return isRecord(value) && value.__secret === true;
}

/** The file's values for the schema's properties only, with every secret replaced by `{__secret, set}`. */
export function maskPluginSettings(
  schema: PluginSettingsSchema,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of schema.properties) {
    const value = Object.hasOwn(stored, field.key) ? stored[field.key] : undefined;
    if (isSecretField(field)) {
      values[field.key] = { __secret: true, set: typeof value === "string" && value.length > 0 } satisfies PluginSettingsSecret;
    } else if (value !== undefined) {
      values[field.key] = value;
    }
  }
  return values;
}

function fieldError(code: PluginSettingsFieldError["code"], message: string, limit?: number): PluginSettingsFieldError {
  return limit === undefined ? { code, message } : { code, message, limit };
}

function isUri(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Checks one non-null value against its field: type, enum, bounds, format. */
export function validatePluginSettingsValue(field: PluginSettingsField, value: unknown): PluginSettingsFieldError | null {
  if (field.type === "unsupported") return fieldError("readonly", `${field.key} cannot be edited here`);
  if (!hasFieldType(field.type, value)) {
    const expected = field.type === "string[]" ? "a list of strings" : `a ${field.type}`;
    return fieldError("type", `${field.key} must be ${expected}`);
  }
  if (field.enum && !field.enum.includes(value as string | number)) {
    return fieldError("enum", `${field.key} must be one of: ${field.enum.join(", ")}`);
  }
  if (typeof value === "number") {
    if (field.minimum !== undefined && value < field.minimum) {
      return fieldError("minimum", `${field.key} must be at least ${field.minimum}`, field.minimum);
    }
    if (field.maximum !== undefined && value > field.maximum) {
      return fieldError("maximum", `${field.key} must be at most ${field.maximum}`, field.maximum);
    }
  }
  if (field.format === "uri" && typeof value === "string" && value !== "" && !isUri(value)) {
    return fieldError("format", `${field.key} must be a URL`);
  }
  return null;
}

export type PluginSettingsApplyResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: Record<string, PluginSettingsFieldError> };

/**
 * The file contents after a PUT: `stored` (the whole file, unknown keys
 * included) with the request's `input` applied. Only keys in `input` are
 * checked, so a hand-edited value elsewhere never blocks a save, but every
 * `required` key must exist in the result unless it has a `default`. A key set to `null` is removed; a
 * secret absent from `input` is kept. Unknown keys and read-only fields in
 * `input` are refused rather than dropped.
 */
export function applyPluginSettings(
  schema: PluginSettingsSchema,
  stored: Record<string, unknown>,
  input: Record<string, unknown>,
): PluginSettingsApplyResult {
  const errors: Record<string, PluginSettingsFieldError> = {};
  const values: Record<string, unknown> = { ...stored };
  const fields = new Map(schema.properties.map((field) => [field.key, field]));

  for (const key of Object.keys(input)) {
    const field = fields.get(key);
    if (!field) {
      errors[key] = fieldError("unknown", `${key} is not a setting of this plugin`);
      continue;
    }
    const value = input[key];
    if (field.type === "unsupported") {
      errors[key] = validatePluginSettingsValue(field, value) as PluginSettingsFieldError;
      continue;
    }
    if (value === null) {
      delete values[key];
      continue;
    }
    // The browser never holds a secret's value, so it cannot send the marker back as one.
    const problem = isSecretMarker(value)
      ? fieldError("type", `${key} must be a string`)
      : validatePluginSettingsValue(field, value);
    if (problem) errors[key] = problem;
    else values[key] = value;
  }

  for (const field of schema.properties) {
    if (errors[field.key] || !field.required || field.type === "unsupported") continue;
    const value = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
    // A key that is absent is satisfied by the default the plugin applies itself.
    if (value === undefined && field.default !== undefined) continue;
    if (value === undefined || value === "") errors[field.key] = fieldError("required", `${field.key} is required`);
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values };
}
