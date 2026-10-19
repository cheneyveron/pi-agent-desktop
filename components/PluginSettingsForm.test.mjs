import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

// The whole path of the form without a browser: the real routes answer the
// form's fetches, the view renders the loaded schema, and an edit goes back
// through the same helpers the Save button uses.
const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-form-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previous = { home: process.env.PI_AGENT_HOME, agent: process.env.PI_CODING_AGENT_DIR };
process.env.PI_AGENT_HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
await Promise.all([home, agentDir, cwd].map((dir) => mkdir(dir, { recursive: true })));

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { allowFileRoot } = await jiti.import("../lib/file-access.ts");
const settingsRoute = await jiti.import("../app/api/plugins/settings/route.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { PluginSettingsView, requestSettings } = await jiti.import("./PluginSettingsForm.tsx");
const helpers = await jiti.import("./plugin-settings-helpers.ts");
const source = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");
allowFileRoot(cwd);

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "http://localhost");
  const request = new Request(url, { ...init, headers: { host: "localhost", ...(init.headers ?? {}) } });
  return init.method === "PUT" ? settingsRoute.PUT(request) : settingsRoute.GET(request);
};
after(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of [["PI_AGENT_HOME", previous.home], ["PI_CODING_AGENT_DIR", previous.agent]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const schema = {
  type: "object",
  title: "Example memory",
  required: ["url"],
  properties: {
    url: { type: "string", format: "uri", title: "Server URL", description: "Where the server listens.", default: "http://127.0.0.1:9088" },
    token: { type: "string", format: "password", title: "API token" },
    mode: { type: "string", enum: ["fast", "deep"], title: "Mode", default: "fast" },
    limit: { type: "integer", minimum: 1, maximum: 50, title: "Result limit", default: 10 },
    autosave: { type: "boolean", title: "Autosave", default: true },
    banks: { type: "array", items: { type: "string" }, title: "Banks" },
    advanced: { type: "object", title: "Advanced", properties: {} },
  },
};
const pkgDir = join(root, "example-plugin");
await mkdir(pkgDir, { recursive: true });
await writeFile(join(pkgDir, "package.json"), JSON.stringify({
  name: "example-plugin",
  pi: { extensions: [], settings: { file: "~/.example/config.json", schema: "./settings.schema.json" } },
}));
await writeFile(join(pkgDir, "settings.schema.json"), JSON.stringify(schema));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkgDir] }));
const pkg = { source: pkgDir, scope: "global" };
const configPath = join(home, ".example", "config.json");

function render(props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(PluginSettingsView, {
    errors: {}, dirty: false, saving: false, saved: false, saveError: null,
    onEdit() {}, onSave() {}, onRevert() {}, ...props,
  })));
}

test("renders a control for each schema property with title, help and default placeholders", async () => {
  const loaded = await requestSettings(pkg, cwd);
  const html = render({ loaded, draft: helpers.draftFromValues(loaded.schema, loaded.values) });

  assert.match(html, /Example memory/);
  assert.match(html, /Server URL/);
  assert.match(html, /Where the server listens\./);
  assert.match(html, /placeholder="http:\/\/127\.0\.0\.1:9088"/);
  assert.match(html, /placeholder="10"/);
  assert.match(html, /<input[^>]*type="number"[^>]*min="1"[^>]*max="50"/);
  assert.match(html, /<select[^>]*>[\s\S]*<option value=""[^>]*>\(default\)<\/option>[\s\S]*<option value="deep">deep<\/option>/);
  assert.match(html, /role="switch" aria-checked="true"/);
  assert.match(html, /<textarea/);
  assert.match(html, /Required/);
  assert.match(html, /\.example\/config\.json/);
  assert.match(html, /file does not exist yet/);
  // A property of an unsupported type is shown read-only as JSON, with no input of its own.
  assert.match(html, /Advanced[\s\S]*<pre class="plugin-settings-json">null<\/pre>/);
});

test("a password is a masked input with Set / Not set, and its value never reaches the page", async () => {
  await mkdir(join(home, ".example"), { recursive: true });
  await writeFile(configPath, JSON.stringify({ url: "http://x", token: "TOP-SECRET-VALUE", other: 1 }));
  const loaded = await requestSettings(pkg, cwd);
  const draft = helpers.draftFromValues(loaded.schema, loaded.values);
  const html = render({ loaded, draft });

  assert.equal(JSON.stringify(loaded).includes("TOP-SECRET-VALUE"), false);
  assert.equal(html.includes("TOP-SECRET-VALUE"), false);
  assert.match(html, /<input[^>]*type="password"[^>]*autoComplete="new-password"|<input[^>]*autoComplete="new-password"[^>]*type="password"/i);
  assert.match(html, /plugin-settings-secret-state is-set">Set</);
  assert.match(html, />Clear<\/button>/);

  const pending = { ...draft, secrets: { token: { input: "", clear: true } } };
  const cleared = render({ loaded, draft: pending, dirty: true });
  assert.match(cleared, /Not set/);
  assert.match(cleared, />Keep<\/button>/);
  assert.match(cleared, /Will be cleared when you save\./);
  assert.match(cleared, /Unsaved changes/);
});

test("edit, validate and save sends only what changed and keeps the rest of the file", async () => {
  await writeFile(configPath, JSON.stringify({ url: "http://old", token: "keep-me", other: { a: 1 }, limit: 3 }));
  const loaded = await requestSettings(pkg, cwd);
  const initial = helpers.draftFromValues(loaded.schema, loaded.values);
  assert.equal(helpers.isDraftDirty(loaded.schema, initial, initial), false);

  const draft = {
    fields: { ...initial.fields, url: "http://127.0.0.1:9088", mode: "deep", banks: "life\n\n  devops  ", limit: "" },
    secrets: { token: { input: "", clear: false } },
  };
  assert.deepEqual(helpers.validateDraft(loaded.schema, draft, initial, loaded.values), {});
  const values = helpers.valuesFromDraft(loaded.schema, draft, initial);
  assert.deepEqual(values, {
    url: "http://127.0.0.1:9088", mode: "deep", banks: ["life", "devops"], limit: null,
  });

  const saved = await requestSettings(pkg, cwd, values);
  assert.deepEqual(saved.values, {
    url: "http://127.0.0.1:9088", token: { __secret: true, set: true }, mode: "deep", banks: ["life", "devops"],
  });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    url: "http://127.0.0.1:9088", token: "keep-me", other: { a: 1 }, mode: "deep", banks: ["life", "devops"],
  });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);

  // Setting then clearing the password, in two saves.
  const next = helpers.draftFromValues(saved.schema, saved.values);
  const replaced = await requestSettings(pkg, cwd, helpers.valuesFromDraft(saved.schema, {
    ...next, secrets: { token: { input: "fresh", clear: false } },
  }, next));
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).token, "fresh");
  const after = helpers.draftFromValues(replaced.schema, replaced.values);
  await requestSettings(pkg, cwd, helpers.valuesFromDraft(replaced.schema, {
    ...after, secrets: { token: { input: "", clear: true } },
  }, after));
  assert.equal("token" in JSON.parse(await readFile(configPath, "utf8")), false);
});

test("field validation names the problem before and after the request", async () => {
  const loaded = await requestSettings(pkg, cwd);
  const initial = helpers.draftFromValues(loaded.schema, loaded.values);
  const draft = { ...initial, fields: { ...initial.fields, url: "", limit: "99", autosave: false } };
  // url is required but has a default, so leaving it empty is fine; without the default it is not.
  assert.deepEqual(helpers.validateDraft(loaded.schema, draft, initial, loaded.values), {
    limit: { code: "maximum", limit: 50 },
  });
  const noDefault = { ...loaded.schema, properties: loaded.schema.properties.map((f) => (f.key === "url" ? { ...f, default: undefined } : f)) };
  assert.deepEqual(helpers.validateDraft(noDefault, draft, initial, loaded.values).url, { code: "required" });
  const notUrl = { ...initial, fields: { ...initial.fields, url: "nope" } };
  assert.deepEqual(helpers.validateDraft(loaded.schema, notUrl, initial, loaded.values).url, { code: "format", limit: undefined });

  await assert.rejects(
    requestSettings(pkg, cwd, { limit: 99 }),
    (error) => error.message === "Some settings are not valid" && error.fieldErrors.limit.code === "maximum",
  );

  const html = render({
    loaded, draft, dirty: true,
    errors: { url: { code: "required" }, limit: { code: "maximum", limit: 50 } },
    saveError: "Fix the highlighted settings first.",
  });
  assert.match(html, /role="alert">Required\./);
  assert.match(html, /Must be at most 50\./);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /Fix the highlighted settings first\./);
});

test("a saved form says it takes effect in new sessions", async () => {
  const loaded = await requestSettings(pkg, cwd);
  const draft = helpers.draftFromValues(loaded.schema, loaded.values);
  assert.match(render({ loaded, draft, saved: true }), /Saved\. Takes effect in new sessions\./);
});

test("the package detail mounts the form only when the package's settings are available", () => {
  assert.match(source, /pkg\.settings\?\.available \? \(\s*<PluginSettingsForm key=\{`\$\{key\}\\0\$\{pkg\.installedPath \?\? ""\}`\} pkg=\{pkg\} cwd=\{cwd\} \/>/);
  assert.match(source, /t\("plugins\.settings\.unavailable", \{ reason: pkg\.settings\.error \?\? "" \}\)/);
});
