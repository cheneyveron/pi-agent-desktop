import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// The real-world fixture: pi-memhana's own package.json and settings schema
// from its v0.2 branch (read-only). Skipped where that checkout is absent.
const repo = process.env.PI_MEMHANA_REPO ?? "/home/hermes/workspace/pi-memhana";
function show(path) {
  try {
    return execFileSync("git", ["-C", repo, "show", `v0.2:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
const packageJson = show("package.json");
const schemaJson = show("settings.schema.json");
const skip = packageJson && schemaJson ? false : "pi-memhana v0.2 is not available";

const root = await mkdtemp(join(tmpdir(), "pi-web-pi-memhana-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previous = { home: process.env.PI_AGENT_HOME, agent: process.env.PI_CODING_AGENT_DIR };
process.env.PI_AGENT_HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
await Promise.all([home, agentDir, cwd].map((dir) => mkdir(dir, { recursive: true })));
after(async () => {
  for (const [name, value] of [["PI_AGENT_HOME", previous.home], ["PI_CODING_AGENT_DIR", previous.agent]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const settingsRoute = await jiti.import("./route.ts");
const pluginsRoute = await jiti.import("../route.ts");
const { parsePluginSettingsSchema } = await jiti.import("../../../../lib/plugin-settings-schema.ts");
allowFileRoot(cwd);

const pkg = join(root, "pi-memhana");
const configPath = join(home, ".memhana", "config.json");
if (!skip) {
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), packageJson);
  await writeFile(join(pkg, "settings.schema.json"), schemaJson);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
}

const getSettings = () => settingsRoute.GET(new Request(
  `http://localhost/api/plugins/settings?${new URLSearchParams({ cwd, source: pkg, scope: "global" })}`,
  { headers: { host: "localhost" } },
));
const putSettings = (values) => settingsRoute.PUT(new Request("http://localhost/api/plugins/settings", {
  method: "PUT",
  headers: { host: "localhost", "content-type": "application/json" },
  body: JSON.stringify({ cwd, source: pkg, scope: "global", values }),
}));

test("the schema parses with no unsupported property", { skip }, () => {
  const parsed = parsePluginSettingsSchema(JSON.parse(schemaJson));
  assert.deepEqual(parsed.properties.filter((field) => field.type === "unsupported"), []);
  assert.equal(parsed.properties.length, Object.keys(JSON.parse(schemaJson).properties).length);
  assert.equal(parsed.properties.find((field) => field.key === "serve_command").type, "string[]");
});

test("the listing shows the settings as available", { skip }, async () => {
  const response = await pluginsRoute.GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
  const body = await response.json();
  assert.deepEqual(body.packages.find((item) => item.source === pkg).settings, { file: configPath, available: true });
});

test("GET masks the token", { skip }, async () => {
  await mkdir(join(home, ".memhana"), { recursive: true });
  await writeFile(configPath, JSON.stringify({ url: "http://127.0.0.1:9088", token: "MEMHANA-SECRET", legacy: true }));
  const text = await (await getSettings()).text();
  assert.equal(text.includes("MEMHANA-SECRET"), false);
  assert.deepEqual(JSON.parse(text).values.token, { __secret: true, set: true });
  assert.equal(JSON.parse(text).values.legacy, undefined, "keys outside the schema are not sent");
});

test("url and recall_mode round-trip and the rest of the file is kept", { skip }, async () => {
  const response = await putSettings({ url: "http://127.0.0.1:9099", recall_mode: "prompt" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.values.url, "http://127.0.0.1:9099");
  assert.equal(body.values.recall_mode, "prompt");
  const again = (await (await getSettings()).json()).values;
  assert.equal(again.url, "http://127.0.0.1:9099");
  assert.equal(again.recall_mode, "prompt");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    url: "http://127.0.0.1:9099", token: "MEMHANA-SECRET", legacy: true, recall_mode: "prompt",
  });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test("an invalid recall_mode is rejected and nothing is written", { skip }, async () => {
  const before = await readFile(configPath, "utf8");
  const response = await putSettings({ recall_mode: "always" });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).fieldErrors.recall_mode.code, "enum");
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.equal((await putSettings({ recall_timeout_ms: 10 })).status, 422);
});
