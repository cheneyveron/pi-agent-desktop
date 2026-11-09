#!/usr/bin/env node
/**
 * Fork-only: verifies that the *packaged* desktop server starts the main-session service
 * (desktop/main-session-launcher.cjs, scripts/stage-main-session.mjs) with the bundled Node.
 *
 * 1. Imports the service's lazily loaded modules from the staged tree (judge, dispatch,
 *    pi-runtime, the Pi SDK and ../lib/exact-system-prompt.ts), which a plain start never
 *    reaches: a missing file there would only show at the first judgment turn.
 * 2. Starts the staged desktop-server.cjs the way src-tauri/src/lib.rs does, on free ports
 *    (MAIN_SESSION_PORT too, never 30180), and waits for GET /api/main-session/health to
 *    answer ok:true through the Next proxy, with main-session.log in PI_DESKTOP_LOG_DIR.
 * 3. SIGKILLs the server (a crash: no exit handler runs) and checks that the service exits.
 *
 *   npm run desktop:prepare && node scripts/verify-packaged-main-session.mjs
 *
 * Runs against a throwaway HOME / PI_CODING_AGENT_DIR, never the user's data.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const resourcesDir = join(rootDir, "src-tauri", "resources");
const serverDir = join(resourcesDir, "server");
const mainSessionDir = join(serverDir, "main-session");

const NODE_CANDIDATES = [
  join(resourcesDir, "Pi Agent Server.app", "Contents", "MacOS", "node"),
  join(resourcesDir, "node", "node"),
  join(resourcesDir, "node", "node.exe"),
];

const STARTUP_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;

function fail(message) {
  console.error(`verify-packaged-main-session: ${message}`);
  process.exitCode = 1;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Imports the lazily loaded modules with the bundled Node from the staged service's directory. */
function importLazyModules(nodePath) {
  const url = (file) => JSON.stringify(pathToFileURL(join(mainSessionDir, file)).href);
  const script = `
    for (const file of [${url("judge.ts")}, ${url("dispatch.ts")}, ${url("pi-runtime.ts")}]) await import(file);
    const sdk = await import("@earendil-works/pi-coding-agent");
    const exact = await import(${JSON.stringify(pathToFileURL(join(serverDir, "lib", "exact-system-prompt.ts")).href)});
    if (typeof sdk.createAgentSessionServices !== "function" || typeof exact.createExactSystemPromptExtension !== "function") {
      throw new Error("unexpected exports");
    }
  `;
  return new Promise((resolve) => {
    const probe = spawn(nodePath, ["--input-type=module", "-e", script], { cwd: mainSessionDir, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    probe.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    probe.once("error", (error) => resolve({ error: error.message }));
    probe.once("exit", (code) => resolve(code === 0 ? { warnings: stderr.trim() } : { error: stderr.trim() || `exit code ${code}` }));
  });
}

async function getJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const nodePath = NODE_CANDIDATES.find((candidate) => existsSync(candidate));
  for (const required of ["desktop-server.cjs", "main-session-launcher.cjs", join("main-session", "server.mjs")]) {
    if (!nodePath || !existsSync(join(serverDir, required))) {
      fail(`no packaged server with ${required} found; run \`npm run desktop:prepare\` first.`);
      return;
    }
  }
  console.log(`runtime: ${nodePath}`);

  const imported = await importLazyModules(nodePath);
  if (imported.error) {
    fail(`the staged main-session modules cannot be imported: ${imported.error}`);
    return;
  }
  if (imported.warnings) console.log(`imports: warnings from the bundled Node:\n${imported.warnings}`);
  console.log("imports: judge, dispatch, pi-runtime, the Pi SDK and lib/exact-system-prompt.ts load from the staged tree.");

  const scratch = await mkdtemp(join(tmpdir(), "pi-packaged-main-session-"));
  const agentDir = join(scratch, ".pi", "agent");
  const logDir = join(scratch, "logs");
  await mkdir(agentDir, { recursive: true });

  const port = await freePort();
  let mainSessionPort = await freePort();
  while (mainSessionPort === port || mainSessionPort === 30180) mainSessionPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logChunks = [];
  const child = spawn(nodePath, [join(serverDir, "desktop-server.cjs")], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOME: scratch,
      USERPROFILE: scratch,
      PI_CODING_AGENT_DIR: agentDir,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      PI_WEB_PARENT_PID: String(process.pid),
      PI_DESKTOP_API_TOKEN: "verify-packaged-main-session",
      PI_DESKTOP_INSTANCE_ID: "verify-packaged-main-session",
      PI_DESKTOP_LOG_DIR: logDir,
      MAIN_SESSION_PORT: String(mainSessionPort),
      MAIN_SESSION_MEMHANA: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => logChunks.push(chunk.toString()));
  }
  const serverLog = () => logChunks.join("");
  const logTail = () => serverLog().split("\n").slice(-25).join("\n");
  let servicePid = null;

  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let health = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`the server exited early (code ${child.exitCode})`);
      health = await getJson(`${baseUrl}/api/main-session/health`);
      if (health.body?.ok === true) break;
      await sleep(500);
    }
    if (health?.body?.ok !== true) throw new Error(`/api/main-session/health never answered ok:true (last: ${JSON.stringify(health)})`);
    console.log(`proxy: GET /api/main-session/health → ${health.status} ${JSON.stringify(health.body)}`);
    const direct = await getJson(`http://127.0.0.1:${mainSessionPort}/health`);
    console.log(`service: GET 127.0.0.1:${mainSessionPort}/health → ${direct.status} ok=${direct.body?.ok}`);

    servicePid = Number(/main session started \(pid (\d+)/.exec(serverLog())?.[1]) || null;
    if (!servicePid) throw new Error("server.log does not report the main session's pid");
    const logFile = join(logDir, "main-session.log");
    if (!existsSync(logFile) || !readFileSync(logFile, "utf8").includes("[main-session] listening")) {
      throw new Error(`${logFile} does not record the service listening`);
    }
    console.log(`log: main-session.log written to PI_DESKTOP_LOG_DIR (service pid ${servicePid})`);

    child.kill("SIGKILL");
    const exitBy = Date.now() + EXIT_TIMEOUT_MS;
    while (isAlive(servicePid) && Date.now() < exitBy) await sleep(100);
    if (isAlive(servicePid)) throw new Error(`the main-session service (pid ${servicePid}) outlived the killed server`);
    const after = await getJson(`http://127.0.0.1:${mainSessionPort}/health`);
    if (after.body) throw new Error(`port ${mainSessionPort} still answers after the server was killed`);
    console.log("OK: the packaged server starts the main session, the proxy reaches it, and it exits when the server is killed.");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    console.error(`--- server log (tail) ---\n${logTail()}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (servicePid && isAlive(servicePid)) process.kill(servicePid, "SIGKILL");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", resolve);
      setTimeout(resolve, 3_000).unref();
    });
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
