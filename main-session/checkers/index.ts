// Runs the read-only checkers over active tasks and turns state changes into checker events.
// The service calls this every ten minutes; each change can start a judgment turn.

import { ask, dispatchReadonly, type Ctx } from "../actions.ts";
import type { MainEvent, PrCheck, Schedule, Task } from "../types.ts";
import { checkBranch } from "./branch.ts";
import { dueItems } from "./date.ts";
import type { Exec } from "./exec.ts";
import { afterSessionSchedules, dueSchedules } from "./manual.ts";
import { checkPr, describePrChange, prTargets } from "./pr.ts";

const FINAL_PR_STATES = new Set(["MERGED", "CLOSED"]);

function checkerEvent(ctx: Ctx, task: Task, checker: string, description: string, data: Record<string, unknown>): MainEvent {
  const event = ctx.store.addEvent({
    task: task.id, action: "checker", auto: true, t: ctx.now().toISOString(), why: description,
    data: { checker, changed: true, description, ...data },
  });
  ctx.emit("event", event);
  return event;
}

/** Apply one PR observation to a task; returns the checker event when something changed. */
export function applyPrCheck(ctx: Ctx, task: Task, after: PrCheck): MainEvent | undefined {
  const before = task.checks?.prs?.[after.ref];
  const description = describePrChange(before, after);
  task.checks = { ...task.checks, prs: { ...task.checks?.prs, [after.ref]: after } };
  if (!description) {
    ctx.store.saveTasks();
    return undefined;
  }
  if (after.state === "MERGED") {
    for (const wait of task.waits) {
      if (!wait.closed && wait.who === "pr") { wait.closed = true; wait.evidence = `${after.ref} merged ${after.mergedAt ?? ""}`.trim(); }
    }
  }
  task.updatedAt = ctx.now().toISOString();
  ctx.store.saveTasks();
  ctx.emit("task", { task });
  return checkerEvent(ctx, task, "pr", description, { before: before ?? null, after });
}

export interface CheckerRunResult {
  events: MainEvent[];
  errors: string[];
}

export async function runCheckers(ctx: Ctx, exec: Exec, options: { git?: boolean; gh?: boolean } = {}): Promise<CheckerRunResult> {
  const events: MainEvent[] = [];
  const errors: string[] = [];
  const now = ctx.now().toISOString();
  const today = ctx.clock.day(ctx.now());
  for (const task of ctx.store.listTasks()) {
    if (task.status !== "need" && task.status !== "watch") continue;
    if (options.git !== false && task.branch && task.repo && task.checks?.branch?.state !== "pushed") {
      try {
        const result = await checkBranch(task, exec, now);
        if (result) {
          const before = task.checks?.branch;
          task.checks = { ...task.checks, branch: result };
          ctx.store.saveTasks();
          if (before && before.state !== result.state) {
            events.push(checkerEvent(ctx, task, "branch", `branch ${task.branch}: ${before.state} → ${result.state}`, { before, after: result }));
          }
        }
      } catch (error) {
        errors.push(`${task.id} branch: ${String(error)}`);
      }
    }
    if (options.gh !== false) {
      for (const target of prTargets(task)) {
        if (FINAL_PR_STATES.has(task.checks?.prs?.[target.ref]?.state ?? "")) continue;
        try {
          const result = await checkPr(task, target, exec, now);
          if (result) {
            const event = applyPrCheck(ctx, task, result);
            if (event) events.push(event);
          }
        } catch (error) {
          errors.push(`${task.id} ${target.ref}: ${String(error)}`);
        }
      }
    }
    for (const due of dueItems(task, today)) {
      if (ctx.store.listEvents().some((e) => e.action === "checker" && e.data?.key === due.key)) continue;
      events.push(checkerEvent(ctx, task, "date", `${task.id}: due ${due.due} — ${due.what}`, { key: due.key, due: due.due }));
    }
  }
  events.push(...fireSchedules(ctx, dueSchedules(ctx.store.schedules, now)));
  return { events, errors };
}

/** Fire schedules: a reminder becomes an ask, a timed check becomes a read-only dispatch. */
export function fireSchedules(ctx: Ctx, due: Schedule[]): MainEvent[] {
  const events: MainEvent[] = [];
  for (const item of due) {
    item.firedAt = ctx.now().toISOString();
    ctx.store.saveSchedules();
    const task = item.task ? ctx.store.getTask(item.task) : undefined;
    if (item.kind === "check" && task) {
      events.push(dispatchReadonly(ctx, { task: task.id, step: item.text, why: `scheduled check ${item.id}` }));
      continue;
    }
    if (task) {
      events.push(ask(ctx, {
        task: task.id, question: item.text, immediate: item.createdBy === "user", chips: ["好", "稍后"],
        key: `schedule:${item.id}`, why: `reminder ${item.id} is due`,
        ...(item.createdBy === "user" ? { category: "immediate" as const } : {}),
      }));
    } else {
      const event = ctx.store.addEvent({
        action: "checker", auto: true, t: ctx.now().toISOString(), why: `reminder ${item.id} is due`,
        data: { checker: "manual", changed: true, reminder: item, immediate: item.createdBy === "user", description: item.text },
      });
      ctx.emit("event", event);
      events.push(event);
    }
  }
  return events;
}

export function fireAfterSession(ctx: Ctx, sessionId: string): MainEvent[] {
  return fireSchedules(ctx, afterSessionSchedules(ctx.store.schedules, sessionId));
}
