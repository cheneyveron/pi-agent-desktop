/**
 * Client for the main-session service (docs/proposals/2026-11-06-main-session-v1.md).
 *
 * The UI only talks to `/api/main-session/*`, which the Next server forwards to
 * the service on 127.0.0.1:30180. While the service is absent the UI shows
 * "not running"; for development a fixture backend with the prototype's data
 * stands in (`?mainSessionFixture=1`, `NEXT_PUBLIC_MAIN_SESSION_FIXTURE=1`, or
 * the `pi-web:main-session-fixture` localStorage flag).
 */

export type TaskStatus = "need" | "watch" | "done" | "archived";
export type Segment = "need" | "watch" | "done";
export const SEGMENTS: readonly Segment[] = ["need", "watch", "done"];

export type EventAction =
  | "assign" | "update" | "dispatch_readonly" | "ask" | "archive" | "remember"
  | "digest" | "insert" | "schedule" | "checker" | "closeout" | "answer";

export interface NextItem {
  text: string;
  run: "me" | "agent" | "notify" | "checker";
  on?: string;
  done?: boolean;
}

export interface Wait {
  who: string;
  what: string;
  since: string;
  until?: string;
  closed?: boolean;
  evidence?: string;
}

export interface OpenQ {
  question: string;
  who: string;
  answerGoesTo: "task" | "session" | "memory";
  then?: string;
}

/** The open question on a `need` row. Optional service extension (shared note C-ui-task-fields.md). */
export interface TaskAsk {
  eventId: string;
  short: string;
  text: string;
  why: string;
  ifNot?: string;
  chips: string[];
  act: EventAction;
  at: string;
  immediate?: boolean;
  source?: string;
}

/** Latest automatic action on a task. Optional service extension. */
export interface TaskLast {
  eventId: string;
  action: EventAction;
  /** One-line status for row line 1; falls back to `text`. */
  short?: string;
  text: string;
  why: string;
  at: string;
  sessionId?: string;
}

export interface Task {
  id: string;
  aliases: string[];
  title: string;
  status: TaskStatus;
  repo?: string;
  branch?: string;
  stands: string;
  next: NextItem[];
  waits: Wait[];
  artifacts: string[];
  sessions: string[];
  open: OpenQ[];
  log: string[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  ask?: TaskAsk;
  last?: TaskLast;
  answered?: { word: string; at: string };
}

export interface MainEvent {
  id: string;
  t: string;
  task?: string;
  action: EventAction;
  auto: boolean;
  why: string;
  data: unknown;
}

export interface Closeout {
  sessionId: string;
  cwd: string;
  t: string;
  thread: string;
  stands: string;
  next: NextItem[];
  produced: string[];
  learned: { text: string; anchors?: { path: string; symbol?: string }[] }[];
  user_said: { text: string; kind: "correction" | "preference" | "instruction" }[];
  open: OpenQ[];
  next_time?: string[];
}

export interface DigestLine {
  kind: "need" | "did" | "archive";
  task: string;
  text: string;
  chips?: string[];
  eventId: string;
}

export interface Digest {
  date: string;
  lines: DigestLine[];
  narrative: string;
}

export type SeenMap = Record<Segment, string>;

export interface TaskDetail {
  task: Task;
  events: MainEvent[];
  closeouts: Closeout[];
  contextPack?: string;
}

export interface ChatCite {
  task?: string;
  sessionId?: string;
  eventId?: string;
}

export interface ChatReply {
  reply: string;
  cites: ChatCite[];
  actions: MainEvent[];
}

/** One stored message of the conversation pane (GET /chat). */
export interface ChatHistoryMessage {
  role: "user" | "main";
  text: string;
  t: string;
  cites?: ChatCite[];
}

export type MainStreamEvent =
  | { type: "task"; task: Task }
  | { type: "digest"; digest: Digest }
  | { type: "insert"; sessionId: string; text: string; task?: string }
  | { type: "event"; event: MainEvent }
  /** A piece of the reply to the chat message sent at `t`, while it is produced. */
  | { type: "chat"; t: string; delta: string };

/** Reasoning levels the service accepts for its turns. */
export const MAIN_SESSION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type MainSessionThinkingLevel = (typeof MAIN_SESSION_THINKING_LEVELS)[number];

/** The model the service runs its turns on (GET/POST /model; `model` in /health). */
export interface MainSessionModelChoice {
  /** `provider/modelId`, or null: no model turns run until the user picks one. */
  ref: string | null;
  /** "env": MAIN_SESSION_MODEL, which locks the choice; "settings": picked in the UI. */
  source: "env" | "settings" | null;
  setAt?: string;
  /** Absent from services older than 1.1.0, which always ran with reasoning off. */
  thinkingLevel?: MainSessionThinkingLevel;
}

export interface MainSessionHealth {
  ok: boolean;
  since?: string;
  version?: string;
  /** Absent from services that predate the model picker. */
  model?: MainSessionModelChoice;
  judge?: { enabled?: boolean; available?: boolean; turns?: number; lastError?: string };
}

export interface MainSessionApi {
  readonly fixture: boolean;
  health(): Promise<MainSessionHealth>;
  /** Choose the model for judgment turns and read-only checks (`provider/modelId`), or none. */
  setModel(ref: string | null): Promise<MainSessionModelChoice>;
  /** Choose the reasoning level of the turns; "off" clears it. */
  setThinkingLevel(level: MainSessionThinkingLevel): Promise<MainSessionModelChoice>;
  listTasks(status: Segment): Promise<{ tasks: Task[]; seen: SeenMap }>;
  getTask(id: string): Promise<TaskDetail>;
  answer(id: string, word: string, eventId?: string): Promise<{ task: Task; event: MainEvent }>;
  archive(id: string): Promise<{ task: Task; event?: MainEvent }>;
  undo(id: string, eventId: string): Promise<{ task: Task }>;
  seen(segment: Segment): Promise<{ seen: SeenMap }>;
  digest(date?: string): Promise<Digest>;
  chat(text: string): Promise<ChatReply>;
  /** The conversation so far (GET /chat). */
  chatHistory(): Promise<{ messages: ChatHistoryMessage[] }>;
  sessionStarted(sessionId: string, task: string): Promise<void>;
  postCloseout(closeout: Closeout): Promise<{ task: Task; event: MainEvent }>;
  /** Subscribe to `/stream`; returns the close function. */
  stream(onEvent: (event: MainStreamEvent) => void, onState?: (open: boolean) => void): () => void;
}

export class MainSessionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MainSessionError";
  }
}

export const MAIN_SESSION_BASE = "/api/main-session";
export const FIXTURE_FLAG_KEY = "pi-web:main-session-fixture";
/** Session id a desktop notification carries to mean "open the main-session page". */
export const MAIN_SESSION_NOTIFICATION_ID = "main-session";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${MAIN_SESSION_BASE}${path}`, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new MainSessionError(data?.error ?? `HTTP ${response.status}`, response.status);
  return data;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
const enc = encodeURIComponent;

export function createHttpApi(): MainSessionApi {
  return {
    fixture: false,
    health: () => request("/health"),
    setModel: (ref) => post("/model", { model: ref }),
    setThinkingLevel: (level) => post("/model", { thinkingLevel: level }),
    listTasks: (status) => request(`/tasks?status=${status}`),
    getTask: (id) => request(`/tasks/${enc(id)}`),
    answer: (id, word, eventId) => post(`/tasks/${enc(id)}/answer`, { word, ...(eventId ? { eventId } : {}) }),
    archive: (id) => post(`/tasks/${enc(id)}/archive`, {}),
    undo: (id, eventId) => post(`/tasks/${enc(id)}/undo`, { eventId }),
    seen: (segment) => post("/seen", { segment }),
    digest: (date) => request(`/digest${date ? `?date=${enc(date)}` : ""}`),
    chat: (text) => post("/chat", { text }),
    chatHistory: () => request("/chat"),
    sessionStarted: async (sessionId, task) => { await post(`/sessions/${enc(sessionId)}/started`, { task }); },
    postCloseout: (closeout) => post("/closeouts", closeout),
    stream(onEvent, onState) {
      if (typeof EventSource === "undefined") return () => undefined;
      const source = new EventSource(`${MAIN_SESSION_BASE}/stream`);
      const handle = (type: MainStreamEvent["type"]) => (message: MessageEvent<string>) => {
        try {
          onEvent(parseStreamEvent(type, JSON.parse(message.data)));
        } catch {
          // A malformed frame must not close the stream.
        }
      };
      for (const type of ["task", "digest", "insert", "event"] as const) source.addEventListener(type, handle(type) as EventListener);
      source.onopen = () => onState?.(true);
      source.onerror = () => onState?.(false);
      return () => source.close();
    },
  };
}

/** SSE frames carry the bare payload; wrap it as a tagged event. */
export function parseStreamEvent(type: MainStreamEvent["type"], payload: unknown): MainStreamEvent {
  const value = payload as Record<string, unknown>;
  switch (type) {
    case "task": return { type, task: (value.task ?? value) as Task };
    case "digest": return { type, digest: (value.digest ?? value) as Digest };
    case "insert": return { type, sessionId: String(value.sessionId ?? ""), text: String(value.text ?? ""), task: value.task ? String(value.task) : undefined };
    default: return { type: "event", event: (value.event ?? value) as MainEvent };
  }
}

export function isFixtureMode(): boolean {
  if (process.env.NEXT_PUBLIC_MAIN_SESSION_FIXTURE === "1") return true;
  if (typeof window === "undefined") return false;
  try {
    const query = new URLSearchParams(window.location.search).get("mainSessionFixture");
    if (query === "1") window.localStorage.setItem(FIXTURE_FLAG_KEY, "1");
    if (query === "0") window.localStorage.removeItem(FIXTURE_FLAG_KEY);
    return window.localStorage.getItem(FIXTURE_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

let api: MainSessionApi | null = null;

export async function getMainSessionApi(): Promise<MainSessionApi> {
  if (api) return api;
  if (isFixtureMode()) {
    const { createFixtureApi } = await import("./main-session-fixture");
    api = createFixtureApi();
  } else {
    api = createHttpApi();
  }
  return api;
}

/** Tests replace the backend. */
export function setMainSessionApi(next: MainSessionApi | null): void {
  api = next;
}

/** First message of a session opened from a task: the service's context pack, or one built from the task. */
export function buildContextMessage(task: Task, contextPack?: string): string {
  if (contextPack?.trim()) return contextPack;
  const lines = [`[主会话] 任务 ${task.id}${task.title ? ` · ${task.title}` : ""}`];
  if (task.stands) lines.push("", `现状：${task.stands}`);
  const open = task.open.filter((q) => q.question);
  if (open.length) lines.push("", "待定：", ...open.map((q) => `- ${q.question}（${q.who}）`));
  const next = task.next.filter((n) => !n.done).slice(0, 3);
  if (next.length) lines.push("", "下一步：", ...next.map((n) => `- ${n.text}（run: ${n.run}${n.on ? `, on: ${n.on}` : ""}）`));
  if (task.ask?.text) lines.push("", `主会话在问：${task.ask.text}`);
  return lines.join("\n");
}

/** Window event asking the app shell to show the main-session page (detail: `{ task?: string }`). */
export const MAIN_SESSION_OPEN_EVENT = "pi-web:open-main-session";

/** Show the main-session page, located at a task, from anywhere in the UI (e.g. a note inside a session). */
export function openMainSessionPage(task?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MAIN_SESSION_OPEN_EVENT, { detail: task ? { task } : {} }));
}
