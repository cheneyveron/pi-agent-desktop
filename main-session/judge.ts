// Judgment turns: the model sees one event, the tasks it touches and a board of recent tasks,
// and acts only through the nine-action tool set below. Turns run one at a time. The runner is
// injectable: production uses a Pi SDK session (pi-runtime.ts), tests use a scripted stub.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import {
  ActionError, ask, assign, dispatchReadonly, insert, remember, requireTask, schedule,
  suggestArchive, update, type Ctx,
} from "./actions.ts";
import { daysBetween } from "./dates.ts";
import { applyDigestWording, lastActivity } from "./digest.ts";
import type { MainEvent, NextItem, Task, Wait } from "./types.ts";

export interface JudgeTool {
  name: string;
  description: string;
  parameters: TSchema;
  execute(params: Record<string, unknown>): Promise<string>;
}

export interface JudgeRunInput {
  system: string;
  user: string;
  tools: JudgeTool[];
}

/** Runs one model turn with the tools; returns the model's final text. */
export type JudgeRunner = (input: JudgeRunInput) => Promise<string>;

export type Trigger =
  | { kind: "closeout"; task?: string; eventId: string; sessionId: string }
  | { kind: "checker"; task?: string; eventId: string }
  | { kind: "dispatch_result"; task?: string; eventId?: string }
  | { kind: "daily_tick"; date: string; digestEventId?: string }
  | { kind: "chat"; text: string };

export interface JudgeOutcome {
  reply: string;
  events: MainEvent[];
}

const PROMPT_PATH = fileURLToPath(new URL("./prompts/judge.md", import.meta.url));
let promptCache: string | undefined;
export function judgePrompt(): string {
  promptCache ??= readFileSync(PROMPT_PATH, "utf8");
  return promptCache;
}

const why = Type.String({ description: "One short sentence: why you are doing this." });
const nextItem = Type.Object({
  text: Type.String(),
  run: Type.Union([Type.Literal("me"), Type.Literal("agent"), Type.Literal("notify"), Type.Literal("checker")]),
  on: Type.Optional(Type.String({ description: "Condition, e.g. 'pr #752', 'date 2026-11-01', 'manual'." })),
  done: Type.Optional(Type.Boolean()),
});
const waitItem = Type.Object({
  who: Type.String({ description: "Person or system waited on: a name, 'customer', 'pr', 'deploy', 'date'." }),
  what: Type.String(),
  until: Type.Optional(Type.String({ description: "YYYY-MM-DD when it is due." })),
});

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The action set as model tools. Every call records its event into `sink`. */
export function actionTools(ctx: Ctx, trigger: Trigger, sink: MainEvent[]): JudgeTool[] {
  const done = (event: MainEvent | undefined, text?: string) => {
    if (event) sink.push(event);
    return text ?? (event ? `ok (${event.id})` : "ok");
  };
  const tools: JudgeTool[] = [
    {
      name: "assign",
      description: "Move a session to a task (thread: task id | new:<slug> | none), or merge task merge_from into merge_into.",
      parameters: Type.Object({
        session: Type.Optional(Type.String()), thread: Type.Optional(Type.String()),
        merge_from: Type.Optional(Type.String()), merge_into: Type.Optional(Type.String()), why,
      }),
      async execute(p) {
        const from = str(p.merge_from);
        const into = str(p.merge_into);
        return done(assign(ctx, from && into
          ? { merge: { from, into }, why: String(p.why) }
          : { session: str(p.session), thread: str(p.thread), why: String(p.why) }));
      },
    },
    {
      name: "update",
      description: "Change a task: status, title, stands, next steps (replace, add, tick), waits (add, close), aliases, priority.",
      parameters: Type.Object({
        task: Type.String(),
        status: Type.Optional(Type.Union([Type.Literal("need"), Type.Literal("watch"), Type.Literal("done")])),
        title: Type.Optional(Type.String()), stands: Type.Optional(Type.String()),
        next: Type.Optional(Type.Array(nextItem, { description: "Replaces the whole list." })),
        add_next: Type.Optional(Type.Array(nextItem)),
        done_next: Type.Optional(Type.Array(Type.String(), { description: "Text (or a distinctive part) of next steps that are done." })),
        add_waits: Type.Optional(Type.Array(waitItem)),
        close_waits: Type.Optional(Type.Array(Type.String())),
        aliases: Type.Optional(Type.Array(Type.String())),
        priority: Type.Optional(Type.String()),
        why,
      }),
      async execute(p) {
        const since = ctx.now().toISOString();
        return done(update(ctx, {
          task: String(p.task), why: String(p.why),
          ...(p.status ? { status: p.status as "need" | "watch" | "done" } : {}),
          ...(str(p.title) ? { title: str(p.title) } : {}),
          ...(str(p.stands) ? { stands: str(p.stands) } : {}),
          ...(Array.isArray(p.next) ? { next: p.next as NextItem[] } : {}),
          ...(Array.isArray(p.add_next) ? { addNext: p.add_next as NextItem[] } : {}),
          ...(Array.isArray(p.done_next) ? { doneNext: p.done_next as string[] } : {}),
          ...(Array.isArray(p.add_waits) ? { addWaits: (p.add_waits as Wait[]).map((w) => ({ ...w, since })) } : {}),
          ...(Array.isArray(p.close_waits) ? { closeWaits: p.close_waits as string[] } : {}),
          ...(Array.isArray(p.aliases) ? { aliases: p.aliases as string[] } : {}),
          ...(str(p.priority) ? { priority: str(p.priority) } : {}),
        }));
      },
    },
    {
      name: "dispatch_readonly",
      description: "Start a read-only session for one step (git log/show/diff, gh pr view/checks, curl -s GET, wisp SELECT, reading files). Never for writes.",
      parameters: Type.Object({ task: Type.String(), step: Type.String({ description: "What to check and what result to report." }), why }),
      async execute(p) {
        return done(dispatchReadonly(ctx, { task: String(p.task), step: String(p.step), why: String(p.why) }), "dispatched; the result arrives later as an event");
      },
    },
    {
      name: "ask",
      description: "Ask the user a question one word can answer. immediate only for P1, production org, or failed verification. Writes are asks with write: true.",
      parameters: Type.Object({
        task: Type.String(), question: Type.String(),
        chips: Type.Optional(Type.Array(Type.String(), { maxItems: 3 })),
        immediate: Type.Optional(Type.Boolean()), write: Type.Optional(Type.Boolean()), why,
      }),
      async execute(p) {
        return done(ask(ctx, {
          task: String(p.task), question: String(p.question), why: String(p.why),
          ...(Array.isArray(p.chips) ? { chips: (p.chips as string[]).slice(0, 3) } : {}),
          ...(p.immediate === true ? { immediate: true, category: "immediate" as const } : {}),
          ...(p.write === true ? { write: true } : {}),
        }));
      },
    },
    {
      name: "archive",
      description: "Suggest archiving a finished or abandoned task. Takes effect in 48 hours unless the user objects.",
      parameters: Type.Object({ task: Type.String(), why }),
      async execute(p) {
        return done(suggestArchive(ctx, { task: String(p.task), why: String(p.why) }));
      },
    },
    {
      name: "remember",
      description: "Store a fact, decision or correction worth keeping (write-only memory).",
      parameters: Type.Object({
        text: Type.String(),
        speaker: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("assistant")])),
        task: Type.Optional(Type.String()), why,
      }),
      async execute(p) {
        const record = { t: ctx.now().toISOString(), speaker: (p.speaker === "user" ? "user" : "assistant") as "user" | "assistant", text: String(p.text) };
        return done(await remember(ctx, { records: [record], ...(str(p.task) ? { task: str(p.task) } : {}), why: String(p.why) }));
      },
    },
    {
      name: "insert",
      description: "Insert a short main-session note into an open session of a task.",
      parameters: Type.Object({ session: Type.String(), text: Type.String(), task: Type.Optional(Type.String()), why }),
      async execute(p) {
        const sessionId = String(p.session);
        const taskId = str(p.task);
        if (taskId && !requireTask(ctx, taskId).sessions.includes(sessionId)) throw new ActionError(`session ${sessionId} is not on ${taskId}`);
        return done(insert(ctx, { sessionId, text: String(p.text), ...(taskId ? { task: taskId } : {}), why: String(p.why) }));
      },
    },
    {
      name: "schedule",
      description: "Arrange a future action: kind remind (reminder), check (timed read-only check), after_session (when a session's next close-out arrives).",
      parameters: Type.Object({
        at: Type.String({ description: "ISO time; ignored for after_session." }),
        text: Type.String(),
        kind: Type.Optional(Type.Union([Type.Literal("remind"), Type.Literal("check"), Type.Literal("after_session")])),
        task: Type.Optional(Type.String()), session: Type.Optional(Type.String()), why,
      }),
      async execute(p) {
        return done(schedule(ctx, {
          at: String(p.at), text: String(p.text), why: String(p.why),
          ...(p.kind ? { kind: p.kind as "remind" | "check" | "after_session" } : {}),
          ...(str(p.task) ? { task: str(p.task) } : {}),
          ...(str(p.session) ? { sessionId: str(p.session) } : {}),
        }));
      },
    },
    {
      name: "digest",
      description: "Daily tick only: write today's narrative and optionally reword lines by eventId. Cannot add or remove lines.",
      parameters: Type.Object({
        narrative: Type.Optional(Type.String()),
        lines: Type.Optional(Type.Array(Type.Object({ eventId: Type.String(), text: Type.String() }))),
        why,
      }),
      async execute(p) {
        if (trigger.kind !== "daily_tick") throw new ActionError("digest is only available on the daily tick");
        const event = applyDigestWording(ctx, trigger.date, {
          ...(str(p.narrative) ? { narrative: str(p.narrative) } : {}),
          ...(Array.isArray(p.lines) ? { lines: p.lines as { eventId: string; text: string }[] } : {}),
        }, String(p.why));
        if (event) {
          const logged = ctx.store.addEvent({ action: "digest", auto: true, t: ctx.now().toISOString(), why: String(p.why), data: { date: trigger.date, worded: event.id } });
          sink.push(logged);
        }
        return event ? "digest updated" : "no digest for today";
      },
    },
  ];
  return tools.map((tool) => ({
    ...tool,
    async execute(params) {
      try {
        return await tool.execute(params);
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  }));
}

function taskLine(ctx: Ctx, task: Task): string {
  const next = task.next.find((n) => !n.done);
  const last = ctx.clock.day(lastActivity(ctx.store, task));
  const stands = task.stands.replace(/\s+/g, " ").slice(0, 100);
  return `${task.id} [${task.status}${task.priority ? ` ${task.priority}` : ""}] ${task.title} — ${stands} | last ${last}${next ? ` | next: ${next.text.slice(0, 60)} (${next.run}${next.on ? `, on ${next.on}` : ""})` : ""}`;
}

function taskDetail(ctx: Ctx, task: Task): string {
  const asks = ctx.store.eventsForTask(task.id).filter((e) => e.action === "ask" && !e.data?.answeredBy && !e.data?.cancelled)
    .map((e) => ({ id: e.id, question: e.data.question }));
  const recent = ctx.store.eventsForTask(task.id).slice(-8).map((e) => `${e.t.slice(0, 16)} ${e.action}: ${e.why}`);
  const { log: _log, ...rest } = task;
  void _log;
  return JSON.stringify({ ...rest, openAsks: asks, recentEvents: recent }, null, 1).slice(0, 6000);
}

/** The user message of a judgment turn: event, involved tasks in full, board of recent tasks. */
export function buildJudgeInput(ctx: Ctx, trigger: Trigger, alreadyDone: MainEvent[] = []): string {
  const today = ctx.clock.day(ctx.now());
  const involved = new Set<string>();
  const parts: string[] = [`Now: ${ctx.now().toISOString()} (local day ${today})`];
  if (trigger.kind === "chat") {
    parts.push(`## Event: the user asks\n${trigger.text}`);
  } else if (trigger.kind === "daily_tick") {
    const digest = trigger.digestEventId ? ctx.store.getEvent(trigger.digestEventId) : undefined;
    parts.push(`## Event: daily tick ${trigger.date}\nDigest lines chosen by the service:\n${JSON.stringify(digest?.data?.lines ?? [], null, 1)}`);
    for (const line of digest?.data?.lines ?? []) involved.add(line.task);
  } else {
    const event = trigger.eventId ? ctx.store.getEvent(trigger.eventId) : undefined;
    parts.push(`## Event: ${trigger.kind}\n${JSON.stringify(event ?? trigger, null, 1).slice(0, 4000)}`);
    if (trigger.kind === "closeout") {
      const closeout = ctx.store.closeoutsForSession(trigger.sessionId).at(-1);
      if (closeout) parts.push(`## Close-out\n${JSON.stringify(closeout, null, 1).slice(0, 6000)}`);
    }
  }
  if ("task" in trigger && trigger.task) involved.add(trigger.task);
  if (trigger.kind === "chat") {
    for (const task of ctx.store.listTasks()) {
      if (trigger.text.toLowerCase().includes(task.id.toLowerCase()) || task.aliases.some((a) => a.length > 3 && trigger.text.toLowerCase().includes(a.toLowerCase()))) involved.add(task.id);
    }
  }
  for (const id of involved) {
    const task = ctx.store.getTask(id);
    if (task) parts.push(`## Task ${id}\n${taskDetail(ctx, task)}`);
  }
  const board = ctx.store.listTasks()
    .filter((t) => t.status !== "archived" && daysBetween(ctx.clock.day(lastActivity(ctx.store, t)), today) <= 30)
    .sort((a, b) => lastActivity(ctx.store, b).localeCompare(lastActivity(ctx.store, a)))
    .slice(0, 60)
    .map((t) => taskLine(ctx, t));
  parts.push(`## Board (active in the last 30 days)\n${board.join("\n") || "(empty)"}`);
  if (alreadyDone.length) {
    parts.push(`## Already done this turn by the service\n${alreadyDone.map((e) => `${e.action} ${e.task ?? ""}: ${e.why}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Serialises judgment turns: one model turn at a time, in arrival order. */
export class Judge {
  private chain: Promise<unknown> = Promise.resolve();
  lastError?: string;
  turns = 0;
  private ctx: Ctx;
  private runner: JudgeRunner | undefined;

  constructor(ctx: Ctx, runner: JudgeRunner | undefined) {
    this.ctx = ctx;
    this.runner = runner;
  }

  get available(): boolean {
    return Boolean(this.runner);
  }

  run(trigger: Trigger, alreadyDone: MainEvent[] = []): Promise<JudgeOutcome> {
    const next = this.chain.then(() => this.runNow(trigger, alreadyDone));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async runNow(trigger: Trigger, alreadyDone: MainEvent[]): Promise<JudgeOutcome> {
    if (!this.runner) return { reply: "", events: [] };
    const events: MainEvent[] = [];
    const tools = actionTools(this.ctx, trigger, events);
    try {
      const reply = await this.runner({ system: judgePrompt(), user: buildJudgeInput(this.ctx, trigger, alreadyDone), tools });
      this.turns++;
      this.lastError = undefined;
      return { reply, events };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[main-session] judgment turn (${trigger.kind}) failed: ${this.lastError}\n`);
      return { reply: "", events };
    }
  }
}

/** Production runner: a Pi SDK session on rdsec haiku (or luna) with the action tools only. */
export function createSdkJudgeRunner(options: { modelId?: string } = {}): JudgeRunner {
  return async ({ system, user, tools }) => {
    const { runPiTurn, resolveModelId } = await import("./pi-runtime.ts");
    const { defineTool } = await import("@earendil-works/pi-coding-agent");
    const modelId = resolveModelId(options.modelId);
    const customTools = tools.map((tool) => defineTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_id, params) {
        const text = await tool.execute(params as Record<string, unknown>);
        return { content: [{ type: "text", text }], details: undefined };
      },
    }));
    const result = await runPiTurn({ cwd: homedir(), systemPrompt: system, userText: user, customTools, modelId, timeoutMs: 120_000 });
    return result.text;
  };
}
