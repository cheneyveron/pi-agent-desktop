// Shapes shared by the close-out extension (lib/closeout-extension.ts), the
// main-session note insert (lib/rpc-manager.ts) and the chat view that renders
// both. No Node imports: the browser imports this file.
// Contract: docs/proposals/2026-11-06-main-session-v1.md §2 and §4.

/** `customType` of the `custom` session entry a close-out is recorded as. */
export const CLOSEOUT_ENTRY_TYPE = "closeout";
/** `customType` of the `custom_message` entry a main-session note is delivered as. */
export const MAIN_SESSION_NOTE_TYPE = "main-session-note";
/** Fixed start of the text the model sees for a main-session note. */
export const MAIN_SESSION_NOTE_PREFIX = "[主会话提醒] ";

export type CloseoutRun = "me" | "agent" | "notify" | "checker";
export type CloseoutAnswerTarget = "task" | "session" | "memory";
export type CloseoutUserSaidKind = "correction" | "preference" | "instruction";
export type CloseoutTrigger = "idle" | "shutdown" | "compaction";

export interface CloseoutNextItem {
  text: string;
  run: CloseoutRun;
  on?: string;
  done?: boolean;
}

export interface CloseoutAnchor {
  path: string;
  symbol?: string;
}

export interface CloseoutLearned {
  text: string;
  anchors?: CloseoutAnchor[];
}

export interface CloseoutUserSaid {
  text: string;
  kind: CloseoutUserSaidKind;
}

export interface CloseoutOpenQuestion {
  question: string;
  who: string;
  answerGoesTo: CloseoutAnswerTarget;
  then?: string;
}

/** The contract's `Closeout` (§2). */
export interface Closeout {
  sessionId: string;
  cwd: string;
  /** ISO time the close-out was produced. */
  t: string;
  /** A ticket id, `new:<slug>`, or `none`. */
  thread: string;
  stands: string;
  next: CloseoutNextItem[];
  produced: string[];
  learned: CloseoutLearned[];
  user_said: CloseoutUserSaid[];
  open: CloseoutOpenQuestion[];
  next_time?: string[];
}

/** The session entries one close-out summarized: after `afterEntryId` (exclusive; null = from the start) through `toEntryId`. */
export interface CloseoutRange {
  afterEntryId: string | null;
  toEntryId: string;
  /** Transcript entries in the range (messages, summaries, custom messages). */
  entries: number;
}

/** Body of `POST /closeouts`: the contract's Closeout plus delivery metadata the service may ignore. */
export interface CloseoutPayload extends Closeout {
  /** Stable per close-out; a replay from the outbox repeats it. */
  id: string;
  trigger: CloseoutTrigger;
  range: CloseoutRange;
  sessionFile?: string;
}

export interface CloseoutDelivery {
  /** `sent`: the service accepted it. `queued`: written to the outbox for a later replay. */
  status: "sent" | "queued";
  at: string;
  task?: string;
  eventId?: string;
}

/** `data` of the `custom` entry with `customType: "closeout"`. */
export interface CloseoutEntryData {
  v: 1;
  id: string;
  t: string;
  trigger: CloseoutTrigger;
  range: CloseoutRange;
  model?: { provider: string; id: string };
  /** Delivery as of when the entry was written; a later outbox replay does not update it. */
  delivery: CloseoutDelivery;
  closeout: Closeout;
}

/** `details` of the `custom_message` entry with `customType: "main-session-note"`. */
export interface MainSessionNoteDetails {
  v: 1;
  id: string;
  t: string;
  /** The note without the prefix. */
  text: string;
  /** Task id in the main session, for the "open task" link. */
  task?: string;
  /** Service event that asked for it, when given. */
  eventId?: string;
  /** `steer`: into the running turn. `next-turn`: held for the next prompt. `append`: added to an idle session's context. */
  delivery: "steer" | "next-turn" | "append";
}

/** The `POST /closeouts` body for an entry, e.g. after the user edited its fields. */
export function closeoutPayloadFromEntry(data: CloseoutEntryData, sessionFile?: string): CloseoutPayload {
  return {
    ...data.closeout,
    id: data.id,
    trigger: data.trigger,
    range: data.range,
    ...(sessionFile ? { sessionFile } : {}),
  };
}

export function isCloseoutEntryData(value: unknown): value is CloseoutEntryData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Partial<CloseoutEntryData>;
  return data.v === 1
    && typeof data.id === "string"
    && typeof data.range?.toEntryId === "string"
    && typeof data.closeout === "object" && data.closeout !== null
    && typeof data.closeout.stands === "string";
}
