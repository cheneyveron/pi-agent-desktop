// Close-out intake (POST /closeouts): assign the close-out to a task through the alias table,
// update the task from it, and send what the user said and what was learned to memory.
// This part is deterministic so a close-out is never lost when the model is unreachable; the
// judgment turn that follows can still re-assign, merge or add asks.

import { addAliases, aliasesOfCloseout, branchFromArtifact, extractTickets, matchCloseout, newTaskId, taskHasAlias } from "./aliases.ts";
import { ActionError, ask, isMe, newTask, openAsks, remember, shortHash, type Ctx } from "./actions.ts";
import type { MemoryRecord } from "./memory.ts";
import type { Closeout, MainEvent, NextItem, OpenQ, Task, Wait } from "./types.ts";

const RUNS = new Set(["me", "agent", "notify", "checker"]);
const GOES_TO = new Set(["task", "session", "memory"]);

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Validate and normalise a close-out body; tolerant of the extension's optional fields. */
export function parseCloseout(body: unknown): Closeout {
  if (!body || typeof body !== "object") throw new ActionError("close-out must be a JSON object");
  const b = body as Record<string, unknown>;
  const sessionId = str(b.sessionId).trim();
  if (!sessionId) throw new ActionError("sessionId is required");
  const t = str(b.t) || new Date().toISOString();
  if (Number.isNaN(Date.parse(t))) throw new ActionError("t must be an ISO time");
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const next: NextItem[] = list(b.next).flatMap((n) => {
    if (typeof n === "string") return [{ text: n, run: "me" as const }];
    if (!n || typeof n !== "object") return [];
    const item = n as Record<string, unknown>;
    const text = str(item.text).trim();
    if (!text) return [];
    const run = RUNS.has(str(item.run)) ? str(item.run) as NextItem["run"] : "me";
    return [{ text, run, ...(str(item.on) ? { on: str(item.on) } : {}), ...(item.done === true ? { done: true } : {}) }];
  });
  const open: OpenQ[] = list(b.open).flatMap((o) => {
    if (typeof o === "string") return [{ question: o, who: "me", answerGoesTo: "task" as const }];
    if (!o || typeof o !== "object") return [];
    const q = o as Record<string, unknown>;
    const question = str(q.question).trim();
    if (!question) return [];
    const goes = GOES_TO.has(str(q.answerGoesTo)) ? str(q.answerGoesTo) as OpenQ["answerGoesTo"] : "task";
    return [{ question, who: str(q.who) || "me", answerGoesTo: goes, ...(str(q.then) ? { then: str(q.then) } : {}) }];
  });
  return {
    ...(str(b.id) ? { id: str(b.id) } : {}),
    ...(str(b.trigger) ? { trigger: str(b.trigger) } : {}),
    sessionId,
    cwd: str(b.cwd),
    t: new Date(t).toISOString(),
    thread: str(b.thread) || "none",
    stands: str(b.stands),
    next,
    produced: list(b.produced).filter((p): p is string => typeof p === "string"),
    learned: list(b.learned).flatMap((l) => {
      if (typeof l === "string") return [{ text: l }];
      if (!l || typeof l !== "object" || !str((l as Record<string, unknown>).text)) return [];
      const item = l as { text: string; anchors?: unknown };
      return [{ text: item.text, ...(Array.isArray(item.anchors) ? { anchors: item.anchors as { path: string; symbol?: string }[] } : {}) }];
    }),
    user_said: list(b.user_said).flatMap((u) => {
      if (typeof u === "string") return [{ text: u, kind: "instruction" as const }];
      if (!u || typeof u !== "object" || !str((u as Record<string, unknown>).text)) return [];
      const item = u as { text: string; kind?: string };
      const kind = item.kind === "correction" || item.kind === "preference" ? item.kind : "instruction";
      return [{ text: item.text, kind }];
    }),
    open,
    ...(Array.isArray(b.next_time) ? { next_time: b.next_time.filter((x): x is string => typeof x === "string") } : {}),
  };
}

/** Idempotency key: the extension's close-out id, or session and time for bodies without one. */
function closeoutKey(c: Closeout): string {
  return c.id ?? `${c.sessionId}@${c.t}`;
}

function contentHash(c: Closeout): string {
  const { id: _id, trigger: _trigger, ...rest } = c;
  void _id; void _trigger;
  return shortHash(JSON.stringify(rest));
}

function titleFrom(c: Closeout, id: string): string {
  const slug = c.thread.startsWith("new:") ? c.thread.slice(4).replace(/[-_]+/g, " ").trim() : "";
  const first = c.stands.split(/(?<=[。.!?！？])\s*/)[0]?.trim() ?? "";
  const head = slug || first || id;
  return head.length > 80 ? `${head.slice(0, 79)}…` : head;
}

const WRITE_WORDS = /推|push|merge|合并|部署|deploy|发布|release|评论|comment|回复客户|发给|transition|关单/i;

/** "推还是放弃？" → ["推", "放弃"]; undefined when the question is not an either/or. */
export function chipsFor(question: string): string[] | undefined {
  const m = /^(.{1,12}?)还是(.{1,12}?)[？?。]?$/.exec(question.replace(/^.*[：:，,]\s*/, "").trim());
  if (!m) return undefined;
  return [m[1].trim(), m[2].trim()].filter(Boolean);
}

const SYSTEM_WAITERS = /^(pr|ci|checker|deploy|date|github|gh)$/i;

/** Waits a close-out implies: open questions to other people, and conditional next steps. */
function waitsFrom(c: Closeout): Wait[] {
  const waits: Wait[] = [];
  for (const q of c.open) if (!isMe(q.who)) waits.push({ who: q.who, what: q.question, since: c.t });
  for (const n of c.next) {
    if (n.done || !n.on || n.on === "manual") continue;
    const who = /\bpr\b|#\d+/i.test(n.on) ? "pr" : /deploy|部署/i.test(n.on) ? "deploy" : /\d{4}-\d{2}-\d{2}/.test(n.on) ? "date" : "checker";
    waits.push({ who, what: n.text, since: c.t, ...(who === "date" ? { until: n.on.match(/\d{4}-\d{2}-\d{2}/)?.[0] } : {}) });
  }
  return waits;
}

/** Keep the original `since` of a wait that is still there; close waits the close-out dropped. */
function mergeWaits(old: Wait[], fresh: Wait[], t: string): Wait[] {
  const out: Wait[] = [];
  for (const w of fresh) {
    const prior = old.find((o) => !o.closed && o.what === w.what);
    out.push(prior ? { ...w, since: prior.since } : w);
  }
  for (const o of old) {
    if (o.closed || out.some((w) => w.what === o.what)) continue;
    // System waits (PR, deploy) belong to checkers; a newer close-out that no longer lists
    // them means the work moved past them.
    out.push(SYSTEM_WAITERS.test(o.who) ? { ...o, closed: true, evidence: `not in close-out ${t}` } : o);
  }
  return out;
}

export interface IntakeResult {
  task: Task | null;
  event: MainEvent;
  duplicate?: boolean;
}

export async function intakeCloseout(ctx: Ctx, closeout: Closeout): Promise<IntakeResult> {
  const key = closeoutKey(closeout);
  const hash = contentHash(closeout);
  const priors = ctx.store.listEvents().filter((e) => e.action === "closeout" && e.data?.key === key);
  const prior = priors.at(-1);
  // A repeat (outbox replay) returns the first result; the same id with edited content (the
  // card's "交接" button) is applied again as a revision.
  if (prior && (prior.data.hash === hash || prior.data.hash === undefined)) {
    return { task: prior.task ? ctx.store.getTask(prior.task) ?? null : null, event: prior, duplicate: true };
  }
  const revisionOf = prior?.id;

  ctx.store.addCloseout(closeout);
  const tasks = ctx.store.listTasks();
  const match = matchCloseout(tasks, closeout);
  let task = match.task ?? null;
  let via = match.via ?? "";
  let created = false;
  const hasWork = closeout.next.some((n) => !n.done) || closeout.open.length > 0
    || extractTickets(`${closeout.thread} ${closeout.stands}`).length > 0;
  if (!task && closeout.thread !== "none" && (closeout.thread.startsWith("new:") || hasWork)) {
    const id = newTaskId(closeout, (candidate) => ctx.store.hasTask(candidate));
    task = newTask(ctx, id, titleFrom(closeout, id), { createdAt: closeout.t });
    created = true;
    via = `new task ${id}`;
  }

  if (!task) {
    const event = ctx.store.addEvent({
      action: "closeout", auto: true, t: ctx.now().toISOString(),
      why: closeout.thread === "none" ? "close-out declares no thread" : "no task matched and nothing left to track",
      data: { key, hash, sessionId: closeout.sessionId, thread: closeout.thread, assigned: null, ...(revisionOf ? { revisionOf } : {}) },
    });
    ctx.emit("event", event);
    await rememberFrom(ctx, closeout, undefined);
    return { task: null, event };
  }

  // update: the newest close-out describes where the task stands now.
  // A related ticket another task already tracks stays that task's; it is not an alias here.
  const others = ctx.store.listTasks().filter((t) => t.id !== task!.id);
  addAliases(task, aliasesOfCloseout(closeout).filter((a) =>
    a.toLowerCase() !== task!.id.toLowerCase() && !others.some((t) => taskHasAlias(t, a))));
  task.sessions = [closeout.sessionId, ...task.sessions.filter((s) => s !== closeout.sessionId)];
  if (closeout.stands) task.stands = closeout.stands;
  if (closeout.next.length) task.next = closeout.next;
  task.open = closeout.open;
  task.waits = mergeWaits(task.waits, waitsFrom(closeout), closeout.t);
  for (const artifact of closeout.produced) if (!task.artifacts.includes(artifact)) task.artifacts.push(artifact);
  if (closeout.cwd) task.repo = closeout.cwd;
  const branch = closeout.produced.map(branchFromArtifact).find(Boolean);
  if (branch) task.branch = branch;
  const text = [closeout.thread, closeout.stands, ...closeout.next.map((n) => n.text), ...closeout.open.map((o) => o.question)].join("\n");
  if (/\bP1\b/.test(text)) task.priority = "P1";
  if (task.status === "archived" || task.status === "done") task.status = "watch";
  task.updatedAt = ctx.now().toISOString();
  ctx.store.saveTasks();

  const event = ctx.store.addEvent({
    task: task.id, action: "closeout", auto: true, t: ctx.now().toISOString(),
    why: `assigned via ${via}`,
    data: {
      key, hash, sessionId: closeout.sessionId, thread: closeout.thread, assigned: task.id, created,
      ...(revisionOf ? { revisionOf } : {}),
      ...(match.ties.length ? { ties: match.ties } : {}),
    },
  });
  ctx.emit("event", event);

  const openKey = (q: OpenQ) => `open:${task!.id}:${shortHash(q.question)}`;
  const currentKeys = new Set(closeout.open.filter((q) => isMe(q.who)).map(openKey));
  // Questions an earlier close-out asked and this one no longer lists were settled in the work.
  for (const e of openAsks(ctx.store, task.id)) {
    if (typeof e.data.key === "string" && e.data.key.startsWith(`open:${task.id}:`) && !currentKeys.has(e.data.key)) {
      ctx.store.rewriteEvent({ ...e, data: { ...e.data, cancelled: true, cancelledBy: event.id } });
    }
  }
  if (task.status === "need" && openAsks(ctx.store, task.id).length === 0) task.status = "watch";
  for (const q of closeout.open) {
    if (!isMe(q.who)) continue;
    const chips = chipsFor(q.question);
    ask(ctx, {
      task: task.id, question: q.question, why: `open question in close-out of ${closeout.sessionId}`,
      key: openKey(q),
      ...(chips ? { chips } : {}),
      ...(WRITE_WORDS.test(q.question) ? { write: true } : {}),
      ...(/\bP1\b|\bprod\b|生产/i.test(q.question) ? { immediate: true, category: "immediate" as const } : {}),
    });
  }
  ctx.emit("task", { task });
  await rememberFrom(ctx, closeout, task.id);
  return { task: ctx.store.getTask(task.id) ?? task, event };
}

async function rememberFrom(ctx: Ctx, c: Closeout, taskId: string | undefined): Promise<void> {
  const meta = { sessionId: c.sessionId, ...(taskId ? { task: taskId } : {}) };
  const records: MemoryRecord[] = [
    ...c.user_said.map((u) => ({ t: c.t, speaker: "user" as const, text: u.text, meta: { ...meta, kind: u.kind } })),
    ...c.learned.map((l) => ({ t: c.t, speaker: "assistant" as const, text: l.text, meta: { ...meta, kind: "learned", ...(l.anchors ? { anchors: l.anchors } : {}) } })),
  ];
  if (records.length === 0) return;
  await remember(ctx, { records, ...(taskId ? { task: taskId } : {}), why: `close-out of ${c.sessionId}: user_said and learned` });
}
