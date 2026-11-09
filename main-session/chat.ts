// POST /chat: "提醒我…" schedules a reminder, "以后…" is remembered, anything else is answered
// from task state (by a judgment turn when the model is reachable, from the store when not).

import { extractTickets, findByAlias } from "./aliases.ts";
import { isOpenAsk, remember, schedule, type Ctx } from "./actions.ts";
import { addDays, type DayClock } from "./dates.ts";
import type { Judge } from "./judge.ts";
import type { MainEvent, Task } from "./types.ts";

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

export interface ChatMessage {
  role: "user" | "main";
  text: string;
  t: string;
  cites?: ChatCite[];
}

const REMIND = /^\s*(?:请)?(?:提醒我|提醒一下我|remind me(?: to)?)\s*/i;
const REMEMBER = /^\s*(?:以后|今后|从现在起|from now on)[，,\s]*/i;
const WEEKDAYS: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

export interface ParsedTime {
  at: Date;
  rest: string;
}

/**
 * When a reminder is for, in the user's words: 明天/后天, N天后, N小时后, N分钟后, 下周X/周X,
 * M月D日, YYYY-MM-DD, with an optional 上午/下午/晚上 and H点/H:MM. Default: tomorrow 09:00.
 */
export function parseWhen(text: string, now: Date, clock: DayClock): ParsedTime {
  let rest = text;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim();
    return m;
  };
  const today = clock.day(now);
  let day: string | undefined;
  let relativeMs: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = take(/(\d+)\s*(?:个)?\s*(小时|分钟|hours?|minutes?|mins?)\s*(?:后|以后|later)?/i))) {
    relativeMs = Number(m[1]) * (/小时|hour/i.test(m[2]) ? 3_600_000 : 60_000);
  } else if ((m = take(/(\d+)\s*天\s*(?:后|以后)|in\s+(\d+)\s+days?/i))) {
    day = addDays(today, Number(m[1] ?? m[2]));
  } else if (take(/后天/)) {
    day = addDays(today, 2);
  } else if (take(/明天|tomorrow/i)) {
    day = addDays(today, 1);
  } else if (take(/今天|今晚|tonight|today/i)) {
    day = today;
  } else if ((m = take(/(20\d{2})-(\d{1,2})-(\d{1,2})/))) {
    day = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  } else if ((m = take(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/))) {
    const year = Number(today.slice(0, 4));
    let candidate = `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    if (candidate < today) candidate = `${year + 1}${candidate.slice(4)}`;
    day = candidate;
  } else if ((m = take(/(下)?(?:周|星期|礼拜)([一二三四五六日天])/))) {
    const target = WEEKDAYS[m[2]];
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    let delta = (target - dow + 7) % 7;
    if (delta === 0) delta = 7;
    if (m[1] && delta < 7) delta += 7;
    day = addDays(today, delta);
  }
  if (relativeMs !== undefined) return { at: new Date(now.getTime() + relativeMs), rest: cleanup(rest) };
  let hour = 9;
  let minute = 0;
  const period = take(/上午|早上|中午|下午|晚上|今晚/);
  if ((m = take(/(\d{1,2})\s*(?:[:：](\d{2})|点(?:(\d{1,2})分?|半)?)/))) {
    hour = Number(m[1]);
    minute = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : /半/.test(m[0]) ? 30 : 0;
  } else if (period) {
    hour = /中午/.test(period[0]) ? 12 : /下午/.test(period[0]) ? 14 : /晚/.test(period[0]) ? 20 : 9;
  }
  if (period && /下午|晚/.test(period[0]) && hour < 12) hour += 12;
  if (/今晚|tonight/i.test(text) && hour < 12) hour += 12;
  let at = clock.at(day ?? addDays(today, 1), hour, minute);
  if (!day && at.getTime() <= now.getTime()) at = clock.at(addDays(today, 1), hour, minute);
  return { at, rest: cleanup(rest) };
}

function cleanup(text: string): string {
  return text.replace(/^[\s，,：:的]+|[\s，,。.]+$/g, "").trim();
}

function mentionedTask(ctx: Ctx, text: string, history: ChatMessage[] = []): Task | undefined {
  for (const ticket of extractTickets(text)) {
    const task = findByAlias(ctx.store.listTasks(), ticket);
    if (task) return task;
  }
  const named = ctx.store.listTasks().find((t) => text.toLowerCase().includes(t.id.toLowerCase()));
  if (named) return named;
  // "提醒我明天跟进" right after talking about a task means that task.
  for (let i = history.length - 1; i >= 0; i--) {
    for (const cite of history[i].cites ?? []) {
      const task = cite.task ? ctx.store.getTask(cite.task) : undefined;
      if (task) return task;
    }
  }
  return undefined;
}

function describeTask(ctx: Ctx, task: Task): string {
  const next = task.next.filter((n) => !n.done).slice(0, 3).map((n) => n.text).join("；");
  const asks = ctx.store.eventsForTask(task.id).filter(isOpenAsk).length;
  return `${task.id}（${task.status}）：${task.stands || task.title}${next ? ` 下一步：${next}` : ""}${asks ? `（${asks} 个问题等你回答）` : ""}`;
}

/** Answer from the store alone: the tasks the question names, or what needs the user. */
export function answerFromState(ctx: Ctx, text: string): { reply: string; cites: ChatCite[] } {
  const named = extractTickets(text).map((id) => findByAlias(ctx.store.listTasks(), id)).filter((t): t is Task => Boolean(t));
  if (named.length) {
    return { reply: named.map((t) => describeTask(ctx, t)).join("\n"), cites: named.map((t) => ({ task: t.id })) };
  }
  const need = ctx.store.listTasks().filter((t) => t.status === "need").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (need.length === 0) return { reply: "现在没有等你处理的任务。", cites: [] };
  return {
    reply: `${need.length} 个任务等你：\n${need.slice(0, 5).map((t) => describeTask(ctx, t)).join("\n")}`,
    cites: need.slice(0, 5).map((t) => ({ task: t.id })),
  };
}

function citesFrom(ctx: Ctx, text: string, events: MainEvent[]): ChatCite[] {
  const cites: ChatCite[] = [];
  const seen = new Set<string>();
  for (const ticket of extractTickets(text)) {
    const task = findByAlias(ctx.store.listTasks(), ticket);
    if (task && !seen.has(task.id)) { seen.add(task.id); cites.push({ task: task.id }); }
  }
  for (const event of events) cites.push({ ...(event.task ? { task: event.task } : {}), eventId: event.id });
  return cites;
}

/**
 * One chat turn. `history` is the stored conversation before this message (newest last); a
 * judgment turn sees the recent part of it, so follow-ups resolve. `onText` receives the
 * reply as it streams.
 */
export async function chat(ctx: Ctx, judge: Judge | undefined, text: string, history: ChatMessage[] = [], onText?: (delta: string) => void): Promise<ChatReply> {
  const question = text.trim();
  if (!question) throw new Error("text is required");
  const task = mentionedTask(ctx, question, history);

  if (REMIND.test(question)) {
    const body = question.replace(REMIND, "");
    const { at, rest } = parseWhen(body, ctx.now(), ctx.clock);
    const what = rest || body || question;
    const event = schedule(ctx, {
      at: at.toISOString(), text: what, kind: "remind", auto: false, createdBy: "user",
      ...(task ? { task: task.id } : {}), why: `user: ${question}`,
    });
    const when = `${ctx.clock.day(at)} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    return { reply: `好，${when} 提醒你：${what}`, cites: [{ ...(task ? { task: task.id } : {}), eventId: event.id }], actions: [event] };
  }

  if (REMEMBER.test(question)) {
    const event = await remember(ctx, {
      records: [{ t: ctx.now().toISOString(), speaker: "user", text: question, meta: { kind: "preference" } }],
      ...(task ? { task: task.id } : {}), auto: false, why: "user stated a standing preference",
    });
    return { reply: "记下了。", cites: [{ eventId: event.id }], actions: [event] };
  }

  if (judge?.available) {
    const outcome = await judge.run({ kind: "chat", text: question, history }, [], onText);
    if (outcome.reply.trim()) {
      return { reply: outcome.reply.trim(), cites: citesFrom(ctx, `${question}\n${outcome.reply}`, outcome.events), actions: outcome.events };
    }
  }
  const fallback = answerFromState(ctx, question);
  return { ...fallback, actions: [] };
}
