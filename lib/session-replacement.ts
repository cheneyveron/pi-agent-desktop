// Fork-owned: forking a session file, and ctx.newSession / ctx.fork /
// ctx.switchSession from an extension command. The pi CLI replaces its single
// session in place (AgentSessionRuntime); Pi Web hosts many, so the target gets
// its own wrapper, the source finishes the command that asked for the move, and
// the browser follows a `session_replaced` event. `session_before_switch` and
// `session_before_fork` handlers can cancel, as in the CLI.
//
// lib/rpc-manager.ts (upstream-owned) wires these into AgentSessionWrapper; the
// wrapper and startRpcSession are passed in, so this module does not import it.

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import { existsSync, writeFileSync } from "fs";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import { readSessionToolSelection } from "./session-tool-selection";
import type { AgentSessionLike, NavigateTreeOptions } from "./pi-types";
import type { SessionEntry } from "./types";

/** An extension's `withSession()` callback; it receives the target's ReplacedSessionContext. */
export type ReplacedSessionCallback = (ctx: unknown) => Promise<void>;

export type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: (options?: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
    withSession?: ReplacedSessionCallback;
  }) => Promise<{ cancelled: boolean }>;
  fork: (entryId: string, options?: {
    position?: "before" | "at";
    withSession?: ReplacedSessionCallback;
  }) => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: NavigateTreeOptions) => Promise<{ cancelled: boolean }>;
  switchSession: (sessionPath: string, options?: {
    withSession?: ReplacedSessionCallback;
  }) => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

// pi writes a session file at the first user message, so a session with no
// conversation on disk has nothing to copy from yet.
export const UNSAVED_SESSION_FORK_ERROR =
  "This session has not been saved yet. Send a message before forking it.";

const THINKING_LEVEL_NAMES = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Copies the active path up to `targetLeafId` into a new session file, or creates an empty
 * session linked to this one when there is nothing before the fork point.
 */
export function writeForkedSession(
  inner: AgentSessionLike,
  targetLeafId: string | null,
): { newSessionId: string; newSessionFile: string } {
  const sessionManager = inner.sessionManager;
  const currentSessionFile = inner.sessionFile;
  if (!currentSessionFile) throw new Error("Persisted session is missing a session file");
  const sessionDir = sessionManager.getSessionDir();
  let newSessionFile: string;
  let forkedManager: SessionManager;

  if (!targetLeafId) {
    // Fork before the first message: create an empty session linked to this one
    forkedManager = SessionManager.create(sessionManager.getCwd(), sessionDir, {
      parentSession: currentSessionFile,
    });
    newSessionFile = forkedManager.getSessionFile() as string;
  } else {
    // Fork after some history: copy path up to and including the target leaf
    if (!existsSync(currentSessionFile)) throw new Error(UNSAVED_SESSION_FORK_ERROR);
    forkedManager = SessionManager.open(currentSessionFile, sessionDir);
    const forkedPath = forkedManager.createBranchedSession(targetLeafId);
    if (!forkedPath) throw new Error("Failed to create forked session");
    newSessionFile = forkedPath;
  }

  if (!existsSync(newSessionFile)) {
    const header = forkedManager.getHeader();
    if (!header) throw new Error("Forked session is missing a session header");
    const content = [header, ...forkedManager.getEntries()]
      .map((forkedEntry) => JSON.stringify(forkedEntry))
      .join("\n") + "\n";
    writeFileSync(newSessionFile, content, { encoding: "utf8", flag: "wx" });
  }

  const newSessionId = forkedManager.getSessionId();
  cacheSessionPath(newSessionId, newSessionFile);
  invalidateSessionListCache();
  return { newSessionId, newSessionFile };
}

type StartedSession = { inner: AgentSessionLike };

export interface SessionReplacementHost<S extends StartedSession> {
  inner: AgentSessionLike;
  cwd: string;
  emit: (event: { type: string; [key: string]: unknown }) => void;
  startSession: (
    sessionId: string,
    sessionFile: string,
    cwd: string | undefined,
    options?: {
      toolNames?: string[];
      initialModel?: { provider: string; modelId: string };
      allowInitialModelFallback?: boolean;
      thinkingLevel?: ThinkingLevel;
      parentSession?: string;
    },
  ) => Promise<{ session: S; realSessionId: string }>;
}

export function createSessionReplacementActions<S extends StartedSession>(host: SessionReplacementHost<S>): Pick<
  ExtensionCommandContextActionsLike,
  "newSession" | "fork" | "switchSession"
> {
  const cancelledBySessionReplacementHook = async (
    event: Exclude<Parameters<NonNullable<AgentSessionLike["extensionRunner"]["emit"]>>[0], { type: "session_shutdown" }>,
  ): Promise<boolean> => {
    const runner = host.inner.extensionRunner;
    if (!runner.emit || runner.hasHandlers?.(event.type) === false) return false;
    const result = await runner.emit.call(runner, event) as { cancel?: boolean } | undefined;
    return result?.cancel === true;
  };

  const moveToReplacementSession = async (
    sessionId: string,
    sessionFile: string,
    withSession: ReplacedSessionCallback | undefined,
    started?: S,
  ): Promise<{ cancelled: boolean }> => {
    host.emit({ type: "session_replaced", sessionId });
    if (withSession) {
      const target = started ?? (await host.startSession(sessionId, sessionFile, undefined)).session;
      const ctx = target.inner.createReplacedSessionContext?.();
      if (!ctx) throw new Error("This pi version cannot hand the new session to the extension");
      await withSession(ctx);
    }
    return { cancelled: false };
  };

  const newSession: ExtensionCommandContextActionsLike["newSession"] = async (options) => {
    if (await cancelledBySessionReplacementHook({ type: "session_before_switch", reason: "new" })) {
      return { cancelled: true };
    }
    // Unlike the CLI's /new, the browser keeps showing the model and tools picked for this
    // session, so the new one starts with the same selection.
    const entries = host.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    const toolNames = readSessionToolSelection(entries);
    const model = host.inner.model;
    const thinkingLevel = host.inner.agent.state?.thinkingLevel;
    const { session, realSessionId } = await host.startSession(`__ext__${randomUUID()}`, "", host.cwd, {
      ...(toolNames !== undefined ? { toolNames } : {}),
      ...(model ? { initialModel: { provider: model.provider, modelId: model.id }, allowInitialModelFallback: true } : {}),
      ...(thinkingLevel && THINKING_LEVEL_NAMES.has(thinkingLevel as ThinkingLevel)
        ? { thinkingLevel: thinkingLevel as ThinkingLevel }
        : {}),
      ...(options?.parentSession ? { parentSession: options.parentSession } : {}),
    });
    if (options?.setup) {
      await options.setup(session.inner.sessionManager);
      session.inner.refreshContext?.();
    }
    invalidateSessionListCache();
    return moveToReplacementSession(realSessionId, "", options?.withSession, session);
  };

  const fork: ExtensionCommandContextActionsLike["fork"] = async (entryId, options) => {
    const position = options?.position ?? "before";
    if (await cancelledBySessionReplacementHook({ type: "session_before_fork", entryId, position })) {
      return { cancelled: true };
    }
    const entry = host.inner.sessionManager.getEntry(entryId);
    if (!entry) throw new Error("Invalid entry ID for forking");
    let targetLeafId: string | null;
    if (position === "at") {
      targetLeafId = entry.id;
    } else {
      if (entry.type !== "message" || entry.message.role !== "user") throw new Error("Invalid entry ID for forking");
      targetLeafId = entry.parentId ?? null;
    }
    if (!host.inner.sessionManager.isPersisted()) return { cancelled: true };
    const { newSessionId, newSessionFile } = writeForkedSession(host.inner, targetLeafId);
    return moveToReplacementSession(newSessionId, newSessionFile, options?.withSession);
  };

  const switchSession: ExtensionCommandContextActionsLike["switchSession"] = async (sessionPath, options) => {
    if (!existsSync(sessionPath)) throw new Error(`Session file not found: ${sessionPath}`);
    if (await cancelledBySessionReplacementHook({
      type: "session_before_switch",
      reason: "resume",
      targetSessionFile: sessionPath,
    })) {
      return { cancelled: true };
    }
    const sessionId = SessionManager.open(sessionPath, undefined).getSessionId();
    cacheSessionPath(sessionId, sessionPath);
    return moveToReplacementSession(sessionId, sessionPath, options?.withSession);
  };

  return { newSession, fork, switchSession };
}
