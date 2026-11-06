// POST /replay: run historical waiting items and their real events through the digest rules,
// day by day, in a throwaway in-memory store, and report which digest lines and asks the
// service would have produced. Deterministic: no model, no network, UTC calendar days.
//
// Items are rows of mine-dropped-followups (items.json, or pickups.json which also carries t0,
// pickup_ts and PR states). Each becomes a wait or a next step on its ticket's task:
//   PR      → wait on the PR (closed by its merge)
//   deploy  → verification step, due when a PR of the task merges (else actionable now)
//   person  → wait on the user ('user…' in the text) or on someone else (raised after 3 days)
//   date    → wait until the date in the text
//   other   → verification step when it reads like one, else a wait on someone else

import { applyPrCheck } from "./checkers/index.ts";
import { shortHash, type Ctx } from "./actions.ts";
import { addDays, daysBetween, parseDateCondition, utcClock } from "./dates.ts";
import { buildDigest, suggestIdleArchives } from "./digest.ts";
import { createArraySink } from "./memory.ts";
import { Store } from "./store.ts";
import type { NextItem, Task, Wait } from "./types.ts";

export interface ReplayItem {
  id: string;
  ticket?: string;
  dep?: string;
  desc: string;
  t0?: string;
  t?: string;
  date?: string;
  prs?: string[] | Record<string, { state?: string; mergedAt?: string | null }>;
  pickup_ts?: string | null;
}

export interface ReplayEvent {
  t: string;
  type: "pr_merged" | "pickup" | "activity";
  item?: string;
  ticket?: string;
  pr?: string;
}

export interface ReplayInput {
  items: ReplayItem[];
  events?: ReplayEvent[];
  from?: string;
  to?: string;
  /** UTC hour of the daily tick. Default 13 (09:00 in US Eastern daylight time). */
  tickHourUtc?: number;
  /**
   * Treat pickups.json's pickup_ts as the item being resolved. Default false: those are an
   * automatic guess that verdicts.json overrules for most dropped items; pass real pickups as
   * events instead.
   */
  derivePickups?: boolean;
}

export interface ReplayLine {
  kind: string;
  task: string;
  text: string;
  category: string;
  items: string[];
}

export interface ReplayOutput {
  digests: { date: string; lines: ReplayLine[]; narrative: string }[];
  asks: { t: string; date: string; task: string; items: string[]; category: string; immediate: boolean; question: string }[];
  surfaced: Record<string, { date: string; category: string; lagDays: number; lagFromEventDays: number }>;
  summary: { days: number; maxLinesPerDay: number; items: number; surfaced: number };
}

const VERIFY = /verif|验证|实测|live[ -]?test|recheck|复查/i;
const MENTIONS_USER = /\buser\b|用户|\bme\b|你/i;

function itemTime(item: ReplayItem): string {
  const raw = item.t0 ?? item.t ?? (item.date ? `${item.date}T12:00:00Z` : undefined);
  if (!raw || Number.isNaN(Date.parse(raw))) throw new Error(`item ${item.id} has no time (t0, t or date)`);
  return new Date(raw).toISOString();
}

function taskIdOf(item: ReplayItem): string {
  const ticket = item.ticket?.trim();
  return ticket && ticket !== "-" ? ticket.toUpperCase() : `item:${item.id}`;
}

function prList(item: ReplayItem): string[] {
  if (!item.prs) return [];
  return Array.isArray(item.prs) ? item.prs : Object.keys(item.prs);
}

/** Merge times the item itself knows (pickups.json rows carry PR states). */
function derivedMerges(item: ReplayItem): ReplayEvent[] {
  if (!item.prs || Array.isArray(item.prs)) return [];
  return Object.entries(item.prs)
    .filter(([, state]) => state?.state === "MERGED" && state.mergedAt)
    .map(([pr, state]) => ({ t: new Date(state.mergedAt!).toISOString(), type: "pr_merged" as const, item: item.id, pr }));
}

interface Element {
  item: ReplayItem;
  task: string;
  key: string;
  t: string;
}

function toElement(item: ReplayItem, taskHasPr: boolean): { element: Omit<Element, "item" | "task" | "t">; wait?: Wait; next?: NextItem } {
  const t = itemTime(item);
  const desc = item.desc;
  const dep = (item.dep ?? "other").toLowerCase();
  const verifyStep = (): { element: { key: string }; next: NextItem } => {
    const next: NextItem = { text: desc, run: "me", ...(taskHasPr ? { on: "pr merged" } : {}) };
    return { element: { key: `${taskHasPr ? "verify" : "me"}:${taskIdOf(item)}:${shortHash(desc)}` }, next };
  };
  const wait = (who: string, until?: string): { element: { key: string }; wait: Wait } => ({
    element: { key: `wait:${taskIdOf(item)}:${shortHash(desc)}` },
    wait: { who, what: desc, since: t, ...(until ? { until } : {}) },
  });
  if (dep === "pr") return wait("pr");
  if (dep === "deploy") return verifyStep();
  if (dep === "date") {
    const until = parseDateCondition(desc);
    return until ? wait("date", until) : wait("person");
  }
  if (dep === "person") return MENTIONS_USER.test(desc) ? wait("me") : wait("person");
  return VERIFY.test(desc) ? verifyStep() : wait("other");
}

export function replay(input: ReplayInput): ReplayOutput {
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error("items must be a non-empty array");
  const tickHour = input.tickHourUtc ?? 13;
  const store = new Store(null);
  let now = new Date(0);
  const ctx: Ctx = { store, now: () => now, clock: utcClock, emit: () => {}, memory: createArraySink() };

  const sorted = [...input.items].sort((a, b) => itemTime(a).localeCompare(itemTime(b)));
  const tasksWithPr = new Set(sorted.filter((i) => prList(i).length > 0).map(taskIdOf));
  const events: ReplayEvent[] = [
    ...(input.events ?? []),
    ...sorted.flatMap(derivedMerges),
    ...(input.derivePickups !== true ? [] : sorted.filter((i) => i.pickup_ts).map((i) => ({ t: new Date(i.pickup_ts!).toISOString(), type: "pickup" as const, item: i.id }))),
  ].sort((a, b) => a.t.localeCompare(b.t));

  const keyToItems = new Map<string, string[]>();
  const elements = new Map<string, Element>();
  type Timed = { t: string; run: () => void };
  const timeline: Timed[] = [];

  for (const item of sorted) {
    const t = itemTime(item);
    timeline.push({
      t,
      run: () => {
        const taskId = taskIdOf(item);
        let task = store.getTask(taskId);
        if (!task) {
          task = {
            id: taskId, aliases: [], title: item.desc.slice(0, 80), status: "watch", stands: "", next: [], waits: [],
            artifacts: [], sessions: [], open: [], log: [], createdAt: t, updatedAt: t,
          } satisfies Task;
          store.putTask(task);
        }
        for (const pr of prList(item)) if (!task.artifacts.includes(`pr:${pr}`)) task.artifacts.push(`pr:${pr}`);
        const { element, wait, next } = toElement(item, tasksWithPr.has(taskId));
        if (wait) task.waits.push(wait);
        if (next) task.next.push(next);
        if (wait?.who === "me" || next) task.status = "need";
        task.updatedAt = t;
        store.saveTasks();
        elements.set(item.id, { item, task: taskId, key: element.key, t });
        keyToItems.set(element.key, [...(keyToItems.get(element.key) ?? []), item.id]);
        store.addEvent({ task: taskId, action: "closeout", auto: true, t, why: `replay item ${item.id}`, data: { key: `replay:${item.id}`, item: item.id } });
      },
    });
  }

  for (const event of events) {
    timeline.push({
      t: event.t,
      run: () => {
        const element = event.item ? elements.get(event.item) : undefined;
        const taskId = element?.task ?? (event.ticket ? event.ticket.toUpperCase() : undefined);
        const task = taskId ? store.getTask(taskId) : undefined;
        if (!task) return;
        if (event.type === "pr_merged") {
          const ref = event.pr ?? "pr";
          if (task.checks?.prs?.[ref]?.state === "MERGED") return;
          applyPrCheck(ctx, task, { ref, state: "MERGED", mergedAt: event.t, reviewDecision: null, checks: "pass", at: event.t });
          return;
        }
        if (event.type === "pickup" && element) {
          const desc = element.item.desc;
          for (const w of task.waits) if (w.what === desc) w.closed = true;
          for (const n of task.next) if (n.text === desc) n.done = true;
        }
        task.updatedAt = event.t;
        store.saveTasks();
        store.addEvent({ task: task.id, action: "closeout", auto: true, t: event.t, why: `replay ${event.type}`, data: { key: `replay:${event.type}:${event.t}:${event.item ?? ""}`, replay: event } });
      },
    });
  }
  timeline.sort((a, b) => a.t.localeCompare(b.t));

  const firstDay = input.from ?? utcClock.day(timeline[0].t);
  const lastEventDay = utcClock.day(timeline[timeline.length - 1].t);
  const lastDay = input.to ?? addDays(lastEventDay, 7);
  const output: ReplayOutput = { digests: [], asks: [], surfaced: {}, summary: { days: 0, maxLinesPerDay: 0, items: sorted.length, surfaced: 0 } };
  const askSeen = new Set<string>();
  let cursor = 0;
  let launch = true;

  for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
    const tick = utcClock.at(day, tickHour);
    while (cursor < timeline.length && timeline[cursor].t <= tick.toISOString()) {
      now = new Date(timeline[cursor].t);
      timeline[cursor].run();
      cursor++;
    }
    now = tick;
    suggestIdleArchives(ctx, day);
    const digest = buildDigest(ctx, { date: day, clock: utcClock, launch });
    launch = false;
    const stored = store.getEvent(digest.event.id)?.data.lines ?? [];
    const lines: ReplayLine[] = stored.map((line: { kind: string; task: string; text: string; category: string; key: string }) => ({
      kind: line.kind, task: line.task, text: line.text, category: line.category,
      items: keyToItems.get(line.key) ?? [],
    }));
    output.digests.push({ date: day, lines, narrative: digest.narrative });
    output.summary.days++;
    output.summary.maxLinesPerDay = Math.max(output.summary.maxLinesPerDay, lines.length);
    for (const line of lines) {
      for (const itemId of line.items) {
        if (output.surfaced[itemId]) continue;
        const element = elements.get(itemId)!;
        output.surfaced[itemId] = {
          date: day, category: line.category,
          lagDays: daysBetween(utcClock.day(element.t), day),
          lagFromEventDays: daysBetween(utcClock.day(eventTimeOf(element, store)), day),
        };
      }
    }
    for (const event of store.listEvents()) {
      if (event.action !== "ask" || askSeen.has(event.id)) continue;
      askSeen.add(event.id);
      output.asks.push({
        t: event.t, date: utcClock.day(event.t), task: event.task ?? "", items: keyToItems.get(event.data.key) ?? [],
        category: event.data.category ?? "backlog", immediate: Boolean(event.data.immediate), question: event.data.question,
      });
    }
  }
  output.summary.surfaced = Object.keys(output.surfaced).length;
  return output;
}

/** The event that made an item actionable: its own time, or a later merge on its task. */
function eventTimeOf(element: Element, store: Store): string {
  const task = store.getTask(element.task);
  if (element.key.startsWith("wait:")) {
    const until = task?.waits.find((w) => w.what === element.item.desc)?.until;
    return until && until > element.t.slice(0, 10) ? `${until}T00:00:00.000Z` : element.t;
  }
  if (!element.key.startsWith("verify:")) return element.t;
  const merges = Object.values(task?.checks?.prs ?? {}).map((p) => p.mergedAt).filter((t): t is string => Boolean(t)).sort();
  const after = merges.find((m) => m >= element.t) ?? merges[0];
  return after && after > element.t ? after : element.t;
}
