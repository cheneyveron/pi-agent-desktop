// The main session's fixed action set (ARCH §4): assign, update, dispatch_readonly, ask,
// archive, remember, digest, insert, schedule — plus the user's side of an ask (answer, undo).
// Every action writes one event with its reason. None of them touches a repository or runs a
// command: dispatch_readonly hands a read-only step to a guarded session (dispatch.ts).

import { createHash, randomUUID } from "node:crypto";
import { addAliases, findByAlias } from "./aliases.ts";
import type { DayClock } from "./dates.ts";
import type { MemoryRecord, MemorySink } from "./memory.ts";
import type { Store } from "./store.ts";
import type { AskData, MainEvent, ModelRef, NextItem, Schedule, Task, TaskStatus, Wait } from "./types.ts";

export type StreamType = "task" | "digest" | "insert" | "event" | "chat";

export interface DispatchRequest {
  task: Task;
  step: string;
  /** Set by the service: the main session's chosen model when the dispatch starts. */
  model?: ModelRef;
}

export interface DispatchResult {
  ok: boolean;
  result: string;
  sessionId?: string;
  /** The read-only check found something that should change the plan (a failed verification). */
  failed?: boolean;
  blocked?: string[];
}

export interface Ctx {
  store: Store;
  now(): Date;
  clock: DayClock;
  emit(type: StreamType, data: unknown): void;
  memory: MemorySink;
  dispatch?: (request: DispatchRequest) => Promise<DispatchResult>;
  /** Called after an action that should get a judgment turn (a dispatch result). */
  onTrigger?(trigger: { kind: string; task?: string; eventId?: string }): void;
}

export class ActionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const ARCHIVE_GRACE_MS = 48 * 3_600_000;
export const UNDO_WINDOW_MS = 5 * 60_000;
const ME = new Set(["me", "user", "cheney", "你", "用户", "我"]);

export function isMe(who: string | undefined): boolean {
  return Boolean(who && ME.has(who.trim().toLowerCase()));
}

export function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function nowIso(ctx: Ctx): string {
  return ctx.now().toISOString();
}

function snapshot(task: Task): Task {
  return JSON.parse(JSON.stringify(task)) as Task;
}

export function requireTask(ctx: Ctx, id: string): Task {
  const task = ctx.store.getTask(id) ?? findByAlias(ctx.store.listTasks(), id);
  if (!task) throw new ActionError(`no task ${id}`, 404);
  return task;
}

function touch(ctx: Ctx, task: Task): void {
  task.updatedAt = nowIso(ctx);
  ctx.store.saveTasks();
  ctx.emit("task", { task });
}

function record(ctx: Ctx, event: Omit<MainEvent, "id" | "t">): MainEvent {
  const saved = ctx.store.addEvent({ ...event, t: nowIso(ctx) });
  ctx.emit("event", saved);
  return saved;
}

export function newTask(ctx: Ctx, id: string, title: string, extra: Partial<Task> = {}): Task {
  const t = nowIso(ctx);
  const task: Task = {
    id, aliases: [], title, status: "watch", stands: "", next: [], waits: [], artifacts: [],
    sessions: [], open: [], log: [], createdAt: t, updatedAt: t, ...extra,
  };
  ctx.store.putTask(task);
  return task;
}

// ── asks ─────────────────────────────────────────────────────────────────

export function isOpenAsk(event: MainEvent): boolean {
  return event.action === "ask" && !event.data?.answeredBy && !event.data?.cancelled;
}

export function openAsks(store: Store, taskId: string): MainEvent[] {
  return store.eventsForTask(taskId).filter(isOpenAsk);
}

export function ask(ctx: Ctx, input: AskData & { task: string; why: string; auto?: boolean }): MainEvent {
  const task = requireTask(ctx, input.task);
  const key = input.key ?? `ask:${task.id}:${shortHash(input.question)}`;
  const existing = openAsks(ctx.store, task.id).find((e) => e.data.key === key);
  if (existing) return existing;
  const data: AskData = {
    question: input.question,
    ...(input.chips?.length ? { chips: input.chips } : {}),
    ...(input.immediate ? { immediate: true } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.tasks ? { tasks: input.tasks } : {}),
    ...(input.write ? { write: true } : {}),
    ...(input.since ? { since: input.since } : {}),
    key,
  };
  const event = record(ctx, { task: task.id, action: "ask", auto: input.auto ?? true, why: input.why, data });
  if (input.category !== "archive_suggest" && input.category !== "did_for_you" && task.status !== "archived") {
    task.status = "need";
    if (/\bP1\b/.test(input.question)) task.priority = "P1";
    touch(ctx, task);
  }
  return event;
}

// ── assign ───────────────────────────────────────────────────────────────

export function assign(ctx: Ctx, input: {
  session?: string;
  thread?: string;
  merge?: { from: string; into: string };
  why: string;
  auto?: boolean;
}): MainEvent {
  const auto = input.auto ?? true;
  if (input.merge) {
    const from = requireTask(ctx, input.merge.from);
    const into = requireTask(ctx, input.merge.into);
    if (from.id === into.id) throw new ActionError("cannot merge a task into itself");
    const before = { from: snapshot(from), into: snapshot(into) };
    addAliases(into, [from.id, ...from.aliases]);
    for (const s of from.sessions) if (!into.sessions.includes(s)) into.sessions.push(s);
    for (const a of from.artifacts) if (!into.artifacts.includes(a)) into.artifacts.push(a);
    into.next.push(...from.next.filter((n) => !n.done));
    into.waits.push(...from.waits.filter((w) => !w.closed));
    into.open.push(...from.open);
    into.log.push(...from.log);
    if (from.priority === "P1") into.priority = "P1";
    ctx.store.deleteTask(from.id);
    for (const event of ctx.store.eventsForTask(from.id)) {
      if (event.task === from.id) ctx.store.rewriteEvent({ ...event, task: into.id });
    }
    touch(ctx, into);
    return record(ctx, { task: into.id, action: "assign", auto, why: input.why, data: { merge: input.merge, before } });
  }
  if (!input.session || !input.thread) throw new ActionError("assign needs session and thread, or merge");
  for (const task of ctx.store.listTasks()) {
    const i = task.sessions.indexOf(input.session);
    if (i >= 0) {
      task.sessions.splice(i, 1);
      touch(ctx, task);
    }
  }
  if (input.thread === "none") {
    return record(ctx, { action: "assign", auto, why: input.why, data: { session: input.session, thread: "none" } });
  }
  let target: Task;
  if (input.thread.startsWith("new:")) {
    const slug = input.thread.slice(4).trim() || input.session;
    target = ctx.store.getTask(slug) ?? newTask(ctx, slug, slug);
  } else {
    target = requireTask(ctx, input.thread);
  }
  target.sessions.unshift(input.session);
  touch(ctx, target);
  return record(ctx, { task: target.id, action: "assign", auto, why: input.why, data: { session: input.session, thread: input.thread } });
}

// ── update ───────────────────────────────────────────────────────────────

export interface UpdateInput {
  task: string;
  status?: TaskStatus;
  title?: string;
  stands?: string;
  next?: NextItem[];
  addNext?: NextItem[];
  doneNext?: string[];
  addWaits?: Wait[];
  closeWaits?: string[];
  aliases?: string[];
  priority?: string;
  why: string;
  auto?: boolean;
}

function matchesText(item: string, needle: string): boolean {
  const a = item.trim().toLowerCase();
  const b = needle.trim().toLowerCase();
  return a === b || (b.length >= 6 && a.includes(b)) || shortHash(item) === needle;
}

export function update(ctx: Ctx, input: UpdateInput): MainEvent {
  const task = requireTask(ctx, input.task);
  const before = snapshot(task);
  const changed: string[] = [];
  if (input.title) { task.title = input.title; changed.push("title"); }
  if (input.stands) { task.stands = input.stands; changed.push("stands"); }
  if (input.next) { task.next = input.next; changed.push("next"); }
  if (input.addNext?.length) { task.next.push(...input.addNext); changed.push("next"); }
  for (const needle of input.doneNext ?? []) {
    for (const item of task.next) if (!item.done && matchesText(item.text, needle)) { item.done = true; changed.push("next"); }
  }
  if (input.addWaits?.length) { task.waits.push(...input.addWaits); changed.push("waits"); }
  for (const needle of input.closeWaits ?? []) {
    for (const wait of task.waits) if (!wait.closed && matchesText(wait.what, needle)) { wait.closed = true; changed.push("waits"); }
  }
  if (input.aliases?.length && addAliases(task, input.aliases)) changed.push("aliases");
  if (input.priority) { task.priority = input.priority; changed.push("priority"); }
  if (input.status && input.status !== task.status) { task.status = input.status; changed.push("status"); }
  touch(ctx, task);
  return record(ctx, {
    task: task.id, action: "update", auto: input.auto ?? true, why: input.why,
    data: { changed: [...new Set(changed)], before, ...(input.status ? { status: input.status } : {}) },
  });
}

// ── archive ──────────────────────────────────────────────────────────────

export function pendingArchive(store: Store, taskId: string): MainEvent | undefined {
  return store.eventsForTask(taskId).find((e) => e.action === "archive" && e.data?.suggested && e.data.state === "pending");
}

/** The judge's archive is a suggestion: it takes effect 48 hours later unless something objects. */
export function suggestArchive(ctx: Ctx, input: { task: string; why: string; auto?: boolean }): MainEvent {
  const task = requireTask(ctx, input.task);
  const existing = pendingArchive(ctx.store, task.id);
  if (existing) return existing;
  const effectiveAt = new Date(ctx.now().getTime() + ARCHIVE_GRACE_MS).toISOString();
  return record(ctx, {
    task: task.id, action: "archive", auto: input.auto ?? true, why: input.why,
    data: { suggested: true, state: "pending", effectiveAt },
  });
}

function closePendingArchive(ctx: Ctx, taskId: string, state: string, reason: string): void {
  const pending = pendingArchive(ctx.store, taskId);
  if (pending) ctx.store.rewriteEvent({ ...pending, data: { ...pending.data, state, reason, closedAt: nowIso(ctx) } });
}

export function archiveNow(ctx: Ctx, input: { task: string; why: string; auto?: boolean }): MainEvent {
  const task = requireTask(ctx, input.task);
  const before = snapshot(task);
  closePendingArchive(ctx, task.id, "superseded", "archived now");
  task.status = "archived";
  touch(ctx, task);
  return record(ctx, { task: task.id, action: "archive", auto: input.auto ?? false, why: input.why, data: { suggested: false, before } });
}

export function hasUnpushedCommits(task: Task): boolean {
  if (task.checks?.branch?.state === "local-only") return true;
  const unpushed = /not pushed|unpushed|未推|没推|local only|本地/i;
  return task.artifacts.some((a) => a.startsWith("commit:") && unpushed.test(a))
    || (task.checks?.branch?.state !== "pushed" && unpushed.test(task.stands) && Boolean(task.branch));
}

/** User or work activity on a task after `since` (anything but the service's own digest asks). */
export function hasActivitySince(store: Store, taskId: string, since: string): boolean {
  return store.eventsForTask(taskId).some((e) => e.t > since && (
    e.action === "closeout" || (e.action === "answer" && !e.data?.undone) || (e.action === "checker" && e.data?.changed)
    || (e.action === "update" && !e.auto)
  ));
}

/**
 * Apply archive suggestions whose 48 hours are up. A suggestion is cancelled by any activity
 * on the task since it was made, and held back while the task has unpushed commits or is
 * tied to a P1. Returns the tasks that were archived.
 */
export function processPendingArchives(ctx: Ctx): string[] {
  const archived: string[] = [];
  const now = nowIso(ctx);
  for (const event of ctx.store.listEvents()) {
    if (event.action !== "archive" || !event.data?.suggested || event.data.state !== "pending") continue;
    if (event.data.effectiveAt > now) continue;
    const task = event.task ? ctx.store.getTask(event.task) : undefined;
    if (!task || task.status === "archived") {
      ctx.store.rewriteEvent({ ...event, data: { ...event.data, state: "superseded", closedAt: now } });
      continue;
    }
    if (hasActivitySince(ctx.store, task.id, event.t)) {
      ctx.store.rewriteEvent({ ...event, data: { ...event.data, state: "cancelled", reason: "activity after the suggestion", closedAt: now } });
      continue;
    }
    if (hasUnpushedCommits(task) || task.priority === "P1") {
      ctx.store.rewriteEvent({
        ...event,
        data: { ...event.data, state: "blocked", reason: task.priority === "P1" ? "tied to a P1" : "unpushed commits", closedAt: now },
      });
      continue;
    }
    const before = snapshot(task);
    task.status = "archived";
    touch(ctx, task);
    ctx.store.rewriteEvent({ ...event, data: { ...event.data, state: "effective", before, closedAt: now } });
    archived.push(task.id);
  }
  return archived;
}

// ── remember / insert / schedule / dispatch ──────────────────────────────

export async function remember(ctx: Ctx, input: {
  records: MemoryRecord[];
  task?: string;
  why: string;
  auto?: boolean;
}): Promise<MainEvent> {
  const result = await ctx.memory.write(input.records);
  return record(ctx, {
    ...(input.task ? { task: input.task } : {}),
    action: "remember", auto: input.auto ?? true, why: input.why,
    data: { count: input.records.length, texts: input.records.map((r) => r.text), result },
  });
}

export function insert(ctx: Ctx, input: { sessionId: string; text: string; task?: string; why: string; auto?: boolean }): MainEvent {
  const event = record(ctx, {
    ...(input.task ? { task: input.task } : {}),
    action: "insert", auto: input.auto ?? true, why: input.why,
    data: { sessionId: input.sessionId, text: input.text },
  });
  ctx.emit("insert", { sessionId: input.sessionId, text: input.text, task: input.task, eventId: event.id });
  return event;
}

export function schedule(ctx: Ctx, input: {
  at: string;
  text: string;
  kind?: Schedule["kind"];
  task?: string;
  sessionId?: string;
  why: string;
  auto?: boolean;
  createdBy?: string;
}): MainEvent {
  if (Number.isNaN(Date.parse(input.at))) throw new ActionError(`bad time ${input.at}`);
  const item: Schedule = {
    id: `s_${randomUUID().slice(0, 8)}`,
    at: new Date(input.at).toISOString(),
    kind: input.kind ?? "remind",
    text: input.text,
    ...(input.task ? { task: input.task } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    createdBy: input.createdBy ?? (input.auto === false ? "user" : "judge"),
  };
  ctx.store.schedules.push(item);
  ctx.store.saveSchedules();
  return record(ctx, {
    ...(input.task ? { task: input.task } : {}),
    action: "schedule", auto: input.auto ?? true, why: input.why, data: item,
  });
}

/** Start a read-only dispatch. The tool call returns at once; the result arrives as a second event. */
export function dispatchReadonly(ctx: Ctx, input: { task: string; step: string; why: string; auto?: boolean }): MainEvent {
  const task = requireTask(ctx, input.task);
  const started = record(ctx, {
    task: task.id, action: "dispatch_readonly", auto: input.auto ?? true, why: input.why,
    data: { phase: "started", step: input.step },
  });
  const finish = (result: DispatchResult) => {
    const done = record(ctx, {
      task: task.id, action: "dispatch_readonly", auto: true, why: `result of ${started.id}`,
      data: { phase: "result", step: input.step, startedId: started.id, ...result },
    });
    if (result.failed) {
      ask(ctx, {
        task: task.id, immediate: true, category: "immediate",
        question: `${task.id}: 只读检查没通过 — ${input.step}: ${result.result.slice(0, 160)}`,
        chips: ["看一下", "稍后"], why: `verification failed (${done.id})`,
      });
    }
    ctx.onTrigger?.({ kind: "dispatch_result", task: task.id, eventId: done.id });
  };
  if (!ctx.dispatch) {
    finish({ ok: false, result: "read-only dispatch is not available in this process" });
  } else {
    ctx.dispatch({ task, step: input.step }).then(finish, (error: unknown) => {
      finish({ ok: false, result: error instanceof Error ? error.message : String(error) });
    });
  }
  return started;
}

// ── the user's answers ───────────────────────────────────────────────────

const ARCHIVE_WORDS = /^(归档|全部归档|放弃|不做|不做了|算了|drop|archive|abandon)$/i;
const KEEP_WORDS = /^(保留|不归档|keep|留着)$/i;
const DONE_WORDS = /^(做了|已做|已验证|完成|做完了|好了|已处理|done|verified|ok了)$/i;
const SNOOZE_WORDS = /^(稍后|再等等|等等|等|later|wait|snooze|明天再说)$/i;
const DISPATCH_WORDS = /^(派人查|派人看|查一下|check)$/i;

export interface AnswerResult {
  task: Task;
  event: MainEvent;
}

function closeKeyedItem(task: Task, key: string | undefined): void {
  if (!key) return;
  const [kind, , hash] = key.split(":");
  if (kind === "verify" || kind === "me") {
    for (const item of task.next) if (shortHash(item.text) === hash) item.done = true;
  } else if (kind === "wait") {
    for (const wait of task.waits) if (shortHash(wait.what) === hash) wait.closed = true;
  }
}

function settleStatus(store: Store, task: Task): void {
  if (task.status === "need" && openAsks(store, task.id).length === 0) task.status = "watch";
}

/**
 * Answer an ask with a chip or a sentence. An answer that approves a write is recorded as an
 * approval and never carried out. Answering the same ask again returns the first answer.
 */
export function answer(ctx: Ctx, taskId: string, input: { word: string; eventId?: string }): AnswerResult {
  const word = (input.word ?? "").trim();
  if (!word) throw new ActionError("word is required");
  const task = requireTask(ctx, taskId);
  let askEvent: MainEvent | undefined;
  if (input.eventId) {
    askEvent = ctx.store.getEvent(input.eventId);
    if (!askEvent) throw new ActionError(`no event ${input.eventId}`, 404);
    if (askEvent.action === "answer") return { task: ctx.store.getTask(askEvent.task ?? "") ?? task, event: askEvent };
    if (askEvent.data?.answeredBy) {
      const prior = ctx.store.getEvent(askEvent.data.answeredBy);
      if (prior && !prior.data?.undone) return { task: ctx.store.getTask(prior.task ?? task.id) ?? task, event: prior };
    }
  } else {
    askEvent = openAsks(ctx.store, task.id)[0];
  }

  const askData = (askEvent?.data ?? {}) as AskData;
  const coveredIds = askData.tasks?.length ? askData.tasks : [task.id];
  const before: Record<string, Task> = {};
  for (const id of coveredIds) {
    const t = ctx.store.getTask(id);
    if (t) before[id] = snapshot(t);
  }
  const archiveAsk = askData.category === "archive_suggest";
  let effect: string;
  if (ARCHIVE_WORDS.test(word)) {
    effect = "archived";
    for (const id of coveredIds) {
      const t = ctx.store.getTask(id);
      if (!t) continue;
      closePendingArchive(ctx, id, "superseded", "archived by answer");
      t.status = "archived";
      touch(ctx, t);
    }
  } else if (archiveAsk && KEEP_WORDS.test(word)) {
    effect = "kept";
    for (const id of coveredIds) closePendingArchive(ctx, id, "cancelled", "user kept it");
  } else if (DONE_WORDS.test(word)) {
    effect = "done";
    closeKeyedItem(task, askData.key);
  } else if (SNOOZE_WORDS.test(word)) {
    effect = "snoozed";
  } else if (DISPATCH_WORDS.test(word)) {
    effect = "dispatched";
  } else {
    effect = askData.write ? "approved" : "noted";
  }

  const event = record(ctx, {
    task: task.id, action: "answer", auto: false, why: `user answered "${word}"`,
    data: {
      word, effect, before,
      ...(askEvent ? { askId: askEvent.id } : {}),
      ...(askData.write || effect === "approved" ? { approval: word } : {}),
    },
  });
  if (askEvent && askEvent.action === "ask") {
    ctx.store.rewriteEvent({ ...askEvent, data: { ...askEvent.data, answeredBy: event.id, answeredAt: event.t } });
  }
  if (effect === "dispatched") {
    dispatchReadonly(ctx, { task: task.id, step: askData.question ?? word, why: `user asked to check (${event.id})`, auto: false });
  }
  if (task.status !== "archived") settleStatus(ctx.store, task);
  touch(ctx, task);
  return { task, event };
}

/** Undo an answer or an immediate archive made within the last five minutes. */
export function undo(ctx: Ctx, taskId: string, eventId: string): Task {
  if (!eventId) throw new ActionError("eventId is required");
  const event = ctx.store.getEvent(eventId);
  if (!event) throw new ActionError(`no event ${eventId}`, 404);
  const task = requireTask(ctx, taskId);
  if (event.task !== task.id && !event.data?.before?.[task.id]) throw new ActionError("event is not on this task");
  if (event.data?.undone) return task;
  const undoable = event.action === "answer" || (event.action === "archive" && !event.data?.suggested);
  if (!undoable) throw new ActionError(`cannot undo a ${event.action}`);
  if (ctx.now().getTime() - Date.parse(event.t) > UNDO_WINDOW_MS) throw new ActionError("undo window (5 minutes) has passed", 409);

  const snapshots: Record<string, Task> = event.action === "archive"
    ? { [task.id]: event.data.before as Task }
    : (event.data.before ?? {}) as Record<string, Task>;
  for (const [id, saved] of Object.entries(snapshots)) {
    const restored = { ...saved, log: ctx.store.getTask(id)?.log ?? saved.log };
    ctx.store.putTask(restored);
    ctx.emit("task", { task: restored });
  }
  ctx.store.rewriteEvent({ ...event, data: { ...event.data, undone: true, undoneAt: nowIso(ctx) } });
  if (event.action === "answer" && event.data.askId) {
    const askEvent = ctx.store.getEvent(event.data.askId);
    if (askEvent) {
      const { answeredBy: _a, answeredAt: _b, ...rest } = askEvent.data;
      void _a; void _b;
      ctx.store.rewriteEvent({ ...askEvent, data: rest });
    }
    // Pending archives an archiving answer superseded come back as they were.
    for (const id of Object.keys(snapshots)) {
      for (const e of ctx.store.eventsForTask(id)) {
        if (e.action === "archive" && e.data?.suggested && e.data.closedAt && e.data.closedAt >= event.t
          && (e.data.state === "superseded" || e.data.state === "cancelled")) {
          const { state: _s, reason: _r, closedAt: _c, ...rest } = e.data;
          void _s; void _r; void _c;
          ctx.store.rewriteEvent({ ...e, data: { ...rest, state: "pending" } });
        }
      }
    }
  }
  const current = ctx.store.getTask(task.id) ?? task;
  record(ctx, { task: current.id, action: "update", auto: false, why: `undo ${eventId}`, data: { undo: eventId } });
  return current;
}
