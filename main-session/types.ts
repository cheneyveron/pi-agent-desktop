// Data model of the main-session service. The shapes in the first block are the contract in
// docs/proposals/2026-11-06-main-session-v1.md §2; the rest are the service's own records.

export type TaskStatus = "need" | "watch" | "done" | "archived";
export type Segment = "need" | "watch" | "done";
export type NextRun = "me" | "agent" | "notify" | "checker";

export interface NextItem {
  text: string;
  run: NextRun;
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

/** An entry of Task.log: the id of an event in events.jsonl. */
export type LogRef = string;

export interface BranchCheck {
  state: "pushed" | "local-only" | "unknown";
  sha?: string;
  at: string;
}

export interface PrCheck {
  ref: string;
  state: string;
  mergedAt?: string | null;
  reviewDecision?: string | null;
  checks: "pass" | "fail" | "pending" | "none";
  at: string;
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
  log: LogRef[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  /** Extension: "P1" when a close-out or ask ties the task to a P1 case; blocks auto-archive. */
  priority?: string;
  /** Extension: last known checker results, so a checker reports only changes. */
  checks?: { branch?: BranchCheck; prs?: Record<string, PrCheck> };
}

export type EventAction =
  | "assign" | "update" | "dispatch_readonly" | "ask" | "archive" | "remember"
  | "digest" | "insert" | "schedule" | "checker" | "closeout" | "answer";

export interface MainEvent {
  id: string;
  t: string;
  task?: string;
  action: EventAction;
  auto: boolean;
  why: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface LearnedItem {
  text: string;
  anchors?: { path: string; symbol?: string }[];
}

export interface UserSaid {
  text: string;
  kind: "correction" | "preference" | "instruction";
}

export interface Closeout {
  /** Extension: the close-out extension's stable id ('co_<uuid>'); idempotency key when present. */
  id?: string;
  /** Extension: what made the extension write it (idle, shutdown, compaction). */
  trigger?: string;
  sessionId: string;
  cwd: string;
  t: string;
  thread: string;
  stands: string;
  next: NextItem[];
  produced: string[];
  learned: LearnedItem[];
  user_said: UserSaid[];
  open: OpenQ[];
  next_time?: string[];
}

export interface DigestLine {
  kind: "need" | "did" | "archive";
  task: string;
  text: string;
  chips?: string[];
  eventId: string;
  /** Extension: every task an archive line covers (the line is batched). */
  tasks?: string[];
}

export interface Seen {
  need?: string;
  watch?: string;
  done?: string;
}

export interface Schedule {
  id: string;
  at: string;
  kind: "remind" | "check" | "after_session";
  text: string;
  task?: string;
  sessionId?: string;
  createdBy: string;
  firedAt?: string;
  cancelled?: boolean;
}

/** Ask event payload (MainEvent.data when action === "ask"). */
export interface AskData {
  question: string;
  chips?: string[];
  immediate?: boolean;
  /** Digest category the ask came from; set when the digest raised it. */
  category?: DigestCategory;
  /** Stable key of the thing asked about, so a later digest knows it was asked. */
  key?: string;
  /** When the thing asked about became pending (fresh vs backlog is decided from this). */
  since?: string;
  /** For a batched archive ask: every task it covers. */
  tasks?: string[];
  /** The answer is an approval of a write the service will not perform itself. */
  write?: boolean;
}

export type DigestCategory =
  | "immediate" | "post_merge_verify" | "fresh" | "waiting" | "did_for_you" | "archive_suggest" | "backlog";

/** A Pi model the user chose for the main session's turns; `provider/modelId` in files and on the wire. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/** Where the model in effect comes from: MAIN_SESSION_MODEL, or the choice saved in settings.json. */
export type ModelSource = "env" | "settings";

/** Reasoning levels a main-session turn can run at (Pi's thinking levels, without "auto"). */
export const MAIN_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type MainThinkingLevel = (typeof MAIN_THINKING_LEVELS)[number];
