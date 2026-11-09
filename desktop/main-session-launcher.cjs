"use strict";

// Fork-only: starts the main-session service (main-session/server.mjs, see
// docs/agents/main-session.md) beside the packaged desktop server, so the
// sidebar's 主会话 works without `npm run dev:all`. Called by
// desktop/server-launcher.cjs; staged next to it by scripts/prepare-desktop.mjs.
//
// - MAIN_SESSION=off: not started (same switch as dev:all).
// - A service already answering /health on MAIN_SESSION_PORT (30180) is reused.
// - The child runs on the same bundled Node (process.execPath) and stops with
//   this process: on Unix it shares the server's process group, which the
//   Rust shell signals on quit; everywhere it holds an IPC channel to this
//   process and exits when that channel closes (crash, SIGKILL, taskkill).
// - Output goes to main-session.log in PI_DESKTOP_LOG_DIR (the app log dir,
//   beside server.log); without it, to this process's own stdout/stderr.
// - Any failure only leaves the feature offline; the UI already handles that.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess = require("node:child_process");

const DEFAULT_PORT = 30180;
const LOG_FILE = "main-session.log";
const HEALTH_TIMEOUT_MS = 1_000;

/** The port the service binds and the Next proxy targets, or null when MAIN_SESSION_PORT is not a port. */
function mainSessionPort(env) {
  const raw = env.MAIN_SESSION_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** True when a main-session service answers GET /health with ok:true on the port. */
async function isMainSessionRunning(port, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * What to do at startup: {action: "off" | "missing" | "bad-port" | "reuse" | "start", port?}.
 * `probe(port)` reports whether a service already answers there.
 */
async function decideMainSession({ env, entry, exists = fs.existsSync, probe = isMainSessionRunning }) {
  if (env.MAIN_SESSION === "off") return { action: "off" };
  if (!exists(entry)) return { action: "missing" };
  const port = mainSessionPort(env);
  if (port === null) return { action: "bad-port" };
  if (await probe(port)) return { action: "reuse", port };
  return { action: "start", port };
}

/** The child's environment: the server's, minus what only the Next server or the shell should see. */
function childEnv(env, port) {
  const next = { ...env, MAIN_SESSION_PORT: String(port) };
  for (const name of Object.keys(next)) {
    // Next's serialized runtime config and the per-process desktop token stay
    // with the Next server; the service's tool subprocesses do not need them.
    if (name.startsWith("__NEXT_PRIVATE_") || name === "PI_DESKTOP_API_TOKEN") delete next[name];
  }
  return next;
}

/** Opens main-session.log for appending; null when there is no log dir or it cannot be written. */
function openLog(logDir) {
  if (!logDir) return null;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    return fs.openSync(path.join(logDir, LOG_FILE), "a");
  } catch {
    return null;
  }
}

/**
 * Starts (or reuses, or skips) the service. Resolves to the decision plus the
 * child when one was spawned; never rejects.
 */
async function startMainSession({
  serverDir,
  env = process.env,
  logDir = env.PI_DESKTOP_LOG_DIR,
  log = (message) => console.error(`[Pi Agent] ${message}`),
  spawn = childProcess.spawn,
  probe = isMainSessionRunning,
  nodePath = process.execPath,
} = {}) {
  const entry = path.join(serverDir, "main-session", "server.mjs");
  let decision;
  try {
    decision = await decideMainSession({ env, entry, probe });
  } catch (error) {
    log(`main session not started: ${error?.message ?? error}`);
    return { action: "error" };
  }
  switch (decision.action) {
    case "off":
      log("main session off (MAIN_SESSION=off)");
      return decision;
    case "missing":
      log(`main session not bundled (${entry} missing)`);
      return decision;
    case "bad-port":
      log(`main session not started: MAIN_SESSION_PORT=${env.MAIN_SESSION_PORT} is not a port`);
      return decision;
    case "reuse":
      log(`main session already running on 127.0.0.1:${decision.port}; reusing it`);
      return decision;
    default:
      break;
  }

  const logFd = openLog(logDir);
  const output = logFd ?? "inherit";
  try {
    if (logFd !== null) {
      fs.writeSync(logFd, `${new Date().toISOString()} [Pi Agent] starting main session on 127.0.0.1:${decision.port} (parent pid ${process.pid})\n`);
    }
    const child = spawn(nodePath, [entry], {
      cwd: serverDir,
      env: childEnv(env, decision.port),
      stdio: ["ignore", output, output, "ipc"],
      windowsHide: true,
    });
    child.once("error", (error) => log(`main session failed to start: ${error?.message ?? error}`));
    child.once("exit", (code, signal) => {
      log(`main session exited (${signal ?? `code ${code}`})${logFd !== null ? `; see ${LOG_FILE}` : ""}`);
    });
    // Neither the child nor its IPC channel may keep this process alive.
    child.unref();
    child.channel?.unref?.();
    // A normal exit of this process also takes the child down; a crash closes
    // the IPC channel, which main-session/server.mjs treats the same way.
    process.once("exit", () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    log(`main session started (pid ${child.pid ?? "?"}, 127.0.0.1:${decision.port})${logFd !== null ? `, log ${path.join(logDir, LOG_FILE)}` : ""}`);
    return { ...decision, child };
  } catch (error) {
    log(`main session failed to start: ${error?.message ?? error}`);
    return { action: "error" };
  } finally {
    // The child holds its own copy of the descriptor.
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        // already closed
      }
    }
  }
}

module.exports = { DEFAULT_PORT, LOG_FILE, mainSessionPort, isMainSessionRunning, decideMainSession, childEnv, startMainSession };
