import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const terminalSettingsStub = { resolveTerminalShell: () => ({ path: process.platform === "win32" ? "cmd.exe" : "/bin/sh", args: [] }) };

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { TERMINAL_RECONNECT_MS } = await jiti.import("./terminal-manager.ts");
const { GET } = await jiti.import("../app/api/terminal/[id]/events/route.ts");

async function terminalHarness(settings = terminalSettingsStub, spawnCalls = []) {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  const fakePty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  // Timer/SSE behavior uses a controlled PTY. The native integration check
  // below owns the real shell and waits for it to exit before timers are mocked.
  runInNewContext(outputText, {
    exports, globalThis, process: { ...process, once() {} },
    require(id) {
      if (id === "node-pty") return { spawn: (...args) => { spawnCalls.push(args); return fakePty; } };
      if (id === "./terminal-settings") return settings;
      return id === "./paths" ? paths : require(id);
    },
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    console,
  });
  return exports;
}

test("native module load failures are deferred until creation and include repair instructions", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, { exports, process, require(id) {
    if (id === "node-pty") throw new Error("Cannot find module pty.node");
    if (id === "./terminal-settings") return terminalSettingsStub;
    return id === "./paths" ? paths : require(id);
  } });
  assert.equal(exports.hasTerminal("missing"), false);
  assert.throws(() => exports.createTerminal(process.cwd(), 80, 24), (error) => {
    assert.match(error.message, /native terminal module/);
    assert.match(error.message, /npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts/);
    assert.match(error.message, /Cannot find module pty.node/);
    return true;
  });
});

test("shell environment defaults to UTF-8 locale when the host has none", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const spawnCalls = [];
  const fakePty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const fakeRequire = (id) => {
    if (id === "node-pty") return { spawn: (...args) => { spawnCalls.push(args); return fakePty; } };
    if (id === "./terminal-settings") return terminalSettingsStub;
    if (id === "./paths") return paths;
    return require(id);
  };
  const envWithoutLocale = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["LANG", "LC_ALL", "LC_CTYPE"].includes(k)));
  const exports = {};
  runInNewContext(outputText, { exports, process: { ...process, env: envWithoutLocale, once() {}, platform: process.platform }, require: fakeRequire, setTimeout, clearTimeout, console });
  exports.createTerminal(process.cwd(), 80, 24);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][2].env.LANG, "C.UTF-8");
});

test("shell environment preserves a case-insensitive Windows locale", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const spawnCalls = [];
  const fakePty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const fakeRequire = (id) => {
    if (id === "node-pty") return { spawn: (...args) => { spawnCalls.push(args); return fakePty; } };
    if (id === "./terminal-settings") return terminalSettingsStub;
    if (id === "./paths") return paths;
    return require(id);
  };
  const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["lang", "lc_all", "lc_ctype"].includes(key.toLowerCase())));
  rawEnv.lang = "zh_CN.UTF-8";
  const envWithLocale = new Proxy(rawEnv, {
    get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      const match = Object.keys(target).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      return match ? target[match] : undefined;
    },
  });
  const exports = {};
  runInNewContext(outputText, { exports, process: { ...process, env: envWithLocale, once() {}, platform: process.platform }, require: fakeRequire, setTimeout, clearTimeout, console });
  exports.createTerminal(process.cwd(), 80, 24);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][2].env.lang, "zh_CN.UTF-8");
  assert.equal("LANG" in spawnCalls[0][2].env, false);
});

test("shell environment omits the web login password", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const spawnCalls = [];
  const fakePty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const fakeRequire = (id) => {
    if (id === "node-pty") return { spawn: (...args) => { spawnCalls.push(args); return fakePty; } };
    if (id === "./terminal-settings") return terminalSettingsStub;
    if (id === "./paths") return paths;
    return require(id);
  };
  const env = { ...process.env, PI_WEB_PASSWORD: "web-login-password", PI_USER_SETTING: "preserved" };
  const exports = {};
  runInNewContext(outputText, { exports, process: { ...process, env, once() {}, platform: process.platform }, require: fakeRequire, setTimeout, clearTimeout, console });
  exports.createTerminal(process.cwd(), 80, 24);
  assert.equal(spawnCalls.length, 1);
  assert.equal("PI_WEB_PASSWORD" in spawnCalls[0][2].env, false);
  assert.equal(spawnCalls[0][2].env.PI_USER_SETTING, "preserved");
});

test("native PTY starts after install, reuses its process and supports forced close", async (t) => {
  const agent = await mkdtemp(join(tmpdir(), "pi-native-terminal-"));
  t.after(() => rm(agent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  // node-pty's ConPTY worker can outlive the shell. Give the native integration
  // its own process, and exit it only after the actual shell exit was observed.
  const program = `
    const assert = require('node:assert/strict');
    const { createJiti } = require('jiti');
    (async () => {
      const jiti = createJiti(process.cwd() + '/native-terminal-test.mjs');
      const terminal = await jiti.import('./lib/terminal-manager.ts');
      const id = terminal.createTerminal(process.cwd(), 80, 24);
      const record = globalThis.__piWebTerminals.get(id);
      const watchdog = setTimeout(() => process.exit(2), 12000);
      record.pty.onExit(() => {
        clearTimeout(watchdog);
        assert.equal(terminal.hasTerminal(id), false);
        console.log('NATIVE_TERMINAL_CLOSED');
        process.exit(0);
      });
      const subscription = record.pty.onData(() => {
        subscription.dispose();
        assert.ok(record.pty.pid > 0);
        assert.equal(terminal.getTerminalCwd(id), process.cwd());
        assert.equal(terminal.createTerminal(process.cwd(), 100, 30, id), id);
        assert.strictEqual(globalThis.__piWebTerminals.get(id), record);
        assert.throws(() => terminal.createTerminal(process.cwd() + '/other', 80, 24, id), /different workspace/);
        assert.ok(record.cleanupTimer);
        terminal.killTerminal(id, true);
      });
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", program], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 15000, windowsHide: true,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent },
  });
  assert.match(stdout, /NATIVE_TERMINAL_CLOSED/);
});

test("a changed default selects the next PTY without replacing an existing terminal", async (t) => {
  let selected = { path: "/bin/zsh", args: ["-l"] };
  const calls = [];
  const terminal = await terminalHarness({ resolveTerminalShell: () => selected }, calls);
  const first = terminal.createTerminal(process.cwd(), 80, 24);
  t.after(() => terminal.killTerminal(first, true));
  selected = { path: "/opt/homebrew/bin/pwsh", args: ["-NoLogo"] };
  assert.equal(terminal.createTerminal(process.cwd(), 80, 24, first), first);
  assert.equal(calls.length, 1);
  const second = terminal.createTerminal(process.cwd(), 80, 24);
  t.after(() => terminal.killTerminal(second, true));
  assert.deepEqual(calls.map(call => [call[0], call[1]]), [["/bin/zsh", ["-l"]], ["/opt/homebrew/bin/pwsh", ["-NoLogo"]]]);
});

test("connected terminals outlive the grace period; only the last disconnect starts expiry", async (t) => {
  const { createTerminal, subscribeTerminal, hasTerminal, killTerminal } = await terminalHarness();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const first = subscribeTerminal(id, () => {});
  const second = subscribeTerminal(id, () => {});
  first.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS * 2);
  assert.ok(hasTerminal(id));
  second.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS - 1);
  assert.ok(hasTerminal(id));
  const resumed = subscribeTerminal(id, () => {});
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.ok(hasTerminal(id));
  resumed.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.equal(hasTerminal(id), false);
});

test("unclaimed creations expire without requiring a browser cleanup request", async (t) => {
  const { createTerminal, hasTerminal, killTerminal } = await terminalHarness();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.equal(hasTerminal(id), false);
});

test("SSE resumes from Last-Event-ID and cancellation releases the connection lease", async (t) => {
  const { createTerminal, killTerminal } = await terminalHarness();
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  record.backlog = "old\r\nnew\r\n";
  record.offset = record.backlog.length;
  const request = new Request("http://localhost/events?after=0", { headers: { "Last-Event-ID": "5" } });
  const response = await GET(request, { params: Promise.resolve({ id }) });
  const reader = response.body.getReader();
  await reader.read();
  const replay = new TextDecoder().decode((await reader.read()).value);
  assert.match(replay, /id: 10\n/);
  assert.deepEqual(JSON.parse(replay.split("data: ")[1]), { type: "output", data: "new\r\n", offset: 10, reset: false });
  await reader.cancel();
  assert.equal(record.listeners.size, 0);
  assert.ok(record.cleanupTimer);
});

test("expired output cursors reset bounded history, while explicit close ends connected streams", async (t) => {
  const { createTerminal, subscribeTerminal, hasTerminal, killTerminal } = await terminalHarness();
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  record.backlog = "tail";
  record.offset = 100;
  const subscription = subscribeTerminal(id, () => {}, 10);
  assert.deepEqual({ ...subscription.output }, { type: "output", data: "tail", offset: 100, reset: true });
  subscription.unsubscribe();
  const response = await GET(new Request("http://localhost/events"), { params: Promise.resolve({ id }) });
  const reader = response.body.getReader();
  await reader.read();
  await reader.read();
  killTerminal(id);
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"closed"/);
  assert.equal((await reader.read()).done, true);
  assert.equal(record.listeners.size, 0);
  assert.equal(hasTerminal(id), false);
});
