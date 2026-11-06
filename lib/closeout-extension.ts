import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { isChatWorkspacePath } from "./chat-workspace";
import { CLOSEOUT_PROMPT } from "./closeout-prompt.generated";
import {
  CLOSEOUT_ENTRY_TYPE,
  isCloseoutEntryData,
  MAIN_SESSION_NOTE_TYPE,
  type Closeout,
  type CloseoutAnswerTarget,
  type CloseoutDelivery,
  type CloseoutEntryData,
  type CloseoutLearned,
  type CloseoutNextItem,
  type CloseoutOpenQuestion,
  type CloseoutPayload,
  type CloseoutRange,
  type CloseoutRun,
  type CloseoutTrigger,
  type CloseoutUserSaid,
  type CloseoutUserSaidKind,
} from "./closeout-types";
import { resolveTitleThinkingLevel } from "./session-title";
import { userHome } from "./user-home";

// The close-out extension (`builtin:closeout`): at the end of a stretch of
// work it asks the session's own model, in a request outside the conversation,
// to summarize what happened since the previous close-out, records the result
// as a `closeout` custom entry, and hands it to the main-session service.
// Contract: docs/proposals/2026-11-06-main-session-v1.md §4.

export const CLOSEOUT_EXTENSION_NAME = "closeout";
export const MAIN_SESSION_DISABLE_VARIABLE = "PI_WEB_DISABLE_MAIN_SESSION";
export const DEFAULT_MAIN_SESSION_PORT = 30180;
export const CLOSEOUT_IDLE_MS = 5 * 60_000;
/** How long `session_shutdown` waits for a close-out before the entry is deferred to the next open. */
export const CLOSEOUT_SHUTDOWN_WAIT_MS = 2_000;

const MODEL_TIMEOUT_MS = 120_000;
const MODEL_MAX_TOKENS = 8_192;
const POST_TIMEOUT_MS = 5_000;
/** Models a request through rdsec may use (contract §0). */
const RDSEC_PROVIDER = "rdsec";
const RDSEC_ALLOWED_MODELS = new Set(["claude-haiku-5-5", "gpt-6-luna"]);
const RDSEC_FALLBACK_MODEL = "claude-haiku-5-5";

// Transcript bounds, as in the prompt experiments (closeout/build_transcripts.py).
const TRANSCRIPT_MAX_CHARS = 150_000;
const TRANSCRIPT_HEAD_CHARS = 20_000;
const TOOL_RESULT_CHARS = 300;
const TOOL_ARG_CHARS = 120;
const SUMMARY_CHARS = 2_000;
const MAX_FILES_READ = 200;
const FILE_TOOL_NAMES = new Set(["read", "edit", "write", "multi_edit"]);

// ---------------------------------------------------------------------------
// Where things live
// ---------------------------------------------------------------------------

/** Any value but empty, `0` or `false` turns the main session off, as `PI_WEB_DISABLE_MCP` does for MCP. */
export function isMainSessionDisabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment[MAIN_SESSION_DISABLE_VARIABLE]?.trim().toLowerCase();
  if (value !== undefined && value !== "" && value !== "0" && value !== "false") return true;
  // `node --test` runs sessions with real built-ins; they must not post to a service on this machine.
  return environment.NODE_TEST_CONTEXT !== undefined && environment.PI_WEB_MAIN_SESSION_IN_TESTS !== "1";
}

export function mainSessionUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.MAIN_SESSION_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = Number.parseInt(environment.MAIN_SESSION_PORT ?? "", 10);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : DEFAULT_MAIN_SESSION_PORT}`;
}

export function mainSessionDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, "main");
}

export function closeoutOutboxDir(agentDir: string = getAgentDir()): string {
  return join(mainSessionDir(agentDir), "outbox");
}

/** Close-outs finished after their session closed wait here until it opens again. */
function deferredEntriesDir(agentDir: string, sessionId: string): string {
  return join(mainSessionDir(agentDir), "deferred-entries", sessionId.replace(/[^\w.-]/g, "_"));
}

function safeFileName(id: string): string {
  return `${id.replace(/[^\w.-]/g, "_")}.json`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Which entries a close-out covers
// ---------------------------------------------------------------------------

/** The structural subset of a session entry this file reads. */
export interface CloseoutSourceEntry {
  type: string;
  id: string;
  parentId?: string | null;
  customType?: string;
  data?: unknown;
  content?: unknown;
  display?: boolean;
  summary?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    isError?: boolean;
    command?: string;
    output?: string;
  };
}

/** Entries that carry conversation: messages (not transcript system messages), custom messages and summaries. */
export function isCloseoutTranscriptEntry(entry: CloseoutSourceEntry): boolean {
  if (entry.type === "message") return entry.message?.role !== undefined && entry.message.role !== "system";
  return entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";
}

function closeoutDataOf(entry: CloseoutSourceEntry): CloseoutEntryData | undefined {
  return entry.type === "custom" && entry.customType === CLOSEOUT_ENTRY_TYPE && isCloseoutEntryData(entry.data)
    ? entry.data
    : undefined;
}

/** The newest close-out recorded on this branch. */
export function latestCloseoutOnBranch(branch: readonly CloseoutSourceEntry[]): CloseoutEntryData | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const data = closeoutDataOf(branch[index]);
    if (data) return data;
  }
  return undefined;
}

export interface CloseoutSelection {
  range: CloseoutRange;
  entries: CloseoutSourceEntry[];
}

/**
 * The branch entries no close-out has covered yet. A close-out covers its
 * range up to `toEntryId`; when that entry is not on this branch (the user
 * moved to another branch since), the close-out entry's own position marks
 * it. `memoryMark` is a close-out this extension produced whose entry is not
 * on the branch yet. Returns undefined when nothing new is there.
 */
export function selectCloseoutRange(
  branch: readonly CloseoutSourceEntry[],
  memoryMark?: string,
): CloseoutSelection | undefined {
  const indexById = new Map<string, number>();
  branch.forEach((entry, index) => indexById.set(entry.id, index));
  let markIndex = -1;
  branch.forEach((entry, index) => {
    const data = closeoutDataOf(entry);
    if (!data) return;
    markIndex = Math.max(markIndex, indexById.get(data.range.toEntryId) ?? index);
  });
  if (memoryMark !== undefined) markIndex = Math.max(markIndex, indexById.get(memoryMark) ?? -1);
  const start = markIndex + 1;
  const entries = branch.slice(start).filter(isCloseoutTranscriptEntry);
  if (entries.length === 0) return undefined;
  return {
    range: {
      afterEntryId: start > 0 ? branch[start - 1].id : null,
      toEntryId: entries[entries.length - 1].id,
      entries: entries.length,
    },
    entries,
  };
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface CloseoutTranscript {
  text: string;
  filesRead: string[];
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
}

function clip(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max).join("")}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: string; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    else if (typed.type === "image") parts.push("[image]");
  }
  return parts.join("\n").trim();
}

function formatArgument(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return clip(oneLine(text), TOOL_ARG_CHARS);
}

/** Paths the transcript shows a file tool opening, relative to the repository (cwd) or the home directory. */
export function closeoutRelativePath(path: string, cwd: string, home: string = userHome()): string {
  if (!isAbsolute(path)) return path.replace(/^\.\//, "");
  const inCwd = relative(cwd, path);
  if (inCwd && !inCwd.startsWith("..") && !isAbsolute(inCwd)) return inCwd.split(sep).join("/");
  const inHome = relative(home, path);
  if (inHome && !inHome.startsWith("..") && !isAbsolute(inHome)) return inHome.split(sep).join("/");
  return path;
}

function boundTranscript(text: string): string {
  if (text.length <= TRANSCRIPT_MAX_CHARS) return text;
  const tail = TRANSCRIPT_MAX_CHARS - TRANSCRIPT_HEAD_CHARS;
  return `${text.slice(0, TRANSCRIPT_HEAD_CHARS)}\n\n[… ${text.length - TRANSCRIPT_MAX_CHARS} characters omitted …]\n\n${text.slice(-tail)}`;
}

/**
 * Plain text the close-out model reads: user and assistant text verbatim,
 * one line per tool call, tool results cut to 300 characters, thinking
 * dropped. Long transcripts keep their first 20k and last 130k characters.
 */
export function buildCloseoutTranscript(entries: readonly CloseoutSourceEntry[], cwd: string): CloseoutTranscript {
  const lines: string[] = [];
  const files = new Set<string>();
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const summary = entry.summary?.trim();
      if (summary) lines.push(`[EARLIER SUMMARY] ${clip(summary, SUMMARY_CHARS)}`);
      continue;
    }
    if (entry.type === "custom_message") {
      const text = textOf(entry.content);
      if (!text) continue;
      const label = entry.customType === MAIN_SESSION_NOTE_TYPE ? "MAIN SESSION NOTE" : `NOTE ${entry.customType ?? ""}`.trim();
      lines.push(`[${label}] ${clip(text, SUMMARY_CHARS)}`);
      continue;
    }
    const message = entry.message;
    if (!message) continue;
    switch (message.role) {
      case "user": {
        const text = textOf(message.content);
        if (!text) break;
        userMessages += 1;
        lines.push(`USER: ${text}`);
        break;
      }
      case "assistant": {
        if (!Array.isArray(message.content)) {
          const text = textOf(message.content);
          if (text) { assistantMessages += 1; lines.push(`ASSISTANT: ${text}`); }
          break;
        }
        const parts: string[] = [];
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            parts.push(block.text.trim());
          } else if (block?.type === "toolCall") {
            toolCalls += 1;
            const name = String(block.name ?? block.toolName ?? "tool");
            const args = (block.arguments ?? block.input ?? {}) as Record<string, unknown>;
            const argText = typeof args === "object" && args !== null
              ? Object.entries(args).map(([key, value]) => `${key}=${formatArgument(value)}`).join(", ")
              : formatArgument(args);
            parts.push(`[tool ${name}${argText ? `: ${argText}` : ""}]`);
            const path = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : undefined;
            if (path && FILE_TOOL_NAMES.has(name) && files.size < MAX_FILES_READ) files.add(closeoutRelativePath(path, cwd));
          }
        }
        if (parts.length === 0) break;
        assistantMessages += 1;
        lines.push(`ASSISTANT: ${parts.join("\n")}`);
        break;
      }
      case "toolResult": {
        const text = oneLine(textOf(message.content));
        lines.push(`[result ${message.toolName ?? "tool"}${message.isError ? " (error)" : ""}: ${clip(text, TOOL_RESULT_CHARS)}]`);
        break;
      }
      case "bashExecution": {
        userMessages += 1;
        lines.push(`USER ran \`${message.command ?? ""}\`: ${clip(oneLine(message.output ?? ""), TOOL_RESULT_CHARS)}`);
        break;
      }
      case "custom": {
        const text = textOf(message.content);
        if (text) lines.push(`[NOTE] ${clip(text, SUMMARY_CHARS)}`);
        break;
      }
      default:
        break;
    }
  }
  return {
    text: boundTranscript(lines.join("\n\n")),
    filesRead: [...files],
    userMessages,
    assistantMessages,
    toolCalls,
  };
}

/** Whether a trigger has enough new work to close out. The idle trigger needs tool activity (contract §4). */
export function shouldCloseOut(trigger: CloseoutTrigger, transcript: CloseoutTranscript): boolean {
  if (transcript.assistantMessages === 0) return false;
  if (trigger === "idle") return transcript.toolCalls > 0;
  return transcript.userMessages > 0;
}

export function buildCloseoutUserPrompt(input: {
  cwd: string;
  sessionName?: string;
  transcript: CloseoutTranscript;
  previous?: Closeout;
}): string {
  const { cwd, sessionName, transcript, previous } = input;
  const sections = [`## SESSION\n\ncwd: ${cwd}${sessionName ? `\nname: ${sessionName}` : ""}`];
  if (previous) {
    const background = { thread: previous.thread, stands: previous.stands, next: previous.next, open: previous.open };
    sections.push(`## PREVIOUS CLOSE-OUT (background; the transcript starts after it)\n\n${JSON.stringify(background, null, 2)}`);
  }
  sections.push(`## FILES_READ (files this session actually read)\n\n${transcript.filesRead.length ? transcript.filesRead.map((path) => `- ${path}`).join("\n") : "(none)"}`);
  sections.push(`## TRANSCRIPT\n\n${transcript.text}`);
  sections.push("Return the close-out JSON object now.");
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// The model's answer
// ---------------------------------------------------------------------------

export type CloseoutFields = Omit<Closeout, "sessionId" | "cwd" | "t">;

const RUNS: readonly CloseoutRun[] = ["me", "agent", "notify", "checker"];
const KINDS: readonly CloseoutUserSaidKind[] = ["correction", "preference", "instruction"];
const TARGETS: readonly CloseoutAnswerTarget[] = ["task", "session", "memory"];

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "null" ? trimmed : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `pr #752` for any spelling of a PR reference: `PR 752`, `#752`, `.../pull/752`. */
export function normalizePrCondition(on: string): string {
  const pull = on.match(/\/pull\/(\d+)/);
  if (pull) return `pr #${pull[1]}`;
  const pr = on.match(/^(?:pr|pull request)?\s*#?\s*(\d+)$/i);
  return pr ? `pr #${pr[1]}` : on;
}

function prNumbersIn(text: string): string[] {
  const numbers = new Set<string>();
  for (const match of text.matchAll(/\b(?:PR|pull request)\s*#?(\d+)|\/pull\/(\d+)/gi)) numbers.add(match[1] ?? match[2]);
  return [...numbers];
}

function parseNext(value: unknown): CloseoutNextItem | undefined {
  if (typeof value === "string") return str(value) ? { text: value.trim(), run: "me" } : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const text = str(raw.text);
  if (!text) return undefined;
  const run = RUNS.includes(raw.run as CloseoutRun) ? raw.run as CloseoutRun : "me";
  let on = str(raw.on);
  if (on) on = normalizePrCondition(on);
  else {
    // A PR number in the item is the condition it waits on (contract §4: "看到 PR 号就写 on: pr #N").
    const prs = prNumbersIn(text);
    if (prs.length === 1) on = `pr #${prs[0]}`;
  }
  return { text, run, ...(on ? { on } : {}), ...(raw.done === true ? { done: true } : {}) };
}

function parseLearned(value: unknown): CloseoutLearned | undefined {
  if (typeof value === "string") return str(value) ? { text: value.trim() } : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const text = str(raw.text);
  if (!text) return undefined;
  const anchors = list(raw.anchors).flatMap((anchor) => {
    if (typeof anchor !== "object" || anchor === null) return [];
    const path = str((anchor as Record<string, unknown>).path);
    const symbol = str((anchor as Record<string, unknown>).symbol);
    return path ? [{ path, ...(symbol ? { symbol } : {}) }] : [];
  }).slice(0, 3);
  return { text, ...(anchors.length ? { anchors } : {}) };
}

function parseUserSaid(value: unknown): CloseoutUserSaid | undefined {
  if (typeof value === "string") return str(value) ? { text: value.trim(), kind: "instruction" } : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const text = str(raw.text) ?? str(raw.quote);
  if (!text) return undefined;
  return { text, kind: KINDS.includes(raw.kind as CloseoutUserSaidKind) ? raw.kind as CloseoutUserSaidKind : "instruction" };
}

function parseOpen(value: unknown): CloseoutOpenQuestion | undefined {
  if (typeof value === "string") return str(value) ? { question: value.trim(), who: "unknown", answerGoesTo: "task" } : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const question = str(raw.question) ?? str(raw.text);
  if (!question) return undefined;
  const then = str(raw.then);
  return {
    question,
    who: str(raw.who) ?? "unknown",
    answerGoesTo: TARGETS.includes(raw.answerGoesTo as CloseoutAnswerTarget) ? raw.answerGoesTo as CloseoutAnswerTarget : "task",
    ...(then ? { then } : {}),
  };
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** Parse and normalize the model's JSON. Throws when there is no object with a `stands` paragraph. */
export function parseCloseoutResponse(raw: string): CloseoutFields {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the close-out model returned no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`the close-out model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the close-out is not an object");
  const object = parsed as Record<string, unknown>;
  const stands = str(object.stands);
  if (!stands) throw new Error("the close-out has no stands paragraph");
  const nextTime = list(object.next_time).map(str).filter(defined);
  return {
    thread: str(object.thread) ?? "none",
    stands,
    next: list(object.next).map(parseNext).filter(defined),
    produced: list(object.produced).map(str).filter(defined),
    learned: list(object.learned).map(parseLearned).filter(defined),
    user_said: list(object.user_said).map(parseUserSaid).filter(defined),
    open: list(object.open).map(parseOpen).filter(defined),
    ...(nextTime.length ? { next_time: nextTime } : {}),
  };
}

// ---------------------------------------------------------------------------
// The hidden turn
// ---------------------------------------------------------------------------

type CloseoutModelContext = Pick<ExtensionContext, "model" | "modelRegistry">;

/**
 * The session's own model. Through rdsec only the allowed models may be
 * called (contract §0), so a session on another rdsec model closes out on
 * haiku. Undefined when there is no model with credentials.
 */
export function resolveCloseoutModel(ctx: CloseoutModelContext): Model<Api> | undefined {
  let model = ctx.model as Model<Api> | undefined;
  if (!model) return undefined;
  if (model.provider === RDSEC_PROVIDER && !RDSEC_ALLOWED_MODELS.has(model.id)) {
    model = ctx.modelRegistry.find(RDSEC_PROVIDER, RDSEC_FALLBACK_MODEL);
    if (!model) return undefined;
  }
  return ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
}

export type CloseoutCompleter = (ctx: CloseoutModelContext, model: Model<Api>, userText: string) => Promise<string>;

function assistantText(message: AssistantMessage): string {
  if (message.stopReason === "error") throw new Error(message.errorMessage || "the close-out model request failed");
  if (message.stopReason === "aborted") throw new Error("the close-out model request timed out");
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
  if (!text) throw new Error("the close-out model returned no text");
  return text;
}

/** One request outside the conversation: the prompt, one user turn, no tools, no cache. */
export const completeCloseoutWithModel: CloseoutCompleter = async (ctx, model, userText) => {
  const thinkingLevel = resolveTitleThinkingLevel(model);
  const context: Context = {
    systemPrompt: CLOSEOUT_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  timer.unref?.();
  try {
    const stream = ctx.modelRegistry.streamSimple(model, context, {
      maxTokens: MODEL_MAX_TOKENS,
      cacheRetention: "none",
      sessionId: randomUUID(),
      signal: controller.signal,
      ...(thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    });
    return assistantText(await stream.result());
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Delivery and the outbox
// ---------------------------------------------------------------------------

export interface CloseoutDeliveryOptions {
  url?: string;
  outboxDir?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

function deliveryFromResponse(body: unknown, at: string): CloseoutDelivery {
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const task = typeof record.task === "string"
    ? record.task
    : typeof (record.task as { id?: unknown } | undefined)?.id === "string" ? (record.task as { id: string }).id : undefined;
  const eventId = typeof (record.event as { id?: unknown } | undefined)?.id === "string" ? (record.event as { id: string }).id : undefined;
  return { status: "sent", at, ...(task ? { task } : {}), ...(eventId ? { eventId } : {}) };
}

async function postCloseout(payload: CloseoutPayload, options: CloseoutDeliveryOptions): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  return doFetch(`${options.url ?? mainSessionUrl()}/closeouts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.timeoutMs ?? POST_TIMEOUT_MS),
  });
}

/**
 * POST the close-out to the service; when it is down or refuses, write it to
 * the outbox for `replayCloseoutOutbox()`. Never throws.
 */
export async function deliverCloseout(payload: CloseoutPayload, options: CloseoutDeliveryOptions = {}): Promise<CloseoutDelivery> {
  const at = (options.now?.() ?? new Date()).toISOString();
  try {
    const response = await postCloseout(payload, options);
    if (response.ok) {
      const body = await response.json().catch(() => ({}));
      // The service is up: anything an earlier outage left behind can go now.
      void replayCloseoutOutbox(options).catch(() => {});
      return deliveryFromResponse(body, at);
    }
  } catch {
    // Not running, or not answering: queue it.
  }
  try {
    const outboxDir = options.outboxDir ?? closeoutOutboxDir();
    mkdirSync(outboxDir, { recursive: true });
    writeJsonAtomic(join(outboxDir, safeFileName(payload.id)), payload);
  } catch (error) {
    console.error(`[pi-web] could not queue close-out ${payload.id}:`, error instanceof Error ? error.message : error);
  }
  return { status: "queued", at };
}

export interface CloseoutReplayResult {
  sent: string[];
  rejected: string[];
  remaining: number;
}

const REPLAY_KEY: symbol = Symbol.for("pi-web.closeoutReplay");

/**
 * Send queued close-outs, oldest first. Stops at the first one the service
 * does not take (down, or a server error) and keeps it and the rest. One the
 * service rejects as malformed (4xx) moves to `outbox/rejected/` so it cannot
 * block the queue. One replay runs at a time per process.
 */
export function replayCloseoutOutbox(options: CloseoutDeliveryOptions = {}): Promise<CloseoutReplayResult> {
  const store = globalThis as unknown as Record<symbol, Map<string, Promise<CloseoutReplayResult>> | undefined>;
  const running = store[REPLAY_KEY] ??= new Map();
  const outboxDir = options.outboxDir ?? closeoutOutboxDir();
  const existing = running.get(outboxDir);
  if (existing) return existing;
  const replay = (async (): Promise<CloseoutReplayResult> => {
    const result: CloseoutReplayResult = { sent: [], rejected: [], remaining: 0 };
    if (!existsSync(outboxDir)) return result;
    const files = readdirSync(outboxDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ name, payload: readQueued(join(outboxDir, name)) }))
      .sort((a, b) => (a.payload?.t ?? "").localeCompare(b.payload?.t ?? "") || a.name.localeCompare(b.name));
    for (let index = 0; index < files.length; index++) {
      const { name, payload } = files[index];
      const path = join(outboxDir, name);
      if (!payload) {
        moveToRejected(outboxDir, name);
        result.rejected.push(name);
        continue;
      }
      let response: Response;
      try {
        response = await postCloseout(payload, options);
      } catch {
        result.remaining = files.length - index;
        break;
      }
      if (response.ok) {
        rmSync(path, { force: true });
        result.sent.push(payload.id);
      } else if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        moveToRejected(outboxDir, name);
        result.rejected.push(payload.id);
      } else {
        result.remaining = files.length - index;
        break;
      }
    }
    return result;
  })().finally(() => running.delete(outboxDir));
  running.set(outboxDir, replay);
  return replay;
}

function readQueued(path: string): CloseoutPayload | undefined {
  try {
    const payload = JSON.parse(readFileSync(path, "utf8")) as CloseoutPayload;
    return typeof payload?.id === "string" && typeof payload.sessionId === "string" ? payload : undefined;
  } catch {
    return undefined;
  }
}

function moveToRejected(outboxDir: string, name: string): void {
  const rejected = join(outboxDir, "rejected");
  mkdirSync(rejected, { recursive: true });
  renameSync(join(outboxDir, name), join(rejected, name));
}

// ---------------------------------------------------------------------------
// Deferred entries
// ---------------------------------------------------------------------------

/** Keep a close-out that finished after its session stopped accepting entries. */
export function deferCloseoutEntry(agentDir: string, sessionId: string, data: CloseoutEntryData): void {
  const dir = deferredEntriesDir(agentDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, safeFileName(data.id)), data);
}

/** Deferred close-outs of a session, oldest first; each is removed once `append` returns. */
export function flushDeferredCloseoutEntries(
  agentDir: string,
  sessionId: string,
  existingIds: ReadonlySet<string>,
  append: (data: CloseoutEntryData) => void,
): number {
  const dir = deferredEntriesDir(agentDir, sessionId);
  if (!existsSync(dir)) return 0;
  const items = readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((name) => {
    try {
      const data = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
      return isCloseoutEntryData(data) ? [{ name, data }] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => a.data.t.localeCompare(b.data.t));
  let appended = 0;
  for (const { name, data } of items) {
    if (!existingIds.has(data.id)) {
      append(data);
      appended += 1;
    }
    rmSync(join(dir, name), { force: true });
  }
  return appended;
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

export interface CloseoutExtensionOptions {
  /** Defaults to the SDK's agent directory, read when needed. */
  agentDir?: string;
  idleMs?: number;
  shutdownWaitMs?: number;
  /** Whether this session closes out. Default: not when the main session is off, and never in a chat. */
  enabled?: (cwd: string) => boolean;
  complete?: CloseoutCompleter;
  delivery?: CloseoutDeliveryOptions;
  now?: () => Date;
  log?: (message: string) => void;
}

function defaultEnabled(cwd: string): boolean {
  return !isMainSessionDisabled() && !isChatWorkspacePath(cwd);
}

/**
 * Close-out triggers (contract §4): five idle minutes after a run that used
 * tools, `session_shutdown` (not a reload), and the start of a compaction.
 * Each run covers only the entries since the previous close-out; runs of one
 * session never overlap.
 */
export function createCloseoutExtension(options: CloseoutExtensionOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const idleMs = options.idleMs ?? CLOSEOUT_IDLE_MS;
    const shutdownWaitMs = options.shutdownWaitMs ?? CLOSEOUT_SHUTDOWN_WAIT_MS;
    const enabled = options.enabled ?? defaultEnabled;
    const complete = options.complete ?? completeCloseoutWithModel;
    const now = options.now ?? (() => new Date());
    const log = options.log ?? ((message: string) => console.warn(`[pi-web] ${message}`));
    const agentDir = () => options.agentDir ?? getAgentDir();
    const delivery = () => ({ outboxDir: closeoutOutboxDir(agentDir()), now, ...options.delivery });

    let lastCtx: ExtensionContext | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let chain: Promise<void> = Promise.resolve();
    // A close-out this instance produced whose entry may not be on the branch yet.
    let memoryMark: string | undefined;
    let previous: Closeout | undefined;
    // After session_shutdown returns, the wrapper disposes the session and another may
    // open the file; entries finished later wait for the next open instead.
    let entriesClosed = false;

    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };

    const run = async (trigger: CloseoutTrigger, ctx: ExtensionContext): Promise<void> => {
      if (!enabled(ctx.cwd)) return;
      const sessionManager = ctx.sessionManager;
      const branch = sessionManager.getBranch() as unknown as CloseoutSourceEntry[];
      const selection = selectCloseoutRange(branch, memoryMark);
      if (!selection) return;
      const transcript = buildCloseoutTranscript(selection.entries, ctx.cwd);
      if (!shouldCloseOut(trigger, transcript)) return;
      const model = resolveCloseoutModel(ctx);
      if (!model) {
        log(`close-out skipped for session ${sessionManager.getSessionId()}: no model with credentials`);
        return;
      }
      const prior = previous ?? latestCloseoutOnBranch(branch)?.closeout;
      const userText = buildCloseoutUserPrompt({
        cwd: ctx.cwd,
        sessionName: sessionManager.getSessionName(),
        transcript,
        ...(prior ? { previous: prior } : {}),
      });
      const fields = parseCloseoutResponse(await complete(ctx, model, userText));
      const t = now().toISOString();
      const sessionId = sessionManager.getSessionId();
      const closeout: Closeout = { sessionId, cwd: ctx.cwd, t, ...fields };
      const id = `co_${randomUUID()}`;
      const sessionFile = sessionManager.getSessionFile();
      const payload: CloseoutPayload = {
        ...closeout,
        id,
        trigger,
        range: selection.range,
        ...(sessionFile ? { sessionFile } : {}),
      };
      const data: CloseoutEntryData = {
        v: 1,
        id,
        t,
        trigger,
        range: selection.range,
        model: { provider: model.provider, id: model.id },
        delivery: await deliverCloseout(payload, delivery()),
        closeout,
      };
      memoryMark = selection.range.toEntryId;
      previous = closeout;
      if (entriesClosed) deferCloseoutEntry(agentDir(), sessionId, data);
      else pi.appendEntry(CLOSEOUT_ENTRY_TYPE, data);
    };

    const trigger = (kind: CloseoutTrigger, ctx: ExtensionContext): Promise<void> => {
      const next = chain.then(() => run(kind, ctx)).catch((error) => {
        log(`close-out (${kind}) failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      chain = next;
      return next;
    };

    pi.on("session_start", (_event, ctx) => {
      lastCtx = ctx;
      if (!enabled(ctx.cwd)) return;
      const sessionId = ctx.sessionManager.getSessionId();
      const existing = new Set(
        (ctx.sessionManager.getEntries() as unknown as CloseoutSourceEntry[])
          .map(closeoutDataOf)
          .filter(defined)
          .map((data) => data.id),
      );
      try {
        flushDeferredCloseoutEntries(agentDir(), sessionId, existing, (data) => pi.appendEntry(CLOSEOUT_ENTRY_TYPE, data));
      } catch (error) {
        log(`could not restore deferred close-outs: ${error instanceof Error ? error.message : String(error)}`);
      }
      void replayCloseoutOutbox(delivery()).catch(() => {});
    });

    pi.on("agent_start", () => clearIdle());

    pi.on("agent_settled", (_event, ctx) => {
      lastCtx = ctx;
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        const current = lastCtx;
        if (current && current.isIdle() && !entriesClosed) void trigger("idle", current);
      }, idleMs);
      idleTimer.unref?.();
    });

    pi.on("session_before_compact", (_event, ctx) => {
      // The branch keeps every entry through compaction, so this never holds it up.
      void trigger("compaction", ctx);
      return undefined;
    });

    pi.on("session_shutdown", async (event, ctx) => {
      clearIdle();
      if (event.reason === "reload") return;
      const done = trigger("shutdown", ctx);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, shutdownWaitMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      entriesClosed = true;
    });
  };
}
