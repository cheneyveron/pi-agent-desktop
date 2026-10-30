import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const original = process.env.PI_CODING_AGENT_DIR;
const agent = await mkdtemp(join(tmpdir(), "pi-terminal-settings-"));
process.env.PI_CODING_AGENT_DIR = agent;
const file = join(agent, "pi-web/settings.json");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, PUT } = await jiti.import("./route.ts");
const { resolveTerminalShell } = await jiti.import("../../../../lib/terminal-settings.ts");
after(async () => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
  await rm(agent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const request = (body, headers = {}) => new Request("http://localhost/api/terminal/settings", {
  method: "PUT", headers: { Host: "localhost", "Content-Type": "application/json", ...headers }, body,
});

test("terminal selection persists, preserves other preferences and resolves the selected executable", async () => {
  const initial = await (await GET()).json();
  assert.equal(initial.shell, "auto");
  assert.ok(initial.options.length > 0);
  await mkdir(join(agent, "pi-web"), { recursive: true });
  await writeFile(file, JSON.stringify({ background: "sea", fonts: { ui: "Example" } }));
  for (const option of initial.options) {
    const response = await PUT(request(JSON.stringify({ shell: option.value })));
    assert.equal(response.status, 200);
    assert.equal((await (await GET()).json()).shell, option.value);
    assert.equal(resolveTerminalShell().path, option.value);
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.background, "sea");
    assert.deepEqual(stored.fonts, { ui: "Example" });
  }
  assert.equal((await PUT(request('{"shell":"auto"}'))).status, 200);
  assert.ok(initial.options.some(option => option.value === resolveTerminalShell().path));
});

test("untrusted, malformed and unlisted shells cannot change settings", async () => {
  const before = await readFile(file, "utf8");
  for (const [body, headers, status] of [
    ['{"shell":"auto"}', { Origin: "https://untrusted.example" }, 403],
    ['{"shell":"auto"}', { "Content-Type": "text/plain" }, 415],
    ["{", {}, 400], ["null", {}, 400], ["[]", {}, 400], ['{"shell":42}', {}, 400],
    ['{"shell":""}', {}, 400], ['{"shell":"cmd.exe /c echo bad"}', {}, 400],
    ['{"shell":"/missing/terminal"}', {}, 400],
  ]) {
    assert.equal((await PUT(request(body, headers))).status, status);
    assert.equal(await readFile(file, "utf8"), before);
  }
});

test("a removed terminal stays visible as unavailable and cannot silently launch another shell", async () => {
  await writeFile(file, JSON.stringify({ terminalShell: "/missing/terminal", background: "sea" }));
  const settings = await (await GET()).json();
  assert.equal(settings.shell, "/missing/terminal");
  assert.equal(settings.unavailable, true);
  assert.throws(() => resolveTerminalShell(), /unavailable/);
  assert.equal((await PUT(request('{"shell":"auto"}'))).status, 200);
  assert.equal((await (await GET()).json()).unavailable, false);
});

test("damaged preferences are reported without overwriting the file", async () => {
  await writeFile(file, "{broken");
  assert.equal((await GET()).status, 500);
  assert.equal((await PUT(request('{"shell":"auto"}'))).status, 500);
  assert.equal(await readFile(file, "utf8"), "{broken");
});
