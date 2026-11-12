// Derived, read-only fields the main-session page shows on a task row (requested by the UI
// session in C-ui-task-fields.md). Computed for every response and stream event; never stored.

import { isOpenAsk } from "./actions.ts";
import type { Store } from "./store.ts";
import type { EventAction, MainEvent, Task } from "./types.ts";

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

export interface TaskLast {
  eventId: string;
  action: EventAction;
  short?: string;
  text: string;
  why: string;
  at: string;
  sessionId?: string;
}

export type TaskView = Task & { ask?: TaskAsk; last?: TaskLast; answered?: { word: string; at: string } };

function clip(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const CATEGORY_WHY: Record<string, string> = {
  immediate: "立即：P1、生产或验证没通过",
  post_merge_verify: "PR 已合并，验证还没做",
  waiting: "等的人三天没动静",
  fresh: "上次摘要之后新出现、要你定的",
  backlog: "积压：要你做、还没做",
  archive_suggest: "没动静、条件都关了",
};

function askWhy(task: Task, ask: MainEvent): string {
  if (ask.data.immediate) return CATEGORY_WHY.immediate;
  if (ask.data.category && CATEGORY_WHY[ask.data.category]) return CATEGORY_WHY[ask.data.category];
  if (String(ask.data.key ?? "").startsWith("open:")) return clip(task.stands || "交接里留下的问题", 80);
  if (String(ask.data.key ?? "").startsWith("schedule:")) return "你设的提醒到了";
  return clip(ask.why, 80);
}

function askSource(store: Store, ask: MainEvent): string | undefined {
  for (const e of store.listEvents()) {
    if (e.action !== "digest" || !Array.isArray(e.data?.lines)) continue;
    const index = e.data.lines.findIndex((l: { eventId?: string }) => l.eventId === ask.id);
    if (index >= 0) return `${String(e.data.date).slice(5)} 摘要 #${index + 1}`;
  }
  return undefined;
}

function lastText(e: MainEvent): { short?: string; text: string } {
  switch (e.action) {
    case "closeout": return { short: "交接", text: e.why };
    case "checker": return { short: e.data?.checker, text: String(e.data?.description ?? e.why) };
    case "dispatch_readonly": return e.data?.phase === "result"
      ? { short: "只读检查", text: clip(String(e.data.result ?? ""), 140) }
      : { short: "派了只读检查", text: clip(String(e.data?.step ?? ""), 140) };
    case "archive": return { short: e.data?.suggested ? "建议归档" : "已归档", text: e.why };
    case "remember": return { short: "记下", text: clip(String(e.data?.texts?.[0] ?? ""), 140) };
    case "schedule": return { short: "安排", text: clip(String(e.data?.text ?? ""), 140) };
    case "insert": return { short: "插话", text: clip(String(e.data?.text ?? ""), 140) };
    case "continue": return { short: e.data?.origin === "user" ? "已转给会话" : "让会话续做", text: clip(String(e.data?.text ?? ""), 140) };
    case "update": return { short: "更新", text: e.why };
    default: return { text: e.why };
  }
}

export function decorateTask(store: Store, task: Task): TaskView {
  const events = store.eventsForTask(task.id);
  const asks = events.filter((e) => isOpenAsk(e) && e.data.category !== "archive_suggest")
    .sort((a, b) => Number(Boolean(b.data.immediate)) - Number(Boolean(a.data.immediate)) || a.t.localeCompare(b.t));
  const view: TaskView = { ...task };
  const ask = asks[0];
  if (ask) {
    const source = askSource(store, ask);
    view.ask = {
      eventId: ask.id,
      short: clip(String(ask.data.question).replace(new RegExp(`^${task.id}[:：]\\s*`), ""), 40),
      text: ask.data.question,
      why: askWhy(task, ask),
      ifNot: ask.data.immediate ? "每天的摘要里继续提" : "五个工作日后再提一次（任务有变化就提前）",
      chips: ask.data.chips ?? [],
      act: "ask",
      at: ask.t,
      ...(ask.data.immediate ? { immediate: true } : {}),
      ...(source ? { source } : {}),
    };
  }
  const last = [...events].reverse().find((e) => e.auto && e.action !== "ask" && e.action !== "digest");
  if (last) {
    view.last = {
      eventId: last.id, action: last.action, ...lastText(last), why: last.why, at: last.t,
      ...(typeof last.data?.sessionId === "string" ? { sessionId: last.data.sessionId } : {}),
    };
  }
  const answer = [...events].reverse().find((e) => e.action === "answer" && !e.data?.undone);
  if (answer) view.answered = { word: answer.data.word, at: answer.t };
  return view;
}
