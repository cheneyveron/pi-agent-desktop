"use client";

import { useSyncExternalStore } from "react";
import {
  buildContextMessage,
  getMainSessionApi,
  MainSessionError,
  SEGMENTS,
  type ChatCite,
  type Digest,
  type MainEvent,
  type MainSessionApi,
  type MainSessionHealth,
  type MainSessionModelChoice,
  type MainSessionThinkingLevel,
  type MainStreamEvent,
  type SeenMap,
  type Segment,
  type Task,
} from "@/lib/main-session-client";

export interface MainChatMessage {
  id: string;
  who: "you" | "main";
  text: string;
  at: string;
  /** "自上次以来" for the digest narrative. */
  label?: "since" | "digest";
  cites?: ChatCite[];
  actions?: MainEvent[];
  pending?: boolean;
  error?: string;
}

export interface MainUndo {
  taskId: string;
  label: string;
  kind: "answer" | "archive";
  word?: string;
  eventId?: string;
  until: number;
}

/** What the service says about its model turns (from /health). */
export interface MainSessionServiceInfo {
  /** null: the service predates the model picker and says nothing about its model. */
  model: MainSessionModelChoice | null;
  /** Model turns are on for the process (MAIN_SESSION_JUDGE is not off). */
  judgeEnabled: boolean;
  /** The last model turn's error, cleared by the next good turn or a new model. */
  lastError: string | null;
}

export interface MainSessionState {
  status: "idle" | "loading" | "ready" | "offline" | "error";
  error: string | null;
  fixture: boolean;
  tasks: Record<Segment, Task[]>;
  /** The service's "last viewed" per segment. */
  seen: SeenMap;
  /** Frozen at the start of a page visit so "new" markers stay until the user leaves. */
  visitSeen: SeenMap | null;
  digest: Digest | null;
  chat: MainChatMessage[];
  undo: MainUndo | null;
  /** The last answer, for the sidebar's "刚才" line. */
  lastAnswer: { taskId: string; label: string; word: string; segment: Segment } | null;
  /** A failed action, shown until the next one. */
  actionError: string | null;
  chatBusy: boolean;
  service: MainSessionServiceInfo | null;
  modelSaving: boolean;
  /** Why the last model choice was refused, until the next one. */
  modelError: string | null;
}

const EMPTY_SEEN: SeenMap = { need: "", watch: "", done: "" };
const INITIAL: MainSessionState = {
  status: "idle",
  error: null,
  fixture: false,
  tasks: { need: [], watch: [], done: [] },
  seen: EMPTY_SEEN,
  visitSeen: null,
  digest: null,
  chat: [],
  undo: null,
  lastAnswer: null,
  actionError: null,
  chatBusy: false,
  service: null,
  modelSaving: false,
  modelError: null,
};

export const UNDO_MS = 5000;
const RETRY_MS = 15_000;

let state = INITIAL;
const listeners = new Set<() => void>();
const digestHandlers = new Set<(digest: Digest) => void>();
let stopStream: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let undoTimer: ReturnType<typeof setTimeout> | null = null;
let loadId = 0;
let seq = 0;

function setState(next: Partial<MainSessionState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function getMainSessionState(): MainSessionState {
  return state;
}

/** The service is absent (proxy cannot reach it, or the proxy route is not there yet). */
function isOffline(error: unknown): boolean {
  if (error instanceof MainSessionError) return error.status === 404 || error.status >= 502;
  return error instanceof TypeError;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const segmentOf = (task: Task): Segment => (task.status === "archived" ? "done" : task.status);

/** Put a task into the segment its status says, replacing any copy. */
function upsert(tasks: Record<Segment, Task[]>, task: Task): Record<Segment, Task[]> {
  const next = { need: [], watch: [], done: [] } as Record<Segment, Task[]>;
  for (const segment of SEGMENTS) next[segment] = tasks[segment].filter((t) => t.id !== task.id);
  next[segmentOf(task)] = [task, ...next[segmentOf(task)]];
  return next;
}

function findTask(id: string): Task | undefined {
  for (const segment of SEGMENTS) {
    const task = state.tasks[segment].find((t) => t.id === id);
    if (task) return task;
  }
  return undefined;
}

async function api(): Promise<MainSessionApi> {
  const instance = await getMainSessionApi();
  if (state.fixture !== instance.fixture) setState({ fixture: instance.fixture });
  return instance;
}

function scheduleRetry(): void {
  if (retryTimer || listeners.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (state.status === "offline") void refreshMainSession();
  }, RETRY_MS);
}

/**
 * Set for the tab when /api/main-session has no route at all (404: a build without the
 * proxy). In `next dev` each 404 compiles the not-found page and pushes an HMR reload, so
 * probing again after that reload loops; the tab stops probing until the user retries.
 */
const ROUTE_MISSING_KEY = "pi-web:main-session-route-missing";

function routeMissing(): boolean {
  try { return typeof sessionStorage !== "undefined" && sessionStorage.getItem(ROUTE_MISSING_KEY) === "1"; } catch { return false; }
}

function setRouteMissing(missing: boolean): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (missing) sessionStorage.setItem(ROUTE_MISSING_KEY, "1");
    else sessionStorage.removeItem(ROUTE_MISSING_KEY);
  } catch {
    // private mode: probing again is only slower
  }
}

export function serviceInfo(health: MainSessionHealth): MainSessionServiceInfo {
  return {
    model: health.model && typeof health.model === "object"
      ? { ref: health.model.ref ?? null, source: health.model.source ?? null, ...(health.model.thinkingLevel ? { thinkingLevel: health.model.thinkingLevel } : {}) }
      : null,
    judgeEnabled: health.judge?.enabled ?? Boolean(health.judge?.available),
    lastError: health.judge?.lastError ?? null,
  };
}

/** Re-read /health for the model state (after a chat reply, when the settings section opens). */
export async function refreshMainSessionHealth(): Promise<void> {
  try {
    const health = await (await api()).health();
    if (health?.ok) setState({ service: serviceInfo(health) });
  } catch {
    // The next full refresh reports the service's state.
  }
}

/** Choose the main session's model (`provider/modelId`) or none; the service takes it at once. */
export async function setMainSessionModel(ref: string | null): Promise<boolean> {
  setState({ modelSaving: true, modelError: null });
  try {
    const model = await (await api()).setModel(ref);
    setState({
      modelSaving: false,
      service: { judgeEnabled: true, ...state.service, model, lastError: null },
    });
    return true;
  } catch (error) {
    setState({ modelSaving: false, modelError: message(error) });
    return false;
  }
}

/** Choose the reasoning level of the service's turns (POST /model {thinkingLevel}). */
export async function setMainSessionThinkingLevel(level: MainSessionThinkingLevel): Promise<boolean> {
  setState({ modelSaving: true, modelError: null });
  try {
    const model = await (await api()).setThinkingLevel(level);
    setState({
      modelSaving: false,
      service: { judgeEnabled: true, ...state.service, model, lastError: null },
    });
    return true;
  } catch (error) {
    setState({ modelSaving: false, modelError: message(error) });
    return false;
  }
}

/** `force` (the 重试 button) probes even when this tab saw the route missing. */
export async function refreshMainSession(force = false): Promise<void> {
  const id = ++loadId;
  if (force) setRouteMissing(false);
  if (routeMissing()) {
    setState({ status: "offline", error: null });
    return;
  }
  if (state.status === "idle") setState({ status: "loading" });
  try {
    const client = await api();
    // One quiet probe first: the proxy answers 200 {ok:false} while the service is down,
    // so an absent service costs no failed requests (and no console errors).
    const health = await client.health();
    if (id !== loadId) return;
    if (!health?.ok) {
      setState({ status: "offline", error: null, service: null });
      scheduleRetry();
      return;
    }
    setState({ service: serviceInfo(health) });
    const results = await Promise.all(SEGMENTS.map((segment) => client.listTasks(segment)));
    if (id !== loadId) return;
    const tasks = { need: results[0].tasks, watch: results[1].tasks, done: results[2].tasks };
    setState({ status: "ready", error: null, tasks, seen: results[0].seen ?? EMPTY_SEEN });
    connectStream(client);
    if (!state.digest) void loadHistory(client).then(loadDigest);
  } catch (error) {
    if (id !== loadId) return;
    if (isOffline(error)) {
      setState({ status: "offline", error: null, service: null });
      if (error instanceof MainSessionError && error.status === 404) setRouteMissing(true);
      else scheduleRetry();
    } else {
      setState({ status: "error", error: message(error) });
    }
  }
}

/** Messages the service already holds; this visit's narrative and questions follow them. */
let historyLength = 0;

async function loadHistory(client: MainSessionApi): Promise<void> {
  if (state.chat.some((m) => m.label) || historyLength) return;
  try {
    const { messages } = await client.chatHistory();
    if (!messages?.length) return;
    const history: MainChatMessage[] = messages.map((m) => ({
      id: `m${++seq}`,
      who: m.role === "user" ? "you" : "main",
      text: m.text,
      at: m.t,
      ...(m.cites?.length ? { cites: m.cites } : {}),
    }));
    historyLength = history.length;
    setState({ chat: [...history, ...state.chat] });
  } catch {
    // An older service without GET /chat: start from the narrative.
  }
}

async function loadDigest(): Promise<void> {
  try {
    const digest = await (await api()).digest();
    applyDigest(digest, "since");
  } catch {
    // The narrative is optional; the lists already loaded.
  }
}

function applyDigest(digest: Digest, label: "since" | "digest"): void {
  const narrative = digest.narrative?.trim();
  const already = state.chat.some((m) => m.label && m.text === narrative);
  const entry: MainChatMessage | null = narrative && !already
    ? { id: `m${++seq}`, who: "main", text: narrative, at: new Date().toISOString(), label }
    : null;
  // "Since last time" opens the conversation even when it arrives after the first question.
  const chat = !entry
    ? state.chat
    : label === "since"
      ? [...state.chat.slice(0, historyLength), entry, ...state.chat.slice(historyLength)]
      : [...state.chat, entry];
  setState({ digest, chat });
}

function handleStreamEvent(event: MainStreamEvent): void {
  if (event.type === "task") {
    setState({ tasks: upsert(state.tasks, event.task) });
  } else if (event.type === "chat") {
    // The reply to the message in flight, as the model produces it; the HTTP reply finalises it.
    const waiting = state.chat.find((m) => m.pending);
    if (waiting) setState({ chat: state.chat.map((m) => (m.id === waiting.id ? { ...m, text: m.text + event.delta } : m)) });
  } else if (event.type === "digest") {
    applyDigest(event.digest, "digest");
    for (const handler of digestHandlers) {
      try { handler(event.digest); } catch { /* one consumer failing must not starve the others */ }
    }
  }
}

function connectStream(client: MainSessionApi): void {
  if (stopStream) return;
  stopStream = client.stream(handleStreamEvent);
}

function disconnect(): void {
  stopStream?.();
  stopStream = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && (state.status === "idle" || state.status === "offline")) void refreshMainSession();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) disconnect();
  };
}

/** Called for each digest the stream delivers (desktop notification). */
export function onMainSessionDigest(handler: (digest: Digest) => void): () => void {
  digestHandlers.add(handler);
  return () => { digestHandlers.delete(handler); };
}

function setUndo(undo: MainUndo | null): void {
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = null;
  setState({ undo });
  if (undo) undoTimer = setTimeout(() => setState({ undo: null }), Math.max(0, undo.until - Date.now()));
}

/** Answer a row with one word. Moves it optimistically, then reconciles with the service's task. */
export async function answerTask(taskId: string, word: string, label: string): Promise<Task | null> {
  const before = findTask(taskId);
  if (!before) return null;
  const from = segmentOf(before);
  const guess: Task = { ...before, status: "watch", answered: { word, at: new Date().toISOString() }, ask: undefined };
  setState({ tasks: upsert(state.tasks, guess), actionError: null });
  try {
    const { task, event } = await (await api()).answer(taskId, word, before.ask?.eventId);
    setState({ tasks: upsert(state.tasks, task), lastAnswer: { taskId, label, word, segment: segmentOf(task) } });
    setUndo({ taskId, label, kind: "answer", word, eventId: event.id, until: Date.now() + UNDO_MS });
    return task;
  } catch (error) {
    setState({ tasks: upsert(state.tasks, { ...before, status: from === "done" ? "done" : before.status }), actionError: message(error) });
    return null;
  }
}

export async function archiveTask(taskId: string, label: string): Promise<Task | null> {
  const before = findTask(taskId);
  if (!before) return null;
  setState({ tasks: upsert(state.tasks, { ...before, status: "done", ask: undefined }), actionError: null });
  try {
    const { task, event } = await (await api()).archive(taskId);
    setState({ tasks: upsert(state.tasks, task), lastAnswer: { taskId, label, word: "归档", segment: "done" } });
    setUndo({ taskId, label, kind: "archive", eventId: event?.id ?? task.last?.eventId, until: Date.now() + UNDO_MS });
    return task;
  } catch (error) {
    setState({ tasks: upsert(state.tasks, before), actionError: message(error) });
    return null;
  }
}

export async function undoLast(): Promise<void> {
  const undo = state.undo;
  if (!undo) return;
  setUndo(null);
  try {
    const { task } = await (await api()).undo(undo.taskId, undo.eventId ?? "");
    setState({ tasks: upsert(state.tasks, task), lastAnswer: null, actionError: null });
  } catch (error) {
    setState({ actionError: message(error) });
  }
}

export function dismissUndo(): void {
  setUndo(null);
}

/** A visit that ended a moment ago; a remount right after (StrictMode, fast navigation) continues it. */
let pendingEnd: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;
const END_GRACE_MS = 30;

/** Freeze "last viewed" for this visit; the service learns about the visit when the page closes. */
export function beginVisit(): void {
  if (pendingEnd) {
    clearTimeout(pendingEnd.timer);
    pendingEnd.resolve();
    pendingEnd = null;
    if (state.visitSeen) return;
  }
  if (!state.visitSeen && state.status === "ready") setState({ visitSeen: { ...state.seen } });
}

/** Close the visit: post the segments the user looked at. A visit that never began posts nothing. */
export function endVisit(visited: Iterable<Segment>): Promise<void> {
  const segments = [...new Set(visited)];
  if (pendingEnd) {
    clearTimeout(pendingEnd.timer);
    pendingEnd.resolve();
  }
  return new Promise<void>((resolve) => {
    pendingEnd = {
      resolve,
      timer: setTimeout(() => {
        pendingEnd = null;
        void flushVisit(segments).finally(resolve);
      }, END_GRACE_MS),
    };
  });
}

async function flushVisit(segments: Segment[]): Promise<void> {
  const began = state.visitSeen !== null;
  setState({ visitSeen: null });
  if (!began) return;
  try {
    const client = await api();
    let seen = state.seen;
    for (const segment of segments) seen = (await client.seen(segment)).seen ?? seen;
    setState({ seen });
  } catch {
    // Not knowing the visit only means the "new" markers stay for another visit.
  }
}

export async function sendMainChat(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || state.chatBusy) return;
  const mine: MainChatMessage = { id: `m${++seq}`, who: "you", text: trimmed, at: new Date().toISOString() };
  const waiting: MainChatMessage = { id: `m${++seq}`, who: "main", text: "", at: mine.at, pending: true };
  setState({ chat: [...state.chat, mine, waiting], chatBusy: true });
  try {
    const reply = await (await api()).chat(trimmed);
    const done: MainChatMessage = { ...waiting, text: reply.reply, cites: reply.cites, actions: reply.actions, pending: false, at: new Date().toISOString() };
    setState({ chat: state.chat.map((m) => (m.id === waiting.id ? done : m)), chatBusy: false });
    if (reply.actions?.length) void refreshMainSession();
    else void refreshMainSessionHealth();
  } catch (error) {
    setState({ chat: state.chat.map((m) => (m.id === waiting.id ? { ...m, pending: false, error: message(error) } : m)), chatBusy: false });
  }
}

/**
 * Open a work session for a task: the service's context pack (or one built from
 * the task) becomes the first message, then the service learns the session id.
 */
export async function startTaskSession(taskId: string, fallbackCwd: string | null): Promise<string> {
  const client = await api();
  const detail = await client.getTask(taskId).catch(() => null);
  const task = detail?.task ?? findTask(taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  const cwd = task.repo && /^([A-Za-z]:[\\/]|\/)/.test(task.repo) ? task.repo : fallbackCwd;
  if (!cwd) throw new Error("no project folder for this task");
  const response = await fetch("/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, type: "prompt", message: buildContextMessage(task, detail?.contextPack) }),
  });
  const data = await response.json().catch(() => ({})) as { sessionId?: string; error?: string };
  if (!response.ok || !data.sessionId) throw new Error(data.error ?? `HTTP ${response.status}`);
  await client.sessionStarted(data.sessionId, task.id).catch(() => undefined);
  return data.sessionId;
}

export async function postCloseoutCard(closeout: Parameters<MainSessionApi["postCloseout"]>[0]): Promise<void> {
  await (await api()).postCloseout(closeout);
}

/** Test hook: reset the module store. */
export function resetMainSessionStore(): void {
  disconnect();
  if (pendingEnd) clearTimeout(pendingEnd.timer);
  pendingEnd = null;
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = null;
  state = INITIAL;
  historyLength = 0;
  loadId++;
}

const getServerSnapshot = () => INITIAL;

export function useMainSession(): MainSessionState {
  return useSyncExternalStore(subscribe, getMainSessionState, getServerSnapshot);
}

/** Keep the store loaded and its stream open without rendering on changes. Returns the release function. */
export function retainMainSessionStream(): () => void {
  return subscribe(() => undefined);
}
