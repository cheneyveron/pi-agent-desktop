// dispatch_readonly: a Pi session with only read, grep, find, ls and a guarded bash. Every bash
// call is checked against readonly-guard.ts before it runs; a refused command is blocked, the
// session is told why, and the refusal is reported with the result.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { DispatchRequest, DispatchResult } from "./actions.ts";
import { READONLY_TOOLS, checkReadonlyBash } from "./readonly-guard.ts";

export const DISPATCH_SYSTEM_PROMPT = [
  "You are a read-only checker working for the user's main session.",
  "You may read files and run only these commands, one per bash call, without pipes or redirection:",
  "git log/show/status/diff/ls-remote, gh pr view/checks/list, curl -s (GET only), wisp SELECT queries.",
  "You never change anything: no edits, no pushes, no POST/PUT/DELETE, no messages.",
  "Do the one step you are given, then answer in two or three sentences of Chinese.",
  "Start the answer with PASS:, FAIL: or UNKNOWN: — PASS when the check confirms the expected state,",
  "FAIL when it shows a problem, UNKNOWN when you could not tell (say what blocked you).",
].join("\n");

export function parseVerdict(text: string): { failed: boolean; known: boolean } {
  const head = text.trim().slice(0, 12).toUpperCase();
  if (head.startsWith("FAIL")) return { failed: true, known: true };
  if (head.startsWith("PASS")) return { failed: false, known: true };
  return { failed: false, known: false };
}

export function dispatchPrompt(request: DispatchRequest): string {
  const t = request.task;
  return [
    `Task ${t.id}: ${t.title}`,
    t.stands ? `Where it stands: ${t.stands}` : "",
    t.branch ? `Branch: ${t.branch}` : "",
    t.artifacts.length ? `Artifacts: ${t.artifacts.slice(0, 12).join(", ")}` : "",
    "",
    `Step to check: ${request.step}`,
  ].filter((line) => line !== "").join("\n");
}

export function createSdkDispatcher(options: { modelId?: string; timeoutMs?: number } = {}): (request: DispatchRequest) => Promise<DispatchResult> {
  return async (request) => {
    const { runPiTurn } = await import("./pi-runtime.ts");
    const blocked: string[] = [];
    const guard = {
      name: "main-session-readonly-guard",
      hidden: true,
      factory: (pi: { on: (event: "tool_call", handler: (event: { toolName: string; input: Record<string, unknown> }) => unknown) => void }) => {
        pi.on("tool_call", (event) => {
          if (!(READONLY_TOOLS as readonly string[]).includes(event.toolName)) {
            blocked.push(`${event.toolName}`);
            return { block: true, reason: `${event.toolName} is not available to a read-only check` };
          }
          if (event.toolName !== "bash") return undefined;
          const command = String(event.input.command ?? "");
          const verdict = checkReadonlyBash(command);
          if (verdict.ok) return undefined;
          blocked.push(command);
          return { block: true, reason: `refused: ${verdict.reason}` };
        });
      },
    };
    const cwd = request.task.repo && existsSync(request.task.repo) ? request.task.repo : homedir();
    const result = await runPiTurn({
      cwd,
      systemPrompt: DISPATCH_SYSTEM_PROMPT,
      userText: dispatchPrompt(request),
      builtinTools: [...READONLY_TOOLS],
      // The SDK types the factory against its full ExtensionAPI; the guard only needs `on`.
      extensions: [guard as unknown as import("@earendil-works/pi-coding-agent").InlineExtension],
      persist: true,
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
      ...(options.modelId ? { modelId: options.modelId as "claude-haiku-5-5" } : {}),
    });
    const verdict = parseVerdict(result.text);
    return {
      ok: verdict.known,
      failed: verdict.failed,
      result: result.text.trim() || "(no answer)",
      sessionId: result.sessionId,
      ...(blocked.length ? { blocked } : {}),
    };
  };
}
