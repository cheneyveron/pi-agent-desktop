import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const {
  applyPluginSettings,
  isSecretField,
  maskPluginSettings,
  parsePluginSettingsSchema,
  PluginSettingsSchemaError,
  validatePluginSettingsValue,
} = await jiti.import("./plugin-settings-schema.ts");

const fixtureSchema = {
  type: "object",
  title: "Example",
  required: ["url"],
  properties: {
    url: { type: "string", format: "uri", title: "Server", description: "Where it lives", default: "http://127.0.0.1:9088" },
    token: { type: "string", format: "password", title: "Token" },
    mode: { type: "string", enum: ["fast", "deep"], default: "fast" },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    ratio: { type: "number", minimum: 0, maximum: 1 },
    enabled: { type: "boolean", default: true },
    tags: { type: "array", items: { type: "string" } },
    nested: { type: "object", properties: {} },
    mixed: { type: ["string", "null"] },
    numbers: { type: "array", items: { type: "number" } },
  },
};

const schema = parsePluginSettingsSchema(fixtureSchema);
const field = (key) => schema.properties.find((item) => item.key === key);

test("parses the supported subset and keeps property order", () => {
  assert.deepEqual(schema.properties.map((item) => item.key), Object.keys(fixtureSchema.properties));
  assert.equal(schema.title, "Example");
  assert.deepEqual(field("url"), {
    key: "url", type: "string", title: "Server", description: "Where it lives",
    format: "uri", default: "http://127.0.0.1:9088", required: true,
  });
  assert.deepEqual(field("mode").enum, ["fast", "deep"]);
  assert.equal(field("limit").minimum, 1);
  assert.equal(field("limit").maximum, 50);
  assert.equal(field("tags").type, "string[]");
  assert.equal(isSecretField(field("token")), true);
  assert.equal(isSecretField(field("url")), false);
});

test("unsupported property types are kept read-only", () => {
  for (const key of ["nested", "mixed", "numbers"]) assert.equal(field(key).type, "unsupported", key);
  assert.equal(validatePluginSettingsValue(field("nested"), {}).code, "readonly");
});

test("ignores unknown keywords and a default of the wrong type", () => {
  const parsed = parsePluginSettingsSchema({
    properties: { a: { type: "string", minLength: 2, default: 3, "x-extra": true, enum: ["a", 1] } },
  });
  assert.deepEqual(parsed.properties[0], { key: "a", type: "string", enum: ["a"], required: false });
});

test("rejects a schema that is not an object schema", () => {
  assert.throws(() => parsePluginSettingsSchema([]), PluginSettingsSchemaError);
  assert.throws(() => parsePluginSettingsSchema({ type: "array", properties: {} }), /type "object"/);
  assert.throws(() => parsePluginSettingsSchema({ type: "object" }), /no properties/);
  assert.throws(
    () => parsePluginSettingsSchema(JSON.parse('{"properties":{"__proto__":{"type":"string"}}}')),
    /reserved/,
  );
});

test("masks passwords and sends only schema properties", () => {
  const values = maskPluginSettings(schema, { url: "http://x", token: "s3cret", limit: 5, stray: "hidden", ratio: undefined });
  assert.deepEqual(values, { url: "http://x", token: { __secret: true, set: true }, limit: 5 });
  assert.deepEqual(maskPluginSettings(schema, {}).token, { __secret: true, set: false });
  assert.equal(JSON.stringify(values).includes("s3cret"), false);
});

test("validates type, enum, bounds and uri", () => {
  assert.equal(validatePluginSettingsValue(field("limit"), 2.5).code, "type");
  assert.equal(validatePluginSettingsValue(field("limit"), "3").code, "type");
  assert.equal(validatePluginSettingsValue(field("limit"), 0).code, "minimum");
  assert.equal(validatePluginSettingsValue(field("limit"), 51).code, "maximum");
  assert.equal(validatePluginSettingsValue(field("limit"), 51).limit, 50);
  assert.equal(validatePluginSettingsValue(field("limit"), 50), null);
  assert.equal(validatePluginSettingsValue(field("ratio"), 0.5), null);
  assert.equal(validatePluginSettingsValue(field("ratio"), Number.NaN).code, "type");
  assert.equal(validatePluginSettingsValue(field("mode"), "slow").code, "enum");
  assert.equal(validatePluginSettingsValue(field("mode"), "deep"), null);
  assert.equal(validatePluginSettingsValue(field("url"), "not a url").code, "format");
  assert.equal(validatePluginSettingsValue(field("enabled"), "yes").code, "type");
  assert.equal(validatePluginSettingsValue(field("tags"), ["a", 1]).code, "type");
  assert.equal(validatePluginSettingsValue(field("tags"), ["a", "b"]), null);
});

test("applies a request: unknown keys in the file survive, null removes, passwords follow the rules", () => {
  const stored = { url: "http://old", token: "keep-me", other: { a: 1 }, limit: 7 };

  const kept = applyPluginSettings(schema, stored, { limit: 9, mode: "deep" });
  assert.deepEqual(kept, { ok: true, values: { url: "http://old", token: "keep-me", other: { a: 1 }, limit: 9, mode: "deep" } });

  const cleared = applyPluginSettings(schema, stored, { token: null, limit: null });
  assert.deepEqual(cleared.values, { url: "http://old", other: { a: 1 } });

  const replaced = applyPluginSettings(schema, stored, { token: "new" });
  assert.equal(replaced.values.token, "new");
  assert.equal(stored.token, "keep-me", "the stored object is not mutated");
});

test("refuses unknown keys, read-only fields, a secret marker sent back, and bad values together", () => {
  const result = applyPluginSettings(schema, { url: "http://old" }, {
    nope: 1,
    nested: {},
    token: { __secret: true, set: true },
    limit: 0,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(Object.fromEntries(Object.entries(result.errors).map(([key, error]) => [key, error.code])), {
    nope: "unknown", nested: "readonly", token: "type", limit: "minimum",
  });
});

test("required keys must exist after the merge", () => {
  const strict = parsePluginSettingsSchema({ required: ["url"], properties: { url: { type: "string" }, limit: { type: "integer" } } });
  assert.equal(applyPluginSettings(strict, {}, { limit: 3 }).errors.url.code, "required");
  assert.equal(applyPluginSettings(strict, { url: "http://x" }, { limit: 3 }).ok, true);
  assert.equal(applyPluginSettings(strict, { url: "http://x" }, { url: null }).errors.url.code, "required");
  assert.equal(applyPluginSettings(strict, { url: "http://x" }, { url: "" }).errors.url.code, "required");
});

test("an invalid value elsewhere in the file does not block a save", () => {
  assert.equal(applyPluginSettings(schema, { url: "http://x", limit: "garbage" }, { mode: "fast" }).ok, true);
});

test("a required key with a default is satisfied when absent", () => {
  const withDefault = parsePluginSettingsSchema({
    required: ["url", "mode"],
    properties: { url: { type: "string" }, mode: { type: "string", default: "fast" } },
  });
  assert.equal(applyPluginSettings(withDefault, { url: "http://x" }, { url: "http://y" }).ok, true);
  // Removing it falls back to the default, so that is fine too; an explicit empty string is not.
  assert.equal(applyPluginSettings(withDefault, { url: "http://x", mode: "deep" }, { mode: null }).ok, true);
  assert.equal(applyPluginSettings(withDefault, { url: "http://x" }, { mode: "" }).errors.mode.code, "required");
  assert.equal(applyPluginSettings(withDefault, {}, {}).errors.url.code, "required");
});

test("pattern: validated on strings, an invalid regex makes the schema unusable", () => {
  const parsed = parsePluginSettingsSchema({ properties: { bank: { type: "string", pattern: "^([-\\w.]{1,100})?$" }, n: { type: "integer", pattern: "x" } } });
  const bank = parsed.properties[0];
  assert.equal(bank.pattern, "^([-\\w.]{1,100})?$");
  assert.equal(parsed.properties[1].pattern, undefined, "only strings take a pattern");
  assert.equal(validatePluginSettingsValue(bank, "life-notes.v2"), null);
  assert.equal(validatePluginSettingsValue(bank, ""), null);
  assert.equal(validatePluginSettingsValue(bank, "bad name!").code, "pattern");
  assert.throws(() => parsePluginSettingsSchema({ properties: { a: { type: "string", pattern: "([" } } }), /not a valid regular expression/);
  assert.throws(() => parsePluginSettingsSchema({ properties: { a: { type: "string", pattern: "a".repeat(1001) } } }), /longer than/);
});
