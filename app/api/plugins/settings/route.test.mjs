import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-settings-route-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previous = { home: process.env.PI_AGENT_HOME, agent: process.env.PI_CODING_AGENT_DIR };
process.env.PI_AGENT_HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(home, { recursive: true });
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const settingsRoute = await jiti.import("./route.ts");
const pluginsRoute = await jiti.import("../route.ts");
allowFileRoot(cwd);

after(async () => {
  for (const [name, value] of [["PI_AGENT_HOME", previous.home], ["PI_CODING_AGENT_DIR", previous.agent]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const schema = {
  type: "object",
  required: ["url"],
  properties: {
    url: { type: "string", format: "uri", title: "Server URL" },
    token: { type: "string", format: "password" },
    limit: { type: "integer", minimum: 1 },
  },
};
const configPath = join(home, ".example", "config.json");

async function makePackage(name, settings = { file: "~/.example/config.json", schema: "./settings.schema.json" }) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", pi: { extensions: [], settings } }));
  await writeFile(join(dir, "settings.schema.json"), JSON.stringify(schema));
  return dir;
}

const pkg = await makePackage("with-settings");
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));

const query = (params) => `http://localhost/api/plugins/settings?${new URLSearchParams(params)}`;
const getSettings = (params = { cwd, source: pkg, scope: "global" }, headers = {}) =>
  settingsRoute.GET(new Request(query(params), { headers: { host: "localhost", ...headers } }));
const putSettings = (body, headers = {}) => settingsRoute.PUT(new Request("http://localhost/api/plugins/settings", {
  method: "PUT",
  headers: { host: "localhost", "content-type": "application/json", ...headers },
  body: JSON.stringify({ cwd, source: pkg, scope: "global", ...body }),
}));

test("the package listing says a package has settings and whether they are available", async () => {
  const broken = await makePackage("broken-settings", { file: "relative.json", schema: "./settings.schema.json" });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg, broken] }));
  const response = await pluginsRoute.GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
  const body = await response.json();
  const bySource = Object.fromEntries(body.packages.map((item) => [item.source, item.settings]));
  assert.deepEqual(bySource[pkg], { file: configPath, available: true });
  assert.equal(bySource[broken].available, false);
  assert.match(bySource[broken].error, /absolute path/);
});

test("GET answers with the schema, no values yet, and the resolved file", async () => {
  const response = await getSettings();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.exists, false);
  assert.equal(body.file, configPath);
  assert.deepEqual(body.values, { token: { __secret: true, set: false } });
  assert.equal(body.schema.properties[0].title, "Server URL");
});

test("PUT validates, writes mode 600 and answers like GET without the secret", async () => {
  const response = await putSettings({ values: { url: "http://127.0.0.1:9088", token: "s3cret", limit: 5 } });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(text.includes("s3cret"), false);
  const body = JSON.parse(text);
  assert.equal(body.exists, true);
  assert.deepEqual(body.values, { url: "http://127.0.0.1:9088", token: { __secret: true, set: true }, limit: 5 });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).token, "s3cret");

  const again = await (await getSettings()).text();
  assert.equal(again.includes("s3cret"), false);
});

test("PUT answers 422 with field errors and leaves the file alone", async () => {
  const before = await readFile(configPath, "utf8");
  const response = await putSettings({ values: { limit: 0, bogus: 1 } });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.fieldErrors.limit.code, "minimum");
  assert.equal(body.fieldErrors.bogus.code, "unknown");
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.equal((await putSettings({ values: "nope" })).status, 400);
});

test("requests are guarded like the rest of the plugins API", async () => {
  const forged = await putSettings({ values: { limit: 2 } }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  assert.equal(forged.status, 403);
  const text = await settingsRoute.PUT(new Request("http://localhost/api/plugins/settings", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "text/plain" },
    body: JSON.stringify({ cwd, source: pkg, values: {} }),
  }));
  assert.equal(text.status, 415);
  assert.equal((await getSettings({ cwd, source: pkg }, { host: "evil.example" })).status, 403);
  assert.equal((await getSettings({ source: pkg })).status, 400);
  assert.equal((await getSettings({ cwd: join(root, "elsewhere"), source: pkg })).status, 403);
  assert.equal((await getSettings({ cwd })).status, 400);
  assert.equal((await getSettings({ cwd, source: "npm:not-configured" })).status, 404);
  assert.equal((await getSettings({ cwd, source: pkg, scope: "project" })).status, 404);
});

test("a package without settings or with an unusable declaration is refused", async () => {
  const plain = join(root, "plain");
  await mkdir(plain);
  await writeFile(join(plain, "package.json"), JSON.stringify({ name: "plain" }));
  const broken = join(root, "broken-settings");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg, plain, broken] }));
  assert.equal((await getSettings({ cwd, source: plain })).status, 404);
  assert.equal((await getSettings({ cwd, source: broken })).status, 400);
  assert.equal((await putSettings({ source: broken, values: { url: "http://x" } })).status, 400);
});

test("a project-scoped package needs a trusted project", async () => {
  const project = join(root, "untrusted-project");
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }));
  allowFileRoot(project);
  const read = await getSettings({ cwd: project, source: pkg, scope: "project" });
  assert.equal(read.status, 403);
  assert.match((await read.json()).error, /must be trusted/);
  const write = await putSettings({ cwd: project, scope: "project", values: { limit: 3 } });
  assert.equal(write.status, 403);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).limit, 5);
});
