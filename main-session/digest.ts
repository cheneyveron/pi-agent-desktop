// The daily digest: at most five lines, chosen by fixed rules so the model can word a line but
// never add one (contract §5).
//
// Priority: immediate items > verification due after a merge/deploy > fresh decisions (things
// the user owes that appeared since the last digest) > waits on people older than three days
// with no change > read-only results done for the user > archive suggestions (one batched line
// a day) > backlog (older things the user owes; fills the first digest, at most two lines a day
// after). "Fresh" is this service's addition to the contract's list; see docs/agents/main-session.md.
// One line per task. An unanswered item is raised again only when its task changed since it
// was last shown, or after five working days.

import { ask, isMe, isOpenAsk, pendingArchive, shortHash, suggestArchive, type Ctx } from "./actions.ts";
import { addDays, daysBetween, parseDateCondition, workdaysBetween, type DayClock } from "./dates.ts";
import type { Store } from "./store.ts";
import type { DigestCategory, DigestLine, MainEvent, Task } from "./types.ts";

export const MAX_LINES = 5;
export const BACKLOG_PER_DAY = 2;
export const WAIT_DAYS = 3;
export const RERAISE_WORKDAYS = 5;
export const ARCHIVE_IDLE_DAYS = 14;
export const DONE_ARCHIVE_DAYS = 2;

const ORDER: DigestCategory[] = ["immediate", "post_merge_verify", "fresh", "waiting", "did_for_you", "archive_suggest", "backlog"];
const VERIFY = /verif|验证|实测|live[ -]?test|recheck|复查|确认.*(部署|上线)|smoke/i;
const SYSTEM_WAITERS = /^(pr|ci|checker|github|gh|deploy)$/i;

export interface Candidate {
  category: DigestCategory;
  task: string;
  key: string;
  text: string;
  chips: string[];
  /** When the thing became pending; newer items sort first within a category. */
  since: string;
  askId?: string;
  tasks?: string[];
  eventId?: string;
}

export interface DigestOptions {
  date: string;
  clock: DayClock;
  /** No digest was made before: the backlog may fill every line. */
  launch?: boolean;
  /** Time of the previous digest; user-owed items newer than this are fresh. */
  previousDigestAt?: string;
}

function clip(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Last time the work on a task changed: a close-out, an answer, a checker change. */
export function lastActivity(store: Store, task: Task): string {
  let last = task.createdAt;
  for (const e of store.eventsForTask(task.id)) {
    const counts = e.action === "closeout" || (e.action === "answer" && !e.data?.undone)
      || (e.action === "checker" && e.data?.changed) || (e.action === "update" && !e.auto)
      || (e.action === "dispatch_readonly" && e.data?.phase === "result");
    if (counts && e.t > last) last = e.t;
  }
  return last;
}

function mergedAt(task: Task): string | undefined {
  const times = Object.values(task.checks?.prs ?? {})
    .map((p) => p.state === "MERGED" ? p.mergedAt ?? p.at : undefined)
    .filter((t): t is string => Boolean(t));
  return times.sort().pop();
}

function onSatisfied(on: string | undefined, date: string, merged: string | undefined, clock: DayClock): boolean {
  if (!on || on === "manual") return true;
  const day = parseDateCondition(on);
  if (day) return day <= date;
  if (/\bpr\b|#\d+|merge|合并|deploy|部署/i.test(on)) return Boolean(merged) && clock.day(merged!) <= date;
  return false;
}

export function collectCandidates(store: Store, options: DigestOptions, now: Date): Candidate[] {
  const { date, clock } = options;
  const nowIso = now.toISOString();
  const out: Candidate[] = [];
  const askKeys = new Set<string>();

  for (const e of store.listEvents()) {
    if (!isOpenAsk(e) || !e.task) continue;
    const task = store.getTask(e.task);
    if (!task || task.status === "archived" || e.data.category === "archive_suggest") continue;
    askKeys.add(e.data.key);
    const since: string = e.data.since ?? e.t;
    const stored = e.data.category as DigestCategory | undefined;
    const category: DigestCategory = e.data.immediate ? "immediate"
      : stored && stored !== "did_for_you" && stored !== "fresh" && stored !== "backlog" ? stored
      : owedCategory(since, options);
    out.push({
      category, task: task.id, key: e.data.key ?? `ask:${e.id}`, text: e.data.question,
      chips: e.data.chips ?? defaultChips(category), since, askId: e.id,
    });
  }

  const fromPrevTick = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  for (const e of store.listEvents()) {
    if (e.action !== "dispatch_readonly" || e.data?.phase !== "result" || !e.data.ok || e.data.failed) continue;
    if (e.t <= fromPrevTick || e.t > nowIso || !e.task || !store.getTask(e.task)) continue;
    out.push({
      category: "did_for_you", task: e.task, key: `did:${e.id}`, eventId: e.id, chips: [],
      text: `${e.task}: 替你查了「${clip(e.data.step, 50)}」— ${clip(e.data.result, 80)}`, since: e.t,
    });
  }

  for (const task of store.listTasks()) {
    if (task.status === "archived" || task.status === "done") continue;
    const merged = mergedAt(task);
    const activity = lastActivity(store, task);
    for (const item of task.next) {
      if (item.done) continue;
      const verifyAfterMerge = merged && clock.day(merged) <= date && VERIFY.test(`${item.text} ${item.on ?? ""}`)
        && (item.run === "me" || item.run === "agent");
      if (verifyAfterMerge) {
        const key = `verify:${task.id}:${shortHash(item.text)}`;
        if (askKeys.has(key)) continue;
        out.push({
          category: "post_merge_verify", task: task.id, key, since: merged!, chips: defaultChips("post_merge_verify"),
          text: `${task.id}: 已合并，还没验证 — ${clip(item.text, 100)}`,
        });
        continue;
      }
      if (item.run !== "me" || !onSatisfied(item.on, date, merged, clock)) continue;
      const key = `me:${task.id}:${shortHash(item.text)}`;
      if (askKeys.has(key)) continue;
      out.push({ category: owedCategory(activity, options), task: task.id, key, since: activity, chips: defaultChips("backlog"), text: `${task.id}: ${clip(item.text, 120)}` });
    }
    for (const wait of task.waits) {
      if (wait.closed) continue;
      const key = `wait:${task.id}:${shortHash(wait.what)}`;
      if (askKeys.has(key)) continue;
      if (wait.until && wait.until.slice(0, 10) <= date) {
        out.push({
          category: "waiting", task: task.id, key, since: wait.until, chips: ["处理", "再等等", "放弃"],
          text: `${task.id}: 到期了（${wait.until.slice(0, 10)}）— ${clip(wait.what, 100)}`,
        });
        continue;
      }
      if (isMe(wait.who)) {
        out.push({ category: owedCategory(wait.since, options), task: task.id, key, since: wait.since, chips: defaultChips("backlog"), text: `${task.id}: ${clip(wait.what, 120)}` });
        continue;
      }
      if (wait.until || wait.who === "date" || SYSTEM_WAITERS.test(wait.who)) continue;
      const waited = daysBetween(clock.day(wait.since), date);
      if (waited < WAIT_DAYS || daysBetween(clock.day(activity), date) < WAIT_DAYS) continue;
      out.push({
        category: "waiting", task: task.id, key, since: addDays(clock.day(wait.since), WAIT_DAYS), chips: defaultChips("waiting"),
        text: `${task.id}: 等 ${wait.who} ${waited} 天没动静 — ${clip(wait.what, 100)}`,
      });
    }
  }

  const archiveIds = store.listTasks()
    .filter((t) => t.status !== "archived" && pendingArchive(store, t.id))
    .map((t) => t.id);
  if (archiveIds.length) {
    out.push({
      category: "archive_suggest", task: archiveIds[0], tasks: archiveIds, key: `archive:${date}`, since: nowIso,
      chips: ["归档", "保留"],
      text: `建议归档 ${archiveIds.length} 个（没动静、条件都关了，48 小时后自动归档）：${archiveIds.slice(0, 6).join("、")}${archiveIds.length > 6 ? " 等" : ""}`,
    });
  }
  return out;
}

/** Something the user owes is fresh until the first digest after it appeared, then backlog. */
function owedCategory(since: string, options: DigestOptions): DigestCategory {
  return !options.launch && options.previousDigestAt && since > options.previousDigestAt ? "fresh" : "backlog";
}

export function defaultChips(category: DigestCategory): string[] {
  switch (category) {
    case "post_merge_verify": return ["已验证", "派人查", "跳过"];
    case "waiting": return ["催一下", "再等等", "放弃"];
    case "archive_suggest": return ["归档", "保留"];
    case "did_for_you": return [];
    case "immediate": return ["看一下", "稍后"];
    default: return ["做了", "稍后", "不做"];
  }
}

interface History {
  lastShownDay?: string;
  lastShownAt?: string;
  answeredAt?: string;
}

/** What earlier digests showed and what the user already answered, by item key. */
export function digestHistory(store: Store, beforeDate: string): Map<string, History> {
  const history = new Map<string, History>();
  for (const e of store.listEvents()) {
    if (e.action === "digest" && e.data?.date < beforeDate) {
      for (const line of e.data.lines ?? []) {
        if (!line.key) continue;
        const h = history.get(line.key) ?? {};
        if (!h.lastShownDay || e.data.date > h.lastShownDay) { h.lastShownDay = e.data.date; h.lastShownAt = e.t; }
        history.set(line.key, h);
      }
    }
    if (e.action === "ask" && e.data?.answeredAt && e.data.key) {
      const answer = e.data.answeredBy ? store.getEvent(e.data.answeredBy) : undefined;
      if (answer?.data?.undone) continue;
      const h = history.get(e.data.key) ?? {};
      if (!h.answeredAt || e.data.answeredAt > h.answeredAt) h.answeredAt = e.data.answeredAt;
      history.set(e.data.key, h);
    }
  }
  return history;
}

function mayRaise(c: Candidate, h: History | undefined, store: Store, date: string, clock: DayClock): boolean {
  if (!h || c.category === "immediate" || c.category === "archive_suggest") return true;
  const task = store.getTask(c.task);
  const activity = task ? lastActivity(store, task) : "";
  const lastTouch = [h.lastShownAt, h.answeredAt].filter(Boolean).sort().pop()!;
  const lastDay = [h.lastShownDay, h.answeredAt ? clock.day(h.answeredAt) : undefined].filter(Boolean).sort().pop()!;
  if (activity > lastTouch) return true;
  return workdaysBetween(lastDay, date) >= RERAISE_WORKDAYS;
}

export function selectLines(candidates: Candidate[], store: Store, options: DigestOptions): Candidate[] {
  const history = digestHistory(store, options.date);
  const byCategory = new Map<DigestCategory, Candidate[]>();
  for (const c of candidates) byCategory.set(c.category, [...(byCategory.get(c.category) ?? []), c]);
  const picked: Candidate[] = [];
  const tasksUsed = new Set<string>();
  for (const category of ORDER) {
    const list = (byCategory.get(category) ?? []).slice().sort((a, b) =>
      category === "immediate" ? a.since.localeCompare(b.since) : b.since.localeCompare(a.since));
    const cap = category === "archive_suggest" ? 1 : category === "backlog" && !options.launch ? BACKLOG_PER_DAY : MAX_LINES;
    let taken = 0;
    for (const c of list) {
      if (picked.length >= MAX_LINES || taken >= cap) break;
      if (category !== "archive_suggest" && tasksUsed.has(c.task)) continue;
      if (!mayRaise(c, history.get(c.key), store, options.date, options.clock)) continue;
      picked.push(c);
      tasksUsed.add(c.task);
      taken++;
    }
  }
  return picked;
}

const KIND: Record<DigestCategory, DigestLine["kind"]> = {
  immediate: "need", post_merge_verify: "need", fresh: "need", waiting: "need", backlog: "need",
  did_for_you: "did", archive_suggest: "archive",
};

export function defaultNarrative(lines: DigestLine[]): string {
  if (lines.length === 0) return "今天没有要你处理的事。";
  const need = lines.filter((l) => l.kind === "need").length;
  const did = lines.filter((l) => l.kind === "did").length;
  const archive = lines.find((l) => l.kind === "archive");
  const parts = [
    need ? `${need} 件要你定` : "",
    did ? `${did} 件替你做了` : "",
    archive ? `${archive.tasks?.length ?? 1} 个建议归档` : "",
  ].filter(Boolean);
  return `今天 ${parts.join("，")}。`;
}

export interface DigestResult {
  date: string;
  lines: DigestLine[];
  narrative: string;
  event: MainEvent;
}

/** Tasks that have gone quiet with nothing left open get an archive suggestion. */
export function suggestIdleArchives(ctx: Ctx, date: string): string[] {
  const suggested: string[] = [];
  for (const task of ctx.store.listTasks()) {
    if (task.status === "archived" || pendingArchive(ctx.store, task.id)) continue;
    const idle = daysBetween(ctx.clock.day(lastActivity(ctx.store, task)), date);
    const nothingOpen = task.waits.every((w) => w.closed) && task.next.every((n) => n.done)
      && ctx.store.eventsForTask(task.id).every((e) => !isOpenAsk(e));
    const quietDone = task.status === "done" && idle >= DONE_ARCHIVE_DAYS;
    if (quietDone || (nothingOpen && idle >= ARCHIVE_IDLE_DAYS)) {
      suggestArchive(ctx, { task: task.id, why: quietDone ? `done ${idle} days ago` : `${idle} days without activity, nothing open` });
      suggested.push(task.id);
    }
  }
  return suggested;
}

/** Build and persist the digest of `date`. Lines that need an answer get an ask to answer. */
export function buildDigest(ctx: Ctx, options: DigestOptions): DigestResult {
  const previous = ctx.store.listEvents().filter((e) => e.action === "digest" && e.data?.lines && e.data.date < options.date).pop();
  const opts: DigestOptions = { ...options, ...(previous && !options.previousDigestAt ? { previousDigestAt: previous.t } : {}) };
  const selected = selectLines(collectCandidates(ctx.store, opts, ctx.now()), ctx.store, opts);
  const lines: (DigestLine & { key: string; category: DigestCategory })[] = [];
  for (const c of selected) {
    let eventId = c.askId ?? c.eventId;
    if (!eventId && c.category !== "did_for_you") {
      eventId = ask(ctx, {
        task: c.task, question: c.text, chips: c.chips, category: c.category, key: c.key,
        ...(c.tasks ? { tasks: c.tasks } : {}),
        since: c.since,
        why: `digest ${options.date}: ${c.category}`,
      }).id;
    }
    lines.push({
      kind: KIND[c.category], task: c.task, text: c.text, eventId: eventId ?? "",
      ...(c.chips.length ? { chips: c.chips } : {}), ...(c.tasks ? { tasks: c.tasks } : {}),
      key: c.key, category: c.category,
    });
  }
  const narrative = defaultNarrative(lines);
  const event = ctx.store.addEvent({
    action: "digest", auto: true, t: ctx.now().toISOString(), why: `daily digest ${options.date}`,
    data: { date: options.date, lines, narrative },
  });
  ctx.emit("digest", { date: options.date, lines: publicLines(lines), narrative, eventId: event.id });
  return { date: options.date, lines: publicLines(lines), narrative, event };
}

export function publicLines(lines: (DigestLine & { key?: string; category?: string })[]): DigestLine[] {
  return lines.map(({ key: _k, category: _c, ...line }) => { void _k; void _c; return line; });
}

/** The digest stored for a date, with any narrative/wording the judge set since. */
export function storedDigest(store: Store, date: string): { date: string; lines: DigestLine[]; narrative: string; eventId: string } | undefined {
  const event = store.listEvents().filter((e) => e.action === "digest" && e.data?.date === date).pop();
  if (!event) return undefined;
  return { date, lines: publicLines(event.data.lines ?? []), narrative: event.data.narrative ?? "", eventId: event.id };
}

/** The judge's `digest` action: reword today's narrative and lines, never add or drop lines. */
export function applyDigestWording(ctx: Ctx, date: string, input: { narrative?: string; lines?: { eventId: string; text: string }[] }, why: string): MainEvent | undefined {
  const event = ctx.store.listEvents().filter((e) => e.action === "digest" && e.data?.date === date).pop();
  if (!event) return undefined;
  const lines = (event.data.lines ?? []).map((line: DigestLine) => {
    const reword = input.lines?.find((l) => l.eventId === line.eventId && l.text?.trim());
    return reword ? { ...line, text: clip(reword.text, 160) } : line;
  });
  const narrative = input.narrative?.trim() ? clip(input.narrative, 600) : event.data.narrative;
  const updated = { ...event, data: { ...event.data, lines, narrative, worded: why } };
  ctx.store.rewriteEvent(updated);
  ctx.emit("digest", { date, lines: publicLines(lines), narrative, eventId: event.id });
  return updated;
}
