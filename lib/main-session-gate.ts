// The write gate for turns the main session starts on its own (its `continue` action).
//
// Default deny: reading, editing files inside the session's folder, and a short list of local
// commands go ahead; every other tool call stops and asks the user (a confirm dialog, answered
// in the session or on the task's card on the main-session page). Turns the user starts are
// never gated.
//
// This is a guard against a well-meaning agent writing somewhere shared before the user said
// so. It is not a sandbox: an allowed test command runs whatever the repository's scripts do.

import { existsSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { checkReadonlyBash, splitWords } from "../main-session/readonly-guard";

export const MAIN_SESSION_GATE_EXTENSION_NAME = "main-session-write-gate";
/** Title of the confirm dialog; the card on the main-session page recognises its dialogs by it. */
export const MAIN_SESSION_GATE_TITLE = "主会话续做：需要你批准";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_WRITE_TOOLS = new Set(["edit", "write"]);

export type GateVerdict = { allow: true } | { allow: false; summary: string };

/** Local commands that neither leave the machine nor touch anything outside the folder. */
const LOCAL_COMMANDS: Record<string, (words: string[]) => boolean> = {
  ls: () => true,
  pwd: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  wc: () => true,
  which: () => true,
  // --pre hands every file to a command of the caller's choosing.
  rg: (w) => !w.some((word) => word.startsWith("--pre")),
  grep: () => true,
  // status / diff / log / show are the read-only guard's, which also refuses their output flags.
  git: (w) => ["add", "commit", "ls-files", "blame", "rev-parse"].includes(w[1] ?? ""),
  npm: (w) => w[1] === "test" || (w[1] === "run" && /^(test|lint|typecheck|check)(:[\w-]+)?$/.test(w[2] ?? "")),
  pnpm: (w) => w[1] === "test" || (w[1] === "run" && /^(test|lint|typecheck|check)(:[\w-]+)?$/.test(w[2] ?? "")),
  yarn: (w) => /^(test|lint|typecheck)$/.test(w[1] ?? ""),
  node: (w) => w[1] === "--test",
  npx: (w) => w[1] === "tsc" && w.includes("--noEmit"),
  pytest: () => true,
  go: (w) => ["test", "vet", "build"].includes(w[1] ?? "") && !w.some((word) => /^--?(exec|toolexec)\b/.test(word)),
  cargo: (w) => ["test", "check", "build", "clippy"].includes(w[1] ?? ""),
};

/** Shell syntax that would let one allowed word carry another command along. */
function hasShellSyntax(command: string): boolean {
  let quote: string | null = null;
  for (const ch of command) {
    if (ch === "\n" || ch === "\r") return true;
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "`" || ch === "$" || ch === "\\") return true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/[;&|<>`$\\()]/.test(ch)) return true;
  }
  return quote !== null;
}

export function isAllowedLocalCommand(command: string): boolean {
  if (checkReadonlyBash(command).ok) return true;
  if (hasShellSyntax(command)) return false;
  const words = splitWords(command);
  if (!words?.length) return false;
  const check = LOCAL_COMMANDS[words[0]];
  return Boolean(check && check(words));
}

/** The real location of a path that may not exist yet: its nearest existing ancestor, resolved. */
function realLocation(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...rest);
  } catch {
    return path;
  }
}

/**
 * Whether a file tool's path stays inside the session's folder. The file tools expand `~`,
 * strip a leading `@` and normalise odd spaces before they resolve a path, so anything written
 * that way is treated as outside rather than second-guessed; a link out of the folder counts
 * as outside too.
 */
function insideFolder(cwd: string, target: unknown): boolean {
  if (typeof target !== "string" || !target.trim()) return false;
  if (/^\s*[~@]/.test(target) || /[^\S ]|[\u00a0\u2000-\u200b\u202f\u205f\u3000]/.test(target)) return false;
  const rel = relative(realLocation(resolve(cwd)), realLocation(resolve(cwd, target)));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Whether a tool call of a main-session-driven turn may run without asking. */
export function classifyGatedToolCall(toolName: string, input: Record<string, unknown>, cwd: string): GateVerdict {
  if (READ_TOOLS.has(toolName)) return { allow: true };
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const path = input.path ?? input.file_path;
    return insideFolder(cwd, path)
      ? { allow: true }
      : { allow: false, summary: `${toolName} ${String(path ?? "")}（在会话目录之外）` };
  }
  if (toolName === "bash" || toolName === "powershell") {
    const command = String(input.command ?? "");
    return toolName === "bash" && isAllowedLocalCommand(command)
      ? { allow: true }
      : { allow: false, summary: clip(command) };
  }
  return { allow: false, summary: `${toolName} ${clip(JSON.stringify(input ?? {}), 300)}` };
}

interface GateContext {
  hasUI?: boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
}

interface GatePi {
  on(event: "tool_call", handler: (event: { toolName: string; input: Record<string, unknown> }, ctx: GateContext) => unknown): void;
}

/**
 * Registered on every project session; inert unless `isGated()` says the running turn was
 * started by the main session. A refused call is blocked with the reason, so the agent can go
 * on with what it is allowed to do or stop and report.
 */
export function createMainSessionGateExtension(options: { isGated: () => boolean; cwd: string }) {
  return {
    name: MAIN_SESSION_GATE_EXTENSION_NAME,
    hidden: true,
    factory: (pi: GatePi) => {
      pi.on("tool_call", async (event, ctx) => {
        if (!options.isGated()) return undefined;
        const verdict = classifyGatedToolCall(event.toolName, event.input ?? {}, options.cwd);
        if (verdict.allow) return undefined;
        const approved = ctx.hasUI === false ? false : await ctx.ui.confirm(MAIN_SESSION_GATE_TITLE, verdict.summary);
        if (approved) return undefined;
        return { block: true, reason: "The user has not approved this step. The main session started this turn; anything beyond reading, editing files in this folder and running local tests needs their approval. Do what you can without it, then stop and report what is waiting." };
      });
    },
  };
}
