// The main-session process: one Store, the action context, the judge, and the timers (a
// one-minute loop that runs the daily tick, the checkers every ten minutes, due schedules and
// the 48-hour archive rule). HTTP handlers in http.ts call the methods here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMe, isOpenAsk, processPendingArchives, type Ctx, type DispatchRequest, type DispatchResult, type StreamType } from "./actions.ts";
import { chat, type ChatMessage, type ChatReply } from "./chat.ts";
import { fireAfterSession, runCheckers } from "./checkers/index.ts";
import { realExec, type Exec } from "./checkers/exec.ts";
import { localClock, type DayClock } from "./dates.ts";
import { buildDigest, defaultNarrative, storedDigest, suggestIdleArchives } from "./digest.ts";
import { intakeCloseout, parseCloseout, type IntakeResult } from "./intake.ts";
import { Judge, type JudgeRunner } from "./judge.ts";
import { createMemhanaSink, type MemorySink } from "./memory.ts";
import { checkConfiguredModel, envModelRef, formatModelRef, ModelChoiceError, parseModelRef } from "./pi-runtime.ts";
import { Store } from "./store.ts";
import type { DigestLine, MainEvent, ModelRef, ModelSource, Segment, Task } from "./types.ts";
import { decorateTask } from "./view.ts";

export const SERVICE_VERSION = "1.0.0";
const CHECK_INTERVAL_MS = 10 * 60_000;
const LOOP_INTERVAL_MS = 60_000;

export interface ServiceOptions {
  store: Store;
  now?: () => Date;
  clock?: DayClock;
  judgeRunner?: JudgeRunner;
  dispatcher?: (request: DispatchRequest) => Promise<DispatchResult>;
  memory?: MemorySink;
  exec?: Exec;
  /** Local time of the daily tick. Default 09:00 (MAIN_SESSION_TICK=HH:MM). */
  tickAt?: { hour: number; minute: number };
  /** Disable the timers (tests drive ticks directly). */
  timers?: boolean;
  /** MAIN_SESSION_MODEL (`provider/modelId`): overrides the saved choice. Default: the env var. */
  envModel?: string | null;
  /** Save-time check of a chosen model. Default: the Pi registry has it and its provider is signed in. */
  checkModel?: (ref: ModelRef) => Promise<void>;
}

/** The model in effect for judgment turns and dispatches (GET/POST /model, part of /health). */
export interface ModelChoice {
  /** `provider/modelId`, or null: no model turns run until one is chosen. */
  ref: string | null;
  source: ModelSource | null;
  setAt?: string;
}

export type Listener = (type: StreamType, data: unknown) => void;

function parseTickAt(value: string | undefined): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : { hour: 9, minute: 0 };
}

export class MainSessionService {
  readonly store: Store;
  readonly ctx: Ctx;
  readonly judge: Judge;
  readonly since = new Date().toISOString();
  private listeners = new Set<Listener>();
  private exec: Exec;
  private tickAt: { hour: number; minute: number };
  private loop?: ReturnType<typeof setInterval>;
  private checking = false;
  private chatLog: ChatMessage[] = [];
  private envModel: ModelRef | null;
  private checkModel: (ref: ModelRef) => Promise<void>;
  private modelWrites: Promise<unknown> = Promise.resolve();

  constructor(options: ServiceOptions) {
    this.store = options.store;
    // A malformed MAIN_SESSION_MODEL refuses to start; an unset one leaves the saved choice in charge.
    this.envModel = envModelRef(options.envModel === undefined ? process.env.MAIN_SESSION_MODEL : options.envModel ?? undefined);
    this.checkModel = options.checkModel ?? checkConfiguredModel;
    const dispatcher = options.dispatcher;
    this.exec = options.exec ?? realExec;
    this.tickAt = options.tickAt ?? parseTickAt(process.env.MAIN_SESSION_TICK);
    this.ctx = {
      store: this.store,
      now: options.now ?? (() => new Date()),
      clock: options.clock ?? localClock,
      emit: (type, data) => this.broadcast(type, data),
      memory: options.memory ?? createMemhanaSink(this.store),
      ...(dispatcher ? {
        dispatch: (request: DispatchRequest) => {
          const model = this.currentModel();
          return model
            ? dispatcher({ ...request, model })
            : Promise.resolve({ ok: false, result: "no model is chosen for the main session; read-only checks are paused" });
        },
      } : {}),
      onTrigger: (trigger) => {
        if (trigger.kind === "dispatch_result") void this.judge.run({ kind: "dispatch_result", ...(trigger.task ? { task: trigger.task } : {}), ...(trigger.eventId ? { eventId: trigger.eventId } : {}) });
      },
    };
    this.judge = new Judge(this.ctx, options.judgeRunner, () => this.currentModel());
    this.chatLog = this.loadChat();
    if (!this.store.state.launchedAt) {
      this.store.state.launchedAt = this.ctx.now().toISOString();
      this.store.saveState();
    }
    if (options.timers !== false) this.startTimers();
  }

  // ── stream ─────────────────────────────────────────────────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(type: StreamType, data: unknown): void {
    if (this.listeners.size === 0) return;
    if (type === "task" && data && typeof data === "object" && "task" in data) {
      const task = (data as { task: Task }).task;
      data = { task: decorateTask(this.store, this.store.getTask(task.id) ?? task) };
    }
    for (const listener of this.listeners) {
      try { listener(type, data); } catch { /* a broken client must not stop the others */ }
    }
  }

  // ── timers ─────────────────────────────────────────────────────────────

  startTimers(): void {
    if (this.loop) return;
    // First pass shortly after start: catch up a missed tick and re-send queued memory.
    setTimeout(() => { void this.onLoop(); void this.ctx.memory.flushOutbox?.(); }, 2_000).unref?.();
    this.loop = setInterval(() => { void this.onLoop(); }, LOOP_INTERVAL_MS);
    this.loop.unref?.();
  }

  stopTimers(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = undefined;
  }

  async onLoop(): Promise<void> {
    const now = this.ctx.now();
    processPendingArchives(this.ctx);
    const lastCheck = this.store.state.lastCheckAt ? Date.parse(this.store.state.lastCheckAt) : 0;
    if (now.getTime() - lastCheck >= CHECK_INTERVAL_MS) await this.runChecks();
    else await this.runChecks({ git: false, gh: false });
    const today = this.ctx.clock.day(now);
    const tickTime = this.ctx.clock.at(today, this.tickAt.hour, this.tickAt.minute);
    if (now >= tickTime && this.store.state.lastTickDate !== today) await this.dailyTick(today);
  }

  /** Run checkers; changes go to the judge. `git`/`gh` false skips the network checks. */
  async runChecks(options: { git?: boolean; gh?: boolean } = {}): Promise<MainEvent[]> {
    if (this.checking) return [];
    this.checking = true;
    try {
      const network = options.git !== false || options.gh !== false;
      const { events } = await runCheckers(this.ctx, this.exec, options);
      if (network) {
        this.store.state.lastCheckAt = this.ctx.now().toISOString();
        this.store.saveState();
      }
      for (const event of events) {
        if (event.action === "checker" && event.task) void this.judge.run({ kind: "checker", task: event.task, eventId: event.id });
      }
      return events;
    } finally {
      this.checking = false;
    }
  }

  /** Make today's digest (once a day) and let the judge word it. */
  async dailyTick(date: string): Promise<{ date: string; lines: DigestLine[]; narrative: string }> {
    const existing = storedDigest(this.store, date);
    if (existing) return existing;
    this.store.state.lastTickDate = date;
    this.store.saveState();
    processPendingArchives(this.ctx);
    suggestIdleArchives(this.ctx, date);
    const launch = !this.store.listEvents().some((e) => e.action === "digest" && e.data?.lines);
    const digest = buildDigest(this.ctx, { date, clock: this.ctx.clock, launch });
    if (this.judge.available) void this.judge.run({ kind: "daily_tick", date, digestEventId: digest.event.id });
    return digest;
  }

  // ── model choice ───────────────────────────────────────────────────────

  /** MAIN_SESSION_MODEL, else the saved choice, else null (no model turns). Read on every turn. */
  currentModel(): ModelRef | null {
    if (this.envModel) return this.envModel;
    try {
      return parseModelRef(this.store.settings.model);
    } catch {
      return null;
    }
  }

  modelChoice(): ModelChoice {
    const model = this.currentModel();
    if (!model) return { ref: null, source: null };
    if (this.envModel) return { ref: formatModelRef(model), source: "env" };
    return { ref: formatModelRef(model), source: "settings", ...(this.store.settings.modelSetAt ? { setAt: this.store.settings.modelSetAt } : {}) };
  }

  /**
   * POST /model: save `provider/modelId` (checked against the Pi registry first) or null. The
   * next turn uses it; nothing restarts. Refused while MAIN_SESSION_MODEL is set. Writes are
   * serialised so a slow check cannot land after a later choice.
   */
  setModel(value: unknown): Promise<ModelChoice> {
    const next = this.modelWrites.then(async () => {
      if (this.envModel) throw new ModelChoiceError(`MAIN_SESSION_MODEL=${formatModelRef(this.envModel)} is set for this process; unset it to choose the model here`, 409);
      const ref = parseModelRef(value);
      if (ref) await this.checkModel(ref);
      if (ref) this.store.settings = { ...this.store.settings, model: formatModelRef(ref), modelSetAt: this.ctx.now().toISOString() };
      else {
        const { model: _model, modelSetAt: _at, ...rest } = this.store.settings;
        this.store.settings = rest;
      }
      this.store.saveSettings();
      // The last error described the previous choice; a new (or re-saved) one starts clean.
      this.judge.lastError = undefined;
      return this.modelChoice();
    });
    this.modelWrites = next.catch(() => undefined);
    return next;
  }

  // ── API operations ─────────────────────────────────────────────────────

  health() {
    return {
      ok: true as const, since: this.since, version: SERVICE_VERSION,
      model: this.modelChoice(),
      judge: {
        enabled: this.judge.enabled, available: this.judge.available, turns: this.judge.turns,
        ...(this.judge.lastError ? { lastError: this.judge.lastError } : {}),
      },
    };
  }

  listTasks(status?: string) {
    const statuses = status ? status.split(",") : ["need", "watch", "done"];
    const tasks = this.store.listTasks().filter((t) => statuses.includes(t.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((t) => decorateTask(this.store, t));
    const newSince: Record<Segment, number> = { need: 0, watch: 0, done: 0 };
    for (const t of this.store.listTasks()) {
      if (t.status === "archived") continue;
      const seenAt = this.store.seen[t.status as Segment];
      if (!seenAt || t.updatedAt > seenAt) newSince[t.status as Segment]++;
    }
    return { tasks, seen: this.store.seen, newSince };
  }

  taskDetail(task: Task) {
    const events = this.store.eventsForTask(task.id);
    const closeouts = task.sessions.flatMap((s) => this.store.closeoutsForSession(s));
    return { task: decorateTask(this.store, task), events, closeouts, openAsks: events.filter(isOpenAsk), contextPack: contextPack(task, events) };
  }

  async intake(body: unknown): Promise<IntakeResult> {
    const closeout = parseCloseout(body);
    const result = await intakeCloseout(this.ctx, closeout);
    if (!result.duplicate) {
      fireAfterSession(this.ctx, closeout.sessionId);
      void this.judge.run(
        { kind: "closeout", ...(result.task ? { task: result.task.id } : {}), eventId: result.event.id, sessionId: closeout.sessionId },
        this.store.listEvents().filter((e) => e.t >= result.event.t),
      );
    }
    return result;
  }

  markSeen(segment: string) {
    if (segment !== "need" && segment !== "watch" && segment !== "done") throw Object.assign(new Error("segment must be need, watch or done"), { status: 400 });
    this.store.seen[segment] = this.ctx.now().toISOString();
    this.store.saveSeen();
    return { seen: this.store.seen };
  }

  async digest(date: string | undefined) {
    const today = this.ctx.clock.day(this.ctx.now());
    const day = date ?? today;
    const stored = storedDigest(this.store, day);
    if (stored) return stored;
    if (day === today) {
      const tickTime = this.ctx.clock.at(today, this.tickAt.hour, this.tickAt.minute);
      if (this.ctx.now() >= tickTime) return this.dailyTick(today);
      return { date: day, lines: [], narrative: `今天的摘要 ${String(this.tickAt.hour).padStart(2, "0")}:${String(this.tickAt.minute).padStart(2, "0")} 生成。`, pending: true };
    }
    return { date: day, lines: [], narrative: defaultNarrative([]) };
  }

  async chat(text: string): Promise<ChatReply> {
    const userMessage: ChatMessage = { role: "user", text, t: this.ctx.now().toISOString() };
    this.appendChat(userMessage);
    const result = await chat(this.ctx, this.judge, text);
    this.appendChat({ role: "main", text: result.reply, t: this.ctx.now().toISOString(), cites: result.cites });
    return result;
  }

  chatHistory(): { messages: ChatMessage[] } {
    return { messages: this.chatLog.slice(-200) };
  }

  sessionStarted(sessionId: string, taskId: string | undefined) {
    const task = taskId ? this.store.getTask(taskId) : undefined;
    if (taskId && !task) throw Object.assign(new Error(`no task ${taskId}`), { status: 404 });
    if (task && !task.sessions.includes(sessionId)) {
      task.sessions.unshift(sessionId);
      task.updatedAt = this.ctx.now().toISOString();
      this.store.saveTasks();
      this.broadcast("task", { task });
    }
    const event = this.store.addEvent({
      ...(task ? { task: task.id } : {}), action: "assign", auto: false, t: this.ctx.now().toISOString(),
      why: "user opened a session for the task", data: { session: sessionId, thread: task?.id ?? "none", started: true },
    });
    this.broadcast("event", event);
    return { ok: true, ...(task ? { task } : {}), event };
  }

  private loadChat(): ChatMessage[] {
    if (!this.store.dir) return [];
    try {
      return readFileSync(join(this.store.dir, "chat.jsonl"), "utf8").split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as ChatMessage]; } catch { return []; }
      });
    } catch {
      return [];
    }
  }

  private appendChat(message: ChatMessage): void {
    this.chatLog.push(message);
    this.store.appendLine("chat.jsonl", message);
  }
}

/** The first message of a session opened for a task: where it stands, open questions, next three. */
export function contextPack(task: Task, events: MainEvent[]): string {
  const asks = events.filter(isOpenAsk).map((e) => `- ${e.data.question}`);
  // Questions to the user are already asks; waits on PRs/deploys repeat their next step.
  const open = task.open.filter((o) => !isMe(o.who) && !task.waits.some((w) => w.what === o.question)).map((o) => `- ${o.question}（${o.who}）`);
  const pending = task.next.filter((n) => !n.done);
  const next = pending.slice(0, 3).map((n) => `- ${n.text}${n.on ? `（条件：${n.on}）` : ""}`);
  const waits = task.waits.filter((w) => !w.closed && !pending.some((n) => n.text === w.what)).map((w) => `- 等 ${w.who}：${w.what}`);
  return [
    `继续任务 ${task.id}：${task.title}`,
    task.repo ? `仓库：${task.repo}${task.branch ? `（分支 ${task.branch}）` : ""}` : "",
    task.stands ? `\n现状：${task.stands}` : "",
    asks.length || open.length ? `\n未决问题：\n${[...asks, ...open].join("\n")}` : "",
    waits.length ? `\n在等：\n${waits.join("\n")}` : "",
    next.length ? `\n下一步：\n${next.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
