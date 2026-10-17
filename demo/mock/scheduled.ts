/**
 * Scheduled tasks (/api/scheduled-tasks). Two example tasks with a short run
 * history; creating, editing, pausing and deleting tasks works in memory, and
 * the cron preview uses the same parser as the real scheduler. Running a task
 * needs the server-side scheduler, so "Run now" explains that this is a demo.
 */
import { nextCronRun, nextCronRuns, systemTimezone, validateCron } from "@/lib/scheduled-tasks/cron";
import type { ScheduledRun, ScheduledTaskEvent, ScheduledTaskView, TaskSchedule } from "@/lib/scheduled-tasks/types";
import type { MockEventSource } from "./event-source";
import type { MockRequest } from "./http";
import { error, json } from "./http";
import { currentDemoLocale } from "./locale";
import { PROJECT_ROOT } from "./paths";
import { demoOnlyMessage } from "./unavailable";

type StoredTask = Omit<ScheduledTaskView, "nextRunAt" | "lastRun" | "unreadRuns">;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const timezone = systemTimezone();

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function exampleTasks(): StoredTask[] {
  const zh = currentDemoLocale() === "zh";
  const common = { cwd: PROJECT_ROOT, toolPreset: "read-only" as const, maxDurationMin: 30, consecutiveFailures: 0, createdAt: iso(9 * DAY), updatedAt: iso(9 * DAY) };
  return [
    {
      ...common,
      id: "task-daily-summary",
      name: zh ? "每日提交摘要" : "Daily commit summary",
      description: zh ? "总结过去一天的提交和未完成的工作" : "Summarize yesterday's commits and open work",
      prompt: zh
        ? "读取过去 24 小时的 git log，按功能归纳改动，列出仍未完成的 TODO。"
        : "Read the git log of the last 24 hours, group the changes by feature, and list the TODOs that are still open.",
      schedule: { kind: "cron", expr: "0 9 * * 1-5", timezone },
      model: { provider: "openai-codex", modelId: "gpt-5.5" },
      thinkingLevel: "low",
      enabled: true,
    },
    {
      ...common,
      id: "task-dependency-audit",
      name: zh ? "依赖审计" : "Dependency audit",
      prompt: zh
        ? "运行 npm audit 和 npm outdated，说明哪些升级需要关注。"
        : "Run npm audit and npm outdated and explain which upgrades need attention.",
      schedule: { kind: "manual" },
      toolPreset: "default",
      enabled: true,
    },
  ];
}

/** The last `count` weekday 09:00 slots before now, newest first, like "0 9 * * 1-5". */
function pastWeekdaySlots(count: number): Date[] {
  const slots: Date[] = [];
  const day = new Date();
  day.setHours(9, 0, 0, 0);
  if (day.getTime() > Date.now()) day.setDate(day.getDate() - 1);
  while (slots.length < count) {
    if (day.getDay() !== 0 && day.getDay() !== 6) slots.push(new Date(day));
    day.setDate(day.getDate() - 1);
  }
  return slots;
}

function exampleRuns(): ScheduledRun[] {
  const runs: ScheduledRun[] = pastWeekdaySlots(4).map((slot, index) => {
    const startedAt = new Date(slot.getTime() + 2_000).toISOString();
    const failed = index === 2;
    return {
      runId: `run-summary-${index + 1}`,
      taskId: "task-daily-summary",
      trigger: "schedule",
      scheduledFor: slot.toISOString(),
      startedAt,
      endedAt: new Date(Date.parse(startedAt) + (failed ? 9_000 : 74_000 + index * 11_000)).toISOString(),
      status: failed ? "failed" : "succeeded",
      ...(failed ? { error: "429 Too Many Requests: rate limit reached, retry after 60s" } : {}),
      seenAt: new Date(slot.getTime() + 3 * HOUR).toISOString(),
    };
  });
  runs.push({
    runId: "run-audit-1",
    taskId: "task-dependency-audit",
    trigger: "manual",
    startedAt: iso(6 * DAY + 5 * HOUR),
    endedAt: iso(6 * DAY + 5 * HOUR - 95_000),
    status: "succeeded",
    seenAt: iso(6 * DAY - HOUR),
  });
  return runs;
}

let tasks: StoredTask[] | null = null;
let runs: ScheduledRun[] = [];
const listeners = new Set<(event: ScheduledTaskEvent) => void>();

function state(): StoredTask[] {
  if (!tasks) {
    tasks = exampleTasks();
    runs = exampleRuns();
  }
  return tasks;
}

function emit(event: ScheduledTaskEvent): void {
  for (const listener of listeners) listener(event);
}

function nextRunAt(task: StoredTask): string | null {
  if (!task.enabled) return null;
  if (task.schedule.kind === "once") return Date.parse(task.schedule.at) > Date.now() ? task.schedule.at : null;
  if (task.schedule.kind !== "cron") return null;
  return nextCronRun(task.schedule.expr, task.schedule.timezone)?.toISOString() ?? null;
}

function view(task: StoredTask): ScheduledTaskView {
  const own = runs.filter((run) => run.taskId === task.id).sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return {
    ...task,
    nextRunAt: nextRunAt(task),
    lastRun: own[0] ?? null,
    unreadRuns: own.filter((run) => run.status !== "running" && run.sessionId && !run.seenAt).length,
  };
}

type TaskInput = Partial<Pick<StoredTask, "name" | "prompt" | "cwd" | "toolPreset" | "maxDurationMin" | "enabled">> & {
  description?: string | null;
  schedule?: TaskSchedule | { kind: "cron"; expr: string; timezone?: string };
  model?: StoredTask["model"] | null;
  thinkingLevel?: StoredTask["thinkingLevel"] | null;
};

function applyInput(task: StoredTask, input: TaskInput): Response | null {
  if (input.schedule?.kind === "cron") {
    const zone = input.schedule.timezone || timezone;
    try {
      validateCron(input.schedule.expr, zone);
    } catch (cause) {
      const failure = cause as Error & { key?: string; params?: Record<string, string | number> };
      return json({ error: failure.message, code: "validation", key: failure.key, params: failure.params }, 400);
    }
    task.schedule = { kind: "cron", expr: input.schedule.expr, timezone: zone };
  } else if (input.schedule) {
    task.schedule = input.schedule;
  }
  if (input.name !== undefined) task.name = input.name.trim();
  if (input.prompt !== undefined) task.prompt = input.prompt;
  if (input.cwd !== undefined) task.cwd = input.cwd;
  if (input.toolPreset !== undefined) task.toolPreset = input.toolPreset;
  if (input.maxDurationMin !== undefined) task.maxDurationMin = input.maxDurationMin;
  if (input.enabled !== undefined) {
    task.enabled = input.enabled;
    if (input.enabled) {
      task.consecutiveFailures = 0;
      delete task.autoPausedReason;
    }
  }
  if (input.description !== undefined) {
    if (input.description) task.description = input.description;
    else delete task.description;
  }
  if (input.model !== undefined) {
    if (input.model) task.model = input.model;
    else delete task.model;
  }
  if (input.thinkingLevel !== undefined) {
    if (input.thinkingLevel) task.thinkingLevel = input.thinkingLevel;
    else delete task.thinkingLevel;
  }
  if (!task.name) return json({ error: "name is required", code: "validation" }, 400);
  if (!task.prompt.trim()) return json({ error: "prompt is required", code: "validation" }, 400);
  task.updatedAt = new Date().toISOString();
  return null;
}

export async function scheduledTasksRoute(request: MockRequest): Promise<Response> {
  const list = state();
  const [, , id, sub, runId, leaf] = request.segments;

  if (!id) {
    if (request.method === "GET") return json({ tasks: list.map(view), scheduler: { owner: true } });
    const now = new Date().toISOString();
    const task: StoredTask = {
      id: `task-${Math.random().toString(36).slice(2, 10)}`,
      name: "",
      prompt: "",
      cwd: PROJECT_ROOT,
      schedule: { kind: "manual" },
      toolPreset: "read-only",
      maxDurationMin: 30,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      consecutiveFailures: 0,
    };
    const refused = applyInput(task, await request.json<TaskInput>());
    if (refused) return refused;
    list.push(task);
    emit({ type: "task_changed", taskId: task.id });
    return json({ task: view(task) });
  }

  if (id === "preview") {
    const body = await request.json<{ expr?: string; timezone?: string }>();
    if (!body.expr?.trim()) return json({ valid: false, error: "expr is required" }, 400);
    const zone = body.timezone || timezone;
    try {
      validateCron(body.expr, zone);
    } catch (cause) {
      const failure = cause as Error & { key?: string; params?: Record<string, string | number> };
      return json({ valid: false, error: failure.message, key: failure.key, params: failure.params });
    }
    return json({ valid: true, timezone: zone, nextRuns: nextCronRuns(body.expr, zone, 5).map((date) => date.toISOString()) });
  }

  const task = list.find((candidate) => candidate.id === id);
  if (!task) return json({ error: "Task not found", code: "not-found" }, 404);

  if (!sub) {
    if (request.method === "GET") return json({ task: view(task) });
    if (request.method === "DELETE") {
      tasks = list.filter((candidate) => candidate !== task);
      runs = runs.filter((run) => run.taskId !== task.id);
      emit({ type: "task_changed", taskId: task.id });
      return json({ success: true });
    }
    const refused = applyInput(task, await request.json<TaskInput>());
    if (refused) return refused;
    emit({ type: "task_changed", taskId: task.id });
    return json({ task: view(task) });
  }

  if (sub === "run") return error(demoOnlyMessage(), 501);

  if (sub === "runs") {
    const run = runId ? runs.find((candidate) => candidate.taskId === task.id && candidate.runId === runId) : undefined;
    if (runId && leaf === "seen") {
      if (!run) return json({ error: "Run not found" }, 404);
      run.seenAt ??= new Date().toISOString();
      emit({ type: "task_changed", taskId: task.id });
      return json({ run });
    }
    const before = request.query("before");
    const limit = Number(request.query("limit")) || 50;
    const own = runs
      .filter((candidate) => candidate.taskId === task.id && (!before || (candidate.startedAt ?? "") < before))
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    return json({ runs: own.slice(0, limit), hasMore: own.length > limit });
  }

  return error(`Not found: ${request.path}`, 404);
}

/** GET /api/scheduled-tasks/events: the scheduler's change stream. */
export function attachScheduledStream(source: MockEventSource): () => void {
  const listener = (event: ScheduledTaskEvent) => source.send(event);
  listeners.add(listener);
  source.send({ type: "scheduler_owner", owner: true });
  return () => listeners.delete(listener);
}
