// State of the main session: tasks, the append-only event log, close-outs, schedules and the
// per-segment "seen" marks, kept in memory and written through to ~/.pi/agent/main/.
// A store built without a directory keeps everything in memory (tests and /replay).

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Closeout, MainEvent, Schedule, Seen, Task } from "./types.ts";

export function defaultStateDir(): string {
  if (process.env.MAIN_SESSION_DIR) return process.env.MAIN_SESSION_DIR;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "main");
}

/** What the user chose for the service (settings.json). Written only through POST /model. */
export interface ServiceSettings {
  /** `provider/modelId` of the model for judgment turns and read-only dispatches; absent = none. */
  model?: string;
  modelSetAt?: string;
}

/** Service bookkeeping that is not part of any task. */
export interface ServiceState {
  launchedAt?: string;
  lastTickDate?: string;
  lastCheckAt?: string;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function newEventId(): string {
  return `e_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export class Store {
  readonly dir: string | null;
  private tasks = new Map<string, Task>();
  private events: MainEvent[] = [];
  private eventsById = new Map<string, MainEvent>();
  private closeouts = new Map<string, Closeout[]>();
  schedules: Schedule[] = [];
  seen: Seen = {};
  state: ServiceState = {};
  settings: ServiceSettings = {};

  constructor(dir: string | null) {
    this.dir = dir;
    if (dir) this.load(dir);
  }

  private load(dir: string): void {
    mkdirSync(join(dir, "closeouts"), { recursive: true });
    const tasks = readJson<{ tasks?: Task[] }>(join(dir, "tasks.json"), {}).tasks ?? [];
    for (const task of tasks) this.tasks.set(task.id, task);
    const eventsPath = join(dir, "events.jsonl");
    if (existsSync(eventsPath)) {
      for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.indexEvent(JSON.parse(line) as MainEvent);
        } catch {
          // A torn last line from a crash is skipped; every complete line is kept.
        }
      }
    }
    for (const name of readdirSync(join(dir, "closeouts"))) {
      if (!name.endsWith(".json")) continue;
      const list = readJson<Closeout[]>(join(dir, "closeouts", name), []);
      if (Array.isArray(list) && list.length) this.closeouts.set(name.slice(0, -5), list);
    }
    this.schedules = readJson<Schedule[]>(join(dir, "schedules.json"), []);
    this.seen = readJson<Seen>(join(dir, "seen.json"), {});
    this.state = readJson<ServiceState>(join(dir, "state.json"), {});
    const settings = readJson<ServiceSettings | null>(join(dir, "settings.json"), {});
    this.settings = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  }

  private indexEvent(event: MainEvent): void {
    // The log is append-only; a re-written event (same id) replaces the earlier copy in memory.
    if (this.eventsById.has(event.id)) {
      const index = this.events.findIndex((e) => e.id === event.id);
      if (index >= 0) this.events[index] = event;
    } else {
      this.events.push(event);
    }
    this.eventsById.set(event.id, event);
  }

  // ── tasks ──────────────────────────────────────────────────────────────

  listTasks(): Task[] {
    return [...this.tasks.values()];
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  hasTask(id: string): boolean {
    return this.tasks.has(id);
  }

  putTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.saveTasks();
  }

  deleteTask(id: string): void {
    this.tasks.delete(id);
    this.saveTasks();
  }

  saveTasks(): void {
    if (!this.dir) return;
    writeJsonAtomic(join(this.dir, "tasks.json"), { version: 1, tasks: this.listTasks() });
  }

  // ── events ─────────────────────────────────────────────────────────────

  addEvent(partial: Omit<MainEvent, "id" | "t"> & { id?: string; t?: string }): MainEvent {
    const event: MainEvent = {
      ...partial,
      id: partial.id ?? newEventId(),
      t: partial.t ?? new Date().toISOString(),
    };
    this.writeEvent(event);
    if (event.task) {
      const task = this.tasks.get(event.task);
      if (task && !task.log.includes(event.id)) {
        task.log.push(event.id);
        this.saveTasks();
      }
    }
    return event;
  }

  /** Persist a changed event (an ask that was answered, an archive that was cancelled). */
  rewriteEvent(event: MainEvent): void {
    this.writeEvent(event);
  }

  private writeEvent(event: MainEvent): void {
    this.indexEvent(event);
    if (this.dir) appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
  }

  getEvent(id: string): MainEvent | undefined {
    return this.eventsById.get(id);
  }

  listEvents(): MainEvent[] {
    return this.events;
  }

  eventsSince(since: string | undefined): MainEvent[] {
    if (!since) return [...this.events];
    return this.events.filter((e) => e.t > since);
  }

  eventsForTask(taskId: string): MainEvent[] {
    return this.events.filter((e) => e.task === taskId || (Array.isArray(e.data?.tasks) && e.data.tasks.includes(taskId)));
  }

  // ── close-outs ─────────────────────────────────────────────────────────

  addCloseout(closeout: Closeout): void {
    const list = this.closeouts.get(closeout.sessionId) ?? [];
    list.push(closeout);
    this.closeouts.set(closeout.sessionId, list);
    if (this.dir) writeJsonAtomic(join(this.dir, "closeouts", `${safeName(closeout.sessionId)}.json`), list);
  }

  closeoutsForSession(sessionId: string): Closeout[] {
    return this.closeouts.get(sessionId) ?? [];
  }

  // ── small files ────────────────────────────────────────────────────────

  saveSchedules(): void {
    if (this.dir) writeJsonAtomic(join(this.dir, "schedules.json"), this.schedules);
  }

  saveSeen(): void {
    if (this.dir) writeJsonAtomic(join(this.dir, "seen.json"), this.seen);
  }

  saveState(): void {
    if (this.dir) writeJsonAtomic(join(this.dir, "state.json"), this.state);
  }

  saveSettings(): void {
    if (this.dir) writeJsonAtomic(join(this.dir, "settings.json"), this.settings);
  }

  /** Append a line to a side file (memory outbox); dropped when the store is in memory. */
  appendLine(name: string, value: unknown): void {
    if (this.dir) appendFileSync(join(this.dir, name), `${JSON.stringify(value)}\n`);
  }
}

function safeName(id: string): string {
  return id.replace(/[^\w.-]/g, "_");
}
