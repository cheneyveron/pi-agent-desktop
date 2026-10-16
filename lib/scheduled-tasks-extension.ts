import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionContext,
  type InlineExtension,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { isReadOnlySelection } from "./mcp-read-only-policy";
import { SCHEDULED_RUN_ENTRY_TYPE } from "./scheduled-tasks/runner";
import {
  SCHEDULE_ACTIONS,
  executeScheduleAction,
  parseScheduleCommand,
  type ScheduleActor,
  type ScheduleDeps,
  type ScheduleRequest,
} from "./scheduled-tasks/manage";
import { MAX_DURATION_MINUTES } from "./scheduled-tasks/types";
import { readSessionToolSelection } from "./session-tool-selection";
import type { SessionEntry } from "./types";

export const SCHEDULED_TASKS_EXTENSION_NAME = "pi-web-scheduled-tasks";
export const SCHEDULED_TASKS_TOOL_NAME = "scheduled_tasks";
export const SCHEDULE_COMMAND_NAME = "schedule";

/**
 * `model-only`: a codemode script cannot call it, so every change to a task
 * is a tool call of its own in the transcript (and shows the user's dialogs).
 */
const SCHEDULED_TASKS_TOOL_EXPOSURE = "model-only" satisfies ToolExposure;

const READ_ACTIONS = new Set(["list", "get", "runs"]);

const COMMAND_HELP = [
  "/schedule — list the scheduled tasks",
  "/schedule show <task> — details of one task",
  "/schedule runs <task> — its latest runs",
  "/schedule run <task> — run it now",
  "/schedule pause <task> · /schedule resume <task>",
  "/schedule delete <task>",
  "/schedule new <what and when> — describe a task in words; the assistant creates it",
].join("\n");

function sessionEntries(ctx: ExtensionContext): SessionEntry[] {
  return ctx.sessionManager.getEntries() as unknown as SessionEntry[];
}

/** Whether this session is the product of a scheduled run (the runner tags it with a custom entry). */
function isScheduledRunSession(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getEntries().some((entry) =>
    (entry as { type?: string; customType?: string }).type === "custom"
    && (entry as { customType?: string }).customType === SCHEDULED_RUN_ENTRY_TYPE);
}

function actorFor(ctx: ExtensionContext): ScheduleActor {
  return {
    cwd: ctx.cwd,
    unattended: isScheduledRunSession(ctx),
    confirm: async (title, message) => ctx.hasUI ? await ctx.ui.confirm(title, message) : false,
  };
}

function readOnlyBlock(action: string, ctx: ExtensionContext): string | undefined {
  if (READ_ACTIONS.has(action)) return undefined;
  // A Read-only selection promises that the session changes nothing.
  if (!isReadOnlySelection(readSessionToolSelection(sessionEntries(ctx)))) return undefined;
  return "This session uses a read-only tool selection, so it can look at scheduled tasks but not change or run them. Switch the session to a preset that allows changes first.";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `scheduled_tasks` tool and the `/schedule` command: managing the tasks
 * of the Scheduled page from a conversation. The tool is for the model (create,
 * edit, pause, run, delete on the user's behalf); the command gives the user
 * the quick actions directly and hands a task description to the model.
 */
export function createScheduledTasksExtension(deps: ScheduleDeps = {}): InlineExtension {
  return {
    name: SCHEDULED_TASKS_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: SCHEDULED_TASKS_TOOL_NAME,
        label: "Scheduled tasks",
        description:
          "Manage Pi Web's scheduled tasks: prompts that start a fresh session on a schedule (cron), once, or on demand. "
          + "Actions: list, get, create, update, pause, resume, run (start now), delete, runs (recent run history). "
          + "A task is identified by its id or name. A new task runs in the current directory unless cwd is given, "
          + "with the default tool preset unless toolPreset says otherwise (default and full can change files, so the user is asked to approve them). "
          + "Cron is five fields, runs must be at least 5 minutes apart, and the timezone defaults to the system's.",
        promptSnippet: "List, create, edit, pause, run and delete the user's scheduled tasks",
        exposure: SCHEDULED_TASKS_TOOL_EXPOSURE,
        promptGuidelines: [
          "Use scheduled_tasks only when the user asks to schedule something, or to look at or change their scheduled tasks. Do not create tasks on your own initiative.",
          "Write a scheduled task's prompt so it stands alone: it runs in a new session that has none of this conversation.",
          "Before creating a task, say back the schedule you understood (cron in the user's words) if the request was ambiguous, then create it.",
        ],
        parameters: Type.Object({
          action: Type.Union(SCHEDULE_ACTIONS.map((action) => Type.Literal(action)), { description: "What to do." }),
          task: Type.Optional(Type.String({ description: "Task id or name (a unique part of the name works). Required for every action except list and create." })),
          name: Type.Optional(Type.String({ description: "Task name, unique among tasks. Required for create." })),
          description: Type.Optional(Type.String({ description: "Short description of the task." })),
          prompt: Type.Optional(Type.String({ description: "The message every run starts with. Required for create." })),
          cwd: Type.Optional(Type.String({ description: "Absolute directory the runs work in. Default: this session's directory." })),
          schedule: Type.Optional(Type.Object({
            kind: Type.Union([Type.Literal("manual"), Type.Literal("cron"), Type.Literal("once")], { description: "manual: only runs on request; cron: recurring; once: one time." }),
            expr: Type.Optional(Type.String({ description: "Five-field cron expression (kind cron), e.g. \"0 9 * * 1-5\"." })),
            timezone: Type.Optional(Type.String({ description: "IANA timezone for the cron expression, e.g. \"Asia/Shanghai\"." })),
            at: Type.Optional(Type.String({ description: "ISO 8601 time in the future (kind once)." })),
          }, { description: "When to run. Required for create." })),
          toolPreset: Type.Optional(Type.Union([
            Type.Literal("none"), Type.Literal("read-only"), Type.Literal("default"), Type.Literal("full"),
          ], { description: "Tools the runs get. Default \"default\"; default and full can change files and need the user's approval, read-only and none do not." })),
          maxDurationMin: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DURATION_MINUTES, description: "Time limit of one run in minutes. Default 30." })),
          model: Type.Optional(Type.String({ description: "provider/modelId for the runs. Default: the app's default model." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const blocked = readOnlyBlock(params.action, ctx);
          if (blocked) return { content: [{ type: "text", text: blocked }], details: undefined, isError: true };
          try {
            const text = await executeScheduleAction(params as ScheduleRequest, actorFor(ctx), deps);
            return { content: [{ type: "text", text }], details: undefined };
          } catch (error) {
            return { content: [{ type: "text", text: errorText(error) }], details: undefined, isError: true };
          }
        },
      }));

      pi.registerCommand(SCHEDULE_COMMAND_NAME, {
        description: "Manage scheduled tasks: list, show, run, pause, resume, delete, or describe a new one",
        getArgumentCompletions: (prefix) => {
          if (/\s/.test(prefix)) return null;
          const words = ["list", "show", "runs", "run", "pause", "resume", "delete", "new", "help"];
          const matches = words.filter((word) => word.startsWith(prefix.toLowerCase()));
          return matches.length ? matches.map((word) => ({ value: word, label: word })) : null;
        },
        handler: async (args, ctx) => {
          const parsed = parseScheduleCommand(args);
          if ("freeText" in parsed) {
            if (!parsed.freeText) {
              ctx.ui.notify(COMMAND_HELP, "info");
              return;
            }
            // Turning words into a schedule is the model's job; it ends in the tool.
            pi.sendUserMessage(
              `Use the ${SCHEDULED_TASKS_TOOL_NAME} tool to handle this scheduled-task request: ${parsed.freeText}`,
            );
            return;
          }
          if (parsed.action === "help") {
            ctx.ui.notify(COMMAND_HELP, "info");
            return;
          }
          const blocked = readOnlyBlock(parsed.action, ctx);
          if (blocked) {
            ctx.ui.notify(blocked, "warning");
            return;
          }
          try {
            const text = await executeScheduleAction({ action: parsed.action, ...(parsed.rest ? { task: parsed.rest } : {}) }, actorFor(ctx), deps);
            ctx.ui.notify(text, "info");
          } catch (error) {
            ctx.ui.notify(errorText(error), "error");
          }
        },
      });
    },
  };
}
