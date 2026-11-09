import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isMainSessionRuntimeFile, moduleSpecifiers, packageName, stageMainSession } from "./stage-main-session.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const launcher = require("../desktop/main-session-launcher.cjs");

const exists = () => true;
const noService = async () => false;

test("MAIN_SESSION=off skips the service without probing", async () => {
  let probed = false;
  const decision = await launcher.decideMainSession({
    env: { MAIN_SESSION: "off" },
    entry: "/x/server.mjs",
    exists,
    probe: async () => (probed = true),
  });
  assert.deepEqual(decision, { action: "off" });
  assert.equal(probed, false);
});

test("a build without main-session/ is skipped, not an error", async () => {
  const decision = await launcher.decideMainSession({ env: {}, entry: "/x/server.mjs", exists: () => false, probe: noService });
  assert.deepEqual(decision, { action: "missing" });
});

test("a service already answering on the port is reused", async () => {
  const probed = [];
  const decision = await launcher.decideMainSession({
    env: { MAIN_SESSION_PORT: "31999" },
    entry: "/x/server.mjs",
    exists,
    probe: async (port) => (probed.push(port), true),
  });
  assert.deepEqual(decision, { action: "reuse", port: 31999 });
  assert.deepEqual(probed, [31999]);
});

test("otherwise the service starts on MAIN_SESSION_PORT, default 30180", async () => {
  assert.deepEqual(await launcher.decideMainSession({ env: {}, entry: "e", exists, probe: noService }), { action: "start", port: 30180 });
  assert.deepEqual(await launcher.decideMainSession({ env: { MAIN_SESSION_PORT: "4100" }, entry: "e", exists, probe: noService }), { action: "start", port: 4100 });
  assert.deepEqual(await launcher.decideMainSession({ env: { MAIN_SESSION_PORT: "nope" }, entry: "e", exists, probe: noService }), { action: "bad-port" });
  assert.equal(launcher.mainSessionPort({ MAIN_SESSION_PORT: "70000" }), null);
});

test("the health probe needs ok:true, and a dead port or another server is not the service", async () => {
  const reply = (status, body) => async () => ({ ok: status < 300, json: async () => body });
  assert.equal(await launcher.isMainSessionRunning(1, reply(200, { ok: true })), true);
  assert.equal(await launcher.isMainSessionRunning(1, reply(200, { ok: false })), false);
  assert.equal(await launcher.isMainSessionRunning(1, reply(404, {})), false);
  assert.equal(await launcher.isMainSessionRunning(1, async () => { throw new Error("ECONNREFUSED"); }), false);
});

test("the child keeps the server's env minus Next's private config and the desktop token", () => {
  const env = launcher.childEnv(
    { HOME: "/h", MAIN_SESSION_DIR: "/s", __NEXT_PRIVATE_STANDALONE_CONFIG: "{}", __NEXT_PRIVATE_ORIGIN: "x", PI_DESKTOP_API_TOKEN: "secret" },
    4100,
  );
  assert.deepEqual(env, { HOME: "/h", MAIN_SESSION_DIR: "/s", MAIN_SESSION_PORT: "4100" });
});

function fakeSpawn(calls) {
  return (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, unref() {}, kill() {}, channel: { unref() {} } });
    calls.push({ command, args, options, child });
    return child;
  };
}

test("startMainSession spawns the bundled node with an IPC channel and logs to main-session.log", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-main-session-launcher-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const serverDir = join(dir, "server");
  await mkdir(join(serverDir, "main-session"), { recursive: true });
  await writeFile(join(serverDir, "main-session", "server.mjs"), "");
  const logDir = join(dir, "logs");
  const calls = [];
  const lines = [];

  const result = await launcher.startMainSession({
    serverDir,
    env: { MAIN_SESSION_PORT: "4100", PI_DESKTOP_API_TOKEN: "secret" },
    logDir,
    log: (line) => lines.push(line),
    spawn: fakeSpawn(calls),
    probe: noService,
    nodePath: "/bundled/node",
  });

  assert.equal(result.action, "start");
  assert.equal(calls.length, 1);
  const [{ command, args, options }] = calls;
  assert.equal(command, "/bundled/node");
  assert.deepEqual(args, [join(serverDir, "main-session", "server.mjs")]);
  assert.equal(options.cwd, serverDir);
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio[0], "ignore");
  assert.equal(options.stdio[3], "ipc");
  assert.equal(typeof options.stdio[1], "number", "stdout goes to a file descriptor, not a pipe");
  assert.equal(options.stdio[1], options.stdio[2]);
  assert.equal(options.env.MAIN_SESSION_PORT, "4100");
  assert.equal(options.env.PI_DESKTOP_API_TOKEN, undefined);
  assert.match(readFileSync(join(logDir, "main-session.log"), "utf8"), /starting main session on 127\.0\.0\.1:4100/);
  assert.ok(lines.some((line) => line.includes("main session started (pid 4242")));
});

test("startMainSession falls back to the server's own output without a log dir", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-main-session-launcher-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "main-session"));
  await writeFile(join(dir, "main-session", "server.mjs"), "");
  const calls = [];
  await launcher.startMainSession({ serverDir: dir, env: {}, logDir: undefined, log: () => {}, spawn: fakeSpawn(calls), probe: noService });
  assert.deepEqual(calls[0].options.stdio, ["ignore", "inherit", "inherit", "ipc"]);
});

test("startMainSession never spawns when off or reusing, and a spawn failure only logs", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-main-session-launcher-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "main-session"));
  await writeFile(join(dir, "main-session", "server.mjs"), "");
  const calls = [];
  const lines = [];
  const log = (line) => lines.push(line);

  assert.equal((await launcher.startMainSession({ serverDir: dir, env: { MAIN_SESSION: "off" }, log, spawn: fakeSpawn(calls) })).action, "off");
  assert.equal((await launcher.startMainSession({ serverDir: dir, env: {}, log, spawn: fakeSpawn(calls), probe: async () => true })).action, "reuse");
  assert.equal(calls.length, 0);
  assert.ok(lines.some((line) => line.includes("already running on 127.0.0.1:30180")));

  const throwing = () => { throw new Error("EACCES"); };
  const failed = await launcher.startMainSession({ serverDir: dir, env: {}, logDir: join(dir, "logs"), log, spawn: throwing, probe: noService });
  assert.equal(failed.action, "error");
  assert.ok(lines.some((line) => line.includes("failed to start: EACCES")));
});

test("only runtime files of main-session/ ship with the desktop server", () => {
  for (const file of ["server.mjs", "server.ts", "package.json", "prompts/judge.md", "checkers/pr.ts", "checkers\\branch.ts"]) {
    assert.equal(isMainSessionRuntimeFile(file), true, file);
  }
  for (const file of ["server.test.mjs", "checkers.test.mjs", "test-helpers.mjs", "fixtures", "fixtures/demo-state.json"]) {
    assert.equal(isMainSessionRuntimeFile(file), false, file);
  }
});

test("module specifiers skip type-only and node: imports and keep dynamic ones", () => {
  const source = `
import { Type, type TSchema } from "typebox";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import {
  ask,
} from "./actions.ts";
export { x } from "../lib/x.ts";
const sdk = await import("@earendil-works/pi-ai/sub");
const { f } = await import("../lib/exact-system-prompt.ts");
`;
  const { relative, bare } = moduleSpecifiers(source);
  assert.deepEqual(relative.sort(), ["../lib/exact-system-prompt.ts", "../lib/x.ts", "./actions.ts"]);
  assert.deepEqual(bare.sort(), ["@earendil-works/pi-ai/sub", "typebox"]);
  assert.equal(packageName("@earendil-works/pi-ai/sub"), "@earendil-works/pi-ai");
  assert.equal(packageName("typebox/value"), "typebox");
});

test("stageMainSession ships the service, lib/exact-system-prompt.ts and typebox", async (t) => {
  const serverDir = await mkdtemp(join(os.tmpdir(), "pi-stage-main-session-"));
  t.after(() => rm(serverDir, { recursive: true, force: true }));
  // prepare-desktop.mjs overlays the Pi scope before this runs.
  const sdkDir = join(serverDir, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(sdkDir, { recursive: true });
  await writeFile(join(sdkDir, "package.json"), "{}");

  const staged = await stageMainSession({ rootDir, serverResourcesDir: serverDir });

  for (const file of ["server.mjs", "server.ts", "judge.ts", "pi-runtime.ts", "package.json", "prompts/judge.md", "checkers/index.ts"]) {
    assert.ok(existsSync(join(serverDir, "main-session", file)), file);
  }
  assert.ok(!existsSync(join(serverDir, "main-session", "fixtures")));
  assert.ok(!existsSync(join(serverDir, "main-session", "server.test.mjs")));
  assert.ok(!existsSync(join(serverDir, "main-session", "test-helpers.mjs")));
  assert.deepEqual(staged.outside, [join("lib", "exact-system-prompt.ts")]);
  assert.ok(existsSync(join(serverDir, "lib", "exact-system-prompt.ts")));
  assert.deepEqual(JSON.parse(await readFile(join(serverDir, "lib", "package.json"), "utf8")).type, "module");
  assert.ok(staged.packages.includes("typebox"));
  assert.ok(existsSync(join(serverDir, "node_modules", "typebox", "package.json")));
});

test("stageMainSession refuses a build where a Pi package the service imports is missing", async (t) => {
  const serverDir = await mkdtemp(join(os.tmpdir(), "pi-stage-main-session-"));
  t.after(() => rm(serverDir, { recursive: true, force: true }));
  await assert.rejects(stageMainSession({ rootDir, serverResourcesDir: serverDir }), /pi-coding-agent .* is missing from the staged server/);
});

test("the packaged launcher starts the main session after the Next server", async () => {
  const source = await readFile(join(rootDir, "desktop", "server-launcher.cjs"), "utf8");
  const nextRequire = source.indexOf('require("./server.js")');
  const mainSession = source.indexOf("main-session-launcher.cjs");
  assert.ok(nextRequire > 0 && mainSession > nextRequire);
  const prepare = await readFile(join(rootDir, "scripts", "prepare-desktop.mjs"), "utf8");
  assert.match(prepare, /stageMainSession\(\{ rootDir, serverResourcesDir \}\)/);
  assert.match(prepare, /"main-session-launcher\.cjs"/);
});
