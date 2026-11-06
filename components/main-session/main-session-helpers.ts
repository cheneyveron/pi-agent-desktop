import type { Closeout, EventAction, NextItem, OpenQ, SeenMap, Segment, Task } from "@/lib/main-session-client";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** What one row of the main-session list shows, derived from a task. */
export interface RowView {
  id: string;
  /** Short id shown at the start of line 1. */
  label: string;
  line1: string;
  line2: string;
  chips: string[];
  /** ISO time the row is dated by (asked / last action / updated). */
  at: string;
  act: EventAction;
  immediate: boolean;
  isNew: boolean;
  answered?: string;
  /** A write answer the service cannot execute: offer "open session to do it". */
  needsExecution: boolean;
  text: string;
  why: string;
  ifNot?: string;
  source?: string;
  sessions: string[];
  sessionId?: string;
  eventId?: string;
}

const WRITE_ANSWERS = new Set(["推", "补测", "做", "补验", "起草", "发", "逐个催", "催", "开 PCT", "换人"]);

export function displayId(task: Task): string {
  if (/^(org|repo|memory):/.test(task.id) && task.title) return task.title;
  return task.id;
}

export function rowOf(task: Task, segment: Segment, seen: SeenMap): RowView {
  const at = task.ask?.at ?? task.last?.at ?? task.updatedAt;
  const answered = task.answered?.word;
  const line1 = task.ask?.short
    ?? task.last?.short
    ?? task.open[0]?.question
    ?? task.next.find((n) => !n.done)?.text
    ?? (segment === "done" ? task.last?.text : undefined)
    ?? task.title;
  return {
    id: task.id,
    label: displayId(task),
    line1,
    line2: task.ask?.why ?? task.last?.why ?? task.stands,
    chips: segment === "done" ? [] : task.ask?.chips ?? [],
    at,
    act: task.ask?.act ?? task.last?.action ?? (segment === "need" ? "ask" : "update"),
    immediate: Boolean(task.ask?.immediate),
    // Never viewed: everything counts as new.
    isNew: !seen[segment] || at > seen[segment],
    answered,
    needsExecution: Boolean(answered && WRITE_ANSWERS.has(answered) && segment === "watch"),
    text: task.ask?.text ?? task.last?.text ?? task.stands,
    why: task.ask?.why ?? task.last?.why ?? "",
    ifNot: task.ask?.ifNot,
    source: task.ask?.source,
    sessions: task.sessions,
    sessionId: task.last?.sessionId ?? task.sessions[0],
    eventId: task.ask?.eventId ?? task.last?.eventId,
  };
}

/** Immediate first, then newest first. */
export function sortRows(rows: RowView[]): RowView[] {
  return rows.slice().sort((a, b) => {
    if (a.immediate !== b.immediate) return a.immediate ? -1 : 1;
    return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
  });
}

export function newCount(rows: RowView[]): number {
  return rows.filter((row) => row.isNew).length;
}

export function ageLabel(iso: string, now: number, t: Translate): string {
  const days = Math.floor((startOfDay(now) - startOfDay(new Date(iso).getTime())) / 86_400_000);
  return days <= 0 ? t("mainSession.today") : t("mainSession.days", { count: days });
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "11-03 09:00" in local time. */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const LIST_MIN_HEIGHT = 96;
/** Space the conversation keeps below the list while dragging. */
export const CONVERSATION_RESERVE = 220;

/** The list height a drag may set: 96px up to the column height minus 220px. */
export function clampListHeight(height: number, columnHeight: number): number {
  const max = Math.max(140, columnHeight - CONVERSATION_RESERVE);
  return Math.round(Math.min(max, Math.max(LIST_MIN_HEIGHT, height)));
}

/** j/k focus movement over the visible row ids. */
export function moveFocus(ids: string[], current: string | null, direction: 1 | -1): string | null {
  if (!ids.length) return null;
  const index = current ? ids.indexOf(current) : -1;
  if (index < 0) return ids[0];
  return ids[Math.max(0, Math.min(ids.length - 1, index + direction))];
}

/** After a row leaves: the next row, else the previous one. */
export function focusAfterRemoval(ids: string[], removed: string): string | null {
  const index = ids.indexOf(removed);
  if (index < 0) return null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

export type TextPart = { text: string } | { task: string };

const TASK_REF = /\b(?:CAS|EAI|PCT|TM)-\d{3,8}(?![\w-])/g;

/** Split text into plain parts and task references (CAS-4764, PCT-121470 …). */
export function linkifyTasks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(TASK_REF)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index) });
    parts.push({ task: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Find the task a reference names, by id or alias. */
export function resolveTask(tasks: Task[], ref: string): Task | undefined {
  return tasks.find((task) => task.id === ref) ?? tasks.find((task) => task.aliases.includes(ref));
}

export const ACTION_TAG: Record<EventAction, string> = {
  insert: "k-insert",
  schedule: "k-schedule",
  dispatch_readonly: "k-readonly",
  archive: "k-archive",
  remember: "k-remember",
  update: "k-update",
  assign: "k-update",
  digest: "k-update",
  checker: "k-update",
  closeout: "k-update",
  answer: "k-you",
  ask: "k-ask",
};

export function segmentOf(task: Task): Segment {
  return task.status === "archived" ? "done" : task.status;
}

/** Suggestions under the composer: generic ones plus "where is <oldest> stuck". */
export function suggestions(needRows: RowView[], t: Translate): string[] {
  const oldest = needRows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0];
  const list = [t("mainSession.sug.first"), t("mainSession.sug.did")];
  if (oldest && /^(CAS|EAI|PCT)-/.test(oldest.label)) list.unshift(t("mainSession.sug.stuck", { task: oldest.label }));
  return list;
}

/* ---------- close-out card fields ---------- */

export const CLOSEOUT_FIELDS = ["thread", "stands", "next", "produced", "learned", "user_said", "open", "next_time"] as const;
export type CloseoutField = (typeof CLOSEOUT_FIELDS)[number];

function nextLine(item: NextItem): string {
  return `${item.text}${item.run !== "me" ? ` · run: ${item.run}` : ""}${item.on ? ` · on: ${item.on}` : ""}`;
}

function parseNextLine(line: string, previous?: NextItem): NextItem {
  const run = line.match(/·\s*run:\s*(me|agent|notify|checker)/)?.[1] as NextItem["run"] | undefined;
  const on = line.match(/·\s*on:\s*([^·]+)/)?.[1]?.trim();
  const text = line.replace(/\s*·\s*(run|on):[^·]*/g, "").trim();
  return { ...(previous ?? {}), text, run: run ?? previous?.run ?? "me", ...(on ? { on } : {}) };
}

export function closeoutFieldText(closeout: Closeout, field: CloseoutField): string {
  switch (field) {
    case "thread": return closeout.thread ?? "";
    case "stands": return closeout.stands ?? "";
    case "next": return (closeout.next ?? []).map(nextLine).join("\n");
    case "produced": return (closeout.produced ?? []).join("\n");
    case "learned": return (closeout.learned ?? []).map((l) => l.text).join("\n");
    case "user_said": return (closeout.user_said ?? []).map((u) => u.text).join("\n");
    case "open": return (closeout.open ?? []).map((q) => q.question).join("\n");
    case "next_time": return (closeout.next_time ?? []).join("\n");
  }
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** Apply edited field texts to a close-out, keeping structured parts (anchors, kinds, run) by position. */
export function applyCloseoutEdits(closeout: Closeout, edits: Partial<Record<CloseoutField, string>>): Closeout {
  const next: Closeout = { ...closeout };
  for (const [field, value] of Object.entries(edits) as Array<[CloseoutField, string]>) {
    switch (field) {
      case "thread": next.thread = value.trim() || "none"; break;
      case "stands": next.stands = value.trim(); break;
      case "next": next.next = lines(value).map((l, i) => parseNextLine(l, closeout.next?.[i])); break;
      case "produced": next.produced = lines(value); break;
      case "learned": next.learned = lines(value).map((text, i) => ({ ...(closeout.learned?.[i] ?? {}), text })); break;
      case "user_said": next.user_said = lines(value).map((text, i) => ({ kind: closeout.user_said?.[i]?.kind ?? "instruction", text })); break;
      case "open": next.open = lines(value).map((question, i): OpenQ => {
        const previous = closeout.open?.[i];
        return { who: previous?.who ?? "你", answerGoesTo: previous?.answerGoesTo ?? "task", ...(previous?.then ? { then: previous.then } : {}), question };
      }); break;
      case "next_time": next.next_time = lines(value); break;
    }
  }
  return next;
}

/* ---------- custom entries in a session ---------- */

interface CustomLike {
  customType?: string;
  content?: unknown;
  details?: unknown;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")).join("");
  }
  return "";
}

export function parseCloseoutMessage(message: CustomLike): Closeout | null {
  const details = message.details as Partial<Closeout> | undefined;
  const candidate = details && typeof details === "object" && "stands" in details
    ? details
    : (() => {
      try {
        return JSON.parse(contentText(message.content)) as Partial<Closeout>;
      } catch {
        return null;
      }
    })();
  if (!candidate || typeof candidate !== "object") return null;
  return {
    sessionId: String(candidate.sessionId ?? ""),
    cwd: String(candidate.cwd ?? ""),
    t: String(candidate.t ?? ""),
    thread: String(candidate.thread ?? "none"),
    stands: String(candidate.stands ?? ""),
    next: Array.isArray(candidate.next) ? candidate.next : [],
    produced: Array.isArray(candidate.produced) ? candidate.produced : [],
    learned: Array.isArray(candidate.learned) ? candidate.learned : [],
    user_said: Array.isArray(candidate.user_said) ? candidate.user_said : [],
    open: Array.isArray(candidate.open) ? candidate.open : [],
    ...(Array.isArray(candidate.next_time) ? { next_time: candidate.next_time } : {}),
  };
}

export const NOTE_PREFIX = "[主会话提醒]";

export function parseMainSessionNote(message: CustomLike): { text: string; task?: string } {
  const details = message.details as { text?: unknown; task?: unknown } | undefined;
  const raw = typeof details?.text === "string" ? details.text : contentText(message.content);
  const text = raw.startsWith(NOTE_PREFIX) ? raw.slice(NOTE_PREFIX.length).trim() : raw.trim();
  const task = typeof details?.task === "string" && details.task
    ? details.task
    : text.match(TASK_REF)?.[0];
  return { text, ...(task ? { task } : {}) };
}
