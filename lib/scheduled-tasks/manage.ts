import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { emitScheduledTaskEvent } from "./events";
import { listRuns, listTasks, mutateTasks, deleteTask } from "./store";
import { applyTaskPatch, buildTask } from "./task-input";
import { toTaskView } from "./task-view";
import {
  ScheduledTaskValidationError,
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTaskEvent,
  type ScheduledTaskView,
  type TaskSchedule,
} from "./types";

/**
 * The operations behind the `scheduled_tasks` tool and the `/schedule` command
 * (`lib/scheduled-tasks-extension.ts`). They go through the same validation as
 * the HTTP routes (`task-input.ts`) and announce changes the same way, so the
 * Scheduled page follows a task the model or a command changed. Every failure
 * the caller can act on is a `ScheduledTaskValidationError`.
 */

export const SCHEDULE_ACTIONS = ["list", "get", "create", "update", "pause", "resume", "run", "delete", "runs"] as const;
export type ScheduleAction = typeof SCHEDULE_ACTIONS[number];

export interface ScheduleRequest {
  action: ScheduleAction;
  /** Task id, name, or an unambiguous part of its name. */
  task?: string;
  name?: string;
  description?: string;
  prompt?: string;
  cwd?: string;
  schedule?: { kind: string; expr?: string; timezone?: string; at?: string };
  toolPreset?: string;
  maxDurationMin?: number;
  /** `provider/modelId`. */
  model?: string;
}

export interface ScheduleActor {
  /** The session's working directory: where a new task runs unless `cwd` says otherwise. */
  cwd: string;
  /**
   * A scheduled run is unattended and must not be able to create, change or
   * delete tasks (a task that makes more tasks would multiply without bound).
   */
  unattended: boolean;
  /** Asks the user; false when there is nobody to ask. */
  confirm: (title: string, message: string) => Promise<boolean>;
}

export interface ScheduleDeps {
  agentDir?: string;
  now?: () => Date;
  emit?: (event: ScheduledTaskEvent) => void;
  runTask?: (taskId: string) => Promise<ScheduledRun>;
}

/** What a task created from a conversation gets when the request names no preset. */
const DEFAULT_CREATE_PRESET = "default";
const WRITE_PRESETS = new Set(["default", "full"]);
const MUTATING = new Set<ScheduleAction>(["create", "update", "pause", "resume", "run", "delete"]);

function fail(message: string): never {
  throw new ScheduledTaskValidationError(message);
}

async function defaultRunTask(taskId: string): Promise<ScheduledRun> {
  const { getScheduler } = await import("./index");
  return (await getScheduler().runNow(taskId)).run;
}

/** Find a task by id, then exact name, then a part of the name that only one task contains. */
export function resolveTask(tasks: readonly ScheduledTask[], reference: string | undefined): ScheduledTask {
  const ref = reference?.trim();
  if (!ref) return fail("task is required: give a task id or name (use action \"list\" to see them)");
  const byId = tasks.find((task) => task.id === ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  const exact = tasks.filter((task) => task.name.trim().toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = exact.length > 1 ? exact : tasks.filter((task) =>
    task.name.toLowerCase().includes(lower) || (lower.length >= 6 && task.id.startsWith(lower)));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) return fail(`No scheduled task matches "${ref}"`);
  return fail(`"${ref}" matches several tasks: ${partial.map((task) => `${task.name} (${task.id})`).join(", ")}`);
}

export function describeSchedule(schedule: TaskSchedule): string {
  if (schedule.kind === "cron") return `cron "${schedule.expr}" (${schedule.timezone})`;
  if (schedule.kind === "once") return `once at ${schedule.at}`;
  return "manual (runs only on request)";
}

function describeState(view: ScheduledTaskView): string {
  if (view.enabled) return view.nextRunAt ? `on, next run ${view.nextRunAt}` : "on";
  return view.autoPausedReason ? `paused after repeated failures (${view.autoPausedReason})` : "paused";
}

function describeLastRun(view: ScheduledTaskView): string {
  const run = view.lastRun;
  if (!run) return "never run";
  const at = run.endedAt ?? run.startedAt ?? run.scheduledFor;
  return `${run.status}${at ? ` at ${at}` : ""}${run.error ? `: ${run.error}` : ""}`;
}

function summarizeTask(view: ScheduledTaskView): string {
  return `- ${view.name} [${view.id}]: ${describeSchedule(view.schedule)}; ${describeState(view)}; last run: ${describeLastRun(view)}`;
}

function detailTask(view: ScheduledTaskView): string {
  const lines = [
    `${view.name} [${view.id}]`,
    `Schedule: ${describeSchedule(view.schedule)}`,
    `State: ${describeState(view)}`,
    `Last run: ${describeLastRun(view)}`,
    `Directory: ${view.cwd}`,
    `Tools: ${view.toolPreset}`,
    `Time limit: ${view.maxDurationMin} minutes`,
  ];
  if (view.model) lines.push(`Model: ${view.model.provider}/${view.model.modelId}`);
  if (view.description) lines.push(`Description: ${view.description}`);
  lines.push(`Prompt: ${view.prompt}`);
  return lines.join("\n");
}

function parseModel(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) fail("model must be provider/modelId");
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/** The body `buildTask` / `applyTaskPatch` take: only the fields the request set. */
function toInput(request: ScheduleRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (request.name !== undefined) input.name = request.name;
  if (request.description !== undefined) input.description = request.description;
  if (request.prompt !== undefined) input.prompt = request.prompt;
  if (request.cwd !== undefined) input.cwd = request.cwd;
  if (request.schedule !== undefined) input.schedule = request.schedule;
  if (request.toolPreset !== undefined) input.toolPreset = request.toolPreset;
  if (request.maxDurationMin !== undefined) input.maxDurationMin = request.maxDurationMin;
  if (request.model !== undefined) input.model = parseModel(request.model);
  return input;
}

/**
 * A preset that can change files or run commands makes the task do so with
 * nobody watching. The user, not the model, has to say yes to that.
 */
async function acknowledgeWrites(
  preset: unknown,
  name: string,
  actor: ScheduleActor,
  input: Record<string, unknown>,
): Promise<void> {
  if (typeof preset !== "string" || !WRITE_PRESETS.has(preset)) return;
  const allowed = await actor.confirm(
    "Allow unattended writes?",
    `The scheduled task "${name}" will run with the "${preset}" tools, which can change files and run commands, with nobody watching. Allow it?`,
  );
  if (!allowed) fail(`The user did not allow unattended writes, so "${name}" was not saved. Use toolPreset "read-only" instead.`);
  input.acknowledgeUnattendedWrites = true;
}

function runLine(run: ScheduledRun): string {
  const at = run.startedAt ?? run.scheduledFor ?? "";
  const detail = run.error ? `: ${run.error}` : run.skipReason ? ` (${run.skipReason})` : "";
  return `- ${at} ${run.trigger} ${run.status}${detail}${run.sessionId ? ` [session ${run.sessionId}]` : ""}`;
}

/** Run one action and return the text to show. */
export async function executeScheduleAction(
  request: ScheduleRequest,
  actor: ScheduleActor,
  deps: ScheduleDeps = {},
): Promise<string> {
  const agentDir = deps.agentDir ?? getAgentDir();
  const now = deps.now?.() ?? new Date();
  const emit = deps.emit ?? emitScheduledTaskEvent;
  const view = (task: ScheduledTask) => toTaskView(task, now, agentDir);

  if (!SCHEDULE_ACTIONS.includes(request.action)) fail(`action must be one of ${SCHEDULE_ACTIONS.join(", ")}`);
  if (actor.unattended && MUTATING.has(request.action)) {
    fail("Scheduled runs run unattended and cannot change scheduled tasks. Ask the user to do it from a normal session.");
  }

  switch (request.action) {
    case "list": {
      const tasks = listTasks(agentDir);
      return tasks.length
        ? `${tasks.length} scheduled task${tasks.length === 1 ? "" : "s"}:\n${tasks.map((task) => summarizeTask(view(task))).join("\n")}`
        : "No scheduled tasks.";
    }
    case "get":
      return detailTask(view(resolveTask(listTasks(agentDir), request.task)));
    case "runs": {
      const task = resolveTask(listTasks(agentDir), request.task);
      const runs = listRuns(task.id, agentDir).slice(-10).reverse();
      return runs.length ? `Latest runs of "${task.name}":\n${runs.map(runLine).join("\n")}` : `"${task.name}" has not run yet.`;
    }
    case "create": {
      const input = toInput(request);
      input.cwd ??= actor.cwd;
      input.toolPreset ??= DEFAULT_CREATE_PRESET;
      await acknowledgeWrites(input.toolPreset, String(input.name ?? ""), actor, input);
      const task = mutateTasks((tasks) => {
        const created = buildTask(input, { now, otherNames: tasks.map((existing) => existing.name) });
        return { tasks: [...tasks, created], result: created };
      }, agentDir);
      emit({ type: "task_changed", taskId: task.id });
      return `Created scheduled task.\n${detailTask(view(task))}`;
    }
    case "update": {
      const target = resolveTask(listTasks(agentDir), request.task);
      const patch = toInput(request);
      if (Object.keys(patch).length === 0) fail("Nothing to update: set at least one field besides task");
      if (typeof patch.toolPreset === "string" && patch.toolPreset !== target.toolPreset) {
        await acknowledgeWrites(patch.toolPreset, target.name, actor, patch);
      }
      const updated = mutateTasks((tasks) => {
        const index = tasks.findIndex((task) => task.id === target.id);
        if (index === -1) return fail("The task was deleted meanwhile");
        const others = tasks.filter((_, position) => position !== index).map((task) => task.name);
        const next = [...tasks];
        next[index] = applyTaskPatch(tasks[index], patch, { now, otherNames: others });
        return { tasks: next, result: next[index] };
      }, agentDir);
      emit({ type: "task_changed", taskId: updated.id });
      return `Updated scheduled task.\n${detailTask(view(updated))}`;
    }
    case "pause":
    case "resume": {
      const target = resolveTask(listTasks(agentDir), request.task);
      const enabled = request.action === "resume";
      const updated = mutateTasks((tasks) => {
        const index = tasks.findIndex((task) => task.id === target.id);
        if (index === -1) return fail("The task was deleted meanwhile");
        const next = [...tasks];
        next[index] = applyTaskPatch(tasks[index], { enabled }, { now, otherNames: [] });
        return { tasks: next, result: next[index] };
      }, agentDir);
      emit({ type: "task_changed", taskId: updated.id });
      return `${enabled ? "Resumed" : "Paused"} "${updated.name}".\n${summarizeTask(view(updated))}`;
    }
    case "run": {
      const target = resolveTask(listTasks(agentDir), request.task);
      try {
        const run = await (deps.runTask ?? defaultRunTask)(target.id);
        return `Started "${target.name}"${run.sessionId ? ` in session ${run.sessionId}` : ""}. It runs in the background; see the Scheduled page for the result.`;
      } catch (error) {
        // "Already running" and the like are answers for the caller, not crashes.
        if (error instanceof Error && error.name === "RunRejectedError") fail(error.message);
        throw error;
      }
    }
    case "delete": {
      const target = resolveTask(listTasks(agentDir), request.task);
      const confirmed = await actor.confirm(
        "Delete scheduled task?",
        `Delete "${target.name}" and its run history? The sessions it produced stay as ordinary sessions.`,
      );
      if (!confirmed) fail(`The user did not confirm, so "${target.name}" was not deleted.`);
      deleteTask(target.id, { removeRuns: true }, agentDir);
      emit({ type: "task_changed", taskId: target.id });
      return `Deleted "${target.name}".`;
    }
  }
}

/**
 * Split `/schedule` arguments into an action and the rest. The first word names
 * the action (a few aliases are accepted); anything else is a request in plain
 * words, which only the model can turn into a task.
 */
export function parseScheduleCommand(args: string): { action: ScheduleAction | "help"; rest: string } | { freeText: string } {
  const text = args.trim();
  if (!text) return { action: "list", rest: "" };
  const first = text.split(/\s+/)[0];
  const rest = text.slice(first.length).trim();
  if (/^(new|create|add)$/i.test(first)) return { freeText: rest };
  const aliases: Record<string, ScheduleAction | "help"> = {
    list: "list", ls: "list", show: "get", get: "get", info: "get", runs: "runs", history: "runs",
    pause: "pause", stop: "pause", disable: "pause", resume: "resume", start: "resume", enable: "resume",
    run: "run", now: "run", delete: "delete", remove: "delete", rm: "delete", help: "help", "?": "help",
  };
  const action = aliases[first.toLowerCase()];
  if (!action) return { freeText: text };
  return { action, rest };
}
