import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_UPDATE_PROJECTS, getLatestAppRelease } from "@/lib/app-updates";
import { APP_VERSION } from "@/lib/branding";
import {
  formatUpdateRequest,
  getUpdaterDir,
  isStrictVersion,
  parseUpdaterStatus,
  type UpdaterStatusFile,
} from "@/lib/server-update-protocol";

/**
 * Self-update of a Docker-deployed server. This process never touches Docker:
 * it writes `request` into a directory shared with the updater sidecar
 * (deploy/docker/updater.sh), which pulls the new image, recreates this
 * container and writes `status`. Both files are plain `key=value` lines so the
 * sidecar needs no JSON parser.
 */

export type ServerUpdatePhase =
  | "idle"
  | "checking"
  | "waiting"
  | "requested"
  | "pulling"
  | "restarting"
  | "failed";

export interface ServerUpdateStatus {
  phase: ServerUpdatePhase;
  targetVersion?: string;
  error?: string;
}

export interface ServerUpdateState {
  /** True only when an updater sidecar directory is configured. */
  supported: boolean;
  currentVersion: string;
  status: ServerUpdateStatus;
}

interface UpdateRun {
  status: ServerUpdateStatus;
  promise: Promise<void> | null;
}

declare global {
  var __piServerUpdate: UpdateRun | undefined;
}

const REQUEST_FILE = "request";
const STATUS_FILE = "status";
const IDLE_WAIT_MS = 10 * 60 * 1000;
const IDLE_POLL_MS = 2_000;
const PICKUP_TIMEOUT_MS = 60 * 1000;
const UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const STATUS_POLL_MS = 1_000;

export class ServerUpdateError extends Error {
  constructor(message: string, readonly code: "unsupported" | "up-to-date") {
    super(message);
  }
}

function getRun(): UpdateRun {
  globalThis.__piServerUpdate ??= { status: { phase: "idle" }, promise: null };
  return globalThis.__piServerUpdate;
}

export function isServerSelfUpdateSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  return getUpdaterDir(env) !== null;
}

async function readUpdaterStatus(dir: string): Promise<UpdaterStatusFile | null> {
  try {
    return parseUpdaterStatus(await readFile(join(dir, STATUS_FILE), "utf8"));
  } catch {
    return null;
  }
}

async function writeRequest(dir: string, id: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // A previous run's verdict must not be mistaken for this one.
  await rm(join(dir, STATUS_FILE), { force: true });
  const target = join(dir, REQUEST_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, formatUpdateRequest(id, version), { mode: 0o644 });
  await rename(temporary, target);
}

export async function getServerUpdateState(): Promise<ServerUpdateState> {
  const dir = getUpdaterDir();
  const run = getRun();
  let status: ServerUpdateStatus = { ...run.status };
  // After a rolled-back update the recreated server has no memory of the run.
  if (dir && !run.promise && status.phase === "idle") {
    const file = await readUpdaterStatus(dir);
    if (file?.phase === "failed") {
      status = { phase: "failed", targetVersion: file.version, error: file.error ?? "Update failed." };
    }
  }
  return { supported: dir !== null, currentVersion: APP_VERSION, status };
}

/** Starts a self-update unless one is already running; returns the live state. */
export async function startServerUpdate(): Promise<ServerUpdateState> {
  const dir = getUpdaterDir();
  if (!dir) {
    throw new ServerUpdateError("No update service is configured for this server.", "unsupported");
  }
  const run = getRun();
  if (run.promise) return getServerUpdateState();

  run.status = { phase: "checking" };
  run.promise = performUpdate(run, dir)
    .catch((error) => {
      run.status = {
        phase: "failed",
        targetVersion: run.status.targetVersion,
        error: error instanceof Error ? error.message : String(error),
      };
    })
    .finally(() => {
      run.promise = null;
    });
  return getServerUpdateState();
}

async function performUpdate(run: UpdateRun, dir: string): Promise<void> {
  const release = await getLatestAppRelease(APP_UPDATE_PROJECTS[0]);
  if (!release.updateAvailable || !release.latestVersion) {
    throw new ServerUpdateError("This server already runs the latest release.", "up-to-date");
  }
  // The version becomes an image tag in a shell script: only plain x.y.z.
  const version = release.latestVersion;
  if (!isStrictVersion(version)) throw new Error(`Unsupported release version: ${version}`);

  run.status = { phase: "waiting", targetVersion: version };
  await waitUntilIdle();

  const id = randomUUID();
  await writeRequest(dir, id, version);
  run.status = { phase: "requested", targetVersion: version };
  await followUpdater(run, dir, id, version);
}

async function followUpdater(run: UpdateRun, dir: string, id: string, version: string): Promise<void> {
  const startedAt = Date.now();
  let pickedUp = false;
  for (;;) {
    const file = await readUpdaterStatus(dir);
    if (file?.id === id) {
      pickedUp = true;
      if (file.phase === "failed") throw new Error(file.error ?? "The update failed and was rolled back.");
      if (file.phase === "done") {
        run.status = { phase: "idle" };
        return;
      }
      if (file.phase === "pulling" || file.phase === "restarting") {
        run.status = { phase: file.phase, targetVersion: version };
      }
    }
    const elapsed = Date.now() - startedAt;
    if (!pickedUp && elapsed > PICKUP_TIMEOUT_MS) {
      await rm(join(dir, REQUEST_FILE), { force: true }).catch(() => {});
      throw new Error("The update service did not respond. Is the updater container running?");
    }
    if (elapsed > UPDATE_TIMEOUT_MS) throw new Error("The update took too long.");
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
  }
}

async function waitUntilIdle(): Promise<void> {
  const { getRunningRpcSessionIds } = await import("@/lib/rpc-manager");
  const deadline = Date.now() + IDLE_WAIT_MS;
  while (getRunningRpcSessionIds().length > 0) {
    if (Date.now() > deadline) {
      throw new Error("Sessions are still running. Press Upgrade again once they finish.");
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }
}
