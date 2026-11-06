import assert from "node:assert/strict";
import test from "node:test";
import { applyPrCheck } from "./checkers/index.ts";
import { ask, suggestArchive } from "./actions.ts";
import { BACKLOG_PER_DAY, MAX_LINES, buildDigest, collectCandidates, selectLines } from "./digest.ts";
import { utcClock } from "./dates.ts";
import { makeCtx, task } from "./test-helpers.mjs";

const me = (text, extra = {}) => ({ text, run: "me", ...extra });

function addTasks(ctx, list) {
  for (const t of list) ctx.store.putTask(t);
}

function activity(ctx, id, t) {
  ctx.store.addEvent({ task: id, action: "closeout", auto: true, t, why: "work", data: { key: `${id}@${t}` } });
}

function digest(h, date, extra = {}) {
  h.setNow(`${date}T13:00:00.000Z`);
  return buildDigest(h.ctx, { date, clock: utcClock, ...extra });
}

test("never more than five lines, one per task, in priority order", () => {
  const h = makeCtx("2026-11-01T00:00:00Z");
  const tasks = [];
  for (let i = 0; i < 9; i++) tasks.push(task(`CAS-10${i}`, { next: [me(`do thing ${i}`), me(`second ${i}`)], status: "need" }));
  tasks.push(task("PCT-200", { waits: [{ who: "customer", what: "confirm console loads", since: "2026-10-28T12:00:00Z" }] }));
  tasks.push(task("CAS-300", { next: [me("verify on dev after merge")] }));
  addTasks(h.ctx, tasks);
  for (const t of tasks) activity(h.ctx, t.id, "2026-10-28T12:00:00Z");
  applyPrCheck(h.ctx, h.ctx.store.getTask("CAS-300"), { ref: "o/r#1", state: "MERGED", mergedAt: "2026-11-02T08:00:00Z", reviewDecision: null, checks: "pass", at: "2026-11-02T08:00:00Z" });
  ask(h.ctx, { task: "CAS-108", question: "prod org is down, roll back?", immediate: true, category: "immediate", why: "t" });

  const d = digest(h, "2026-11-02", { launch: true });
  assert.equal(d.lines.length, MAX_LINES);
  assert.equal(new Set(d.lines.map((l) => l.task)).size, d.lines.length, "one line per task");
  assert.equal(d.lines[0].task, "CAS-108", "immediate first");
  assert.equal(d.lines[1].task, "CAS-300", "post-merge verification second");
  assert.equal(d.lines[2].task, "PCT-200", "wait on a person older than three days third");
  for (const line of d.lines) assert.ok(line.eventId, "every line can be answered");
});

test("the launch digest may fill with backlog; later days take at most two backlog lines", () => {
  const h = makeCtx("2026-10-20T00:00:00Z");
  const tasks = Array.from({ length: 8 }, (_, i) => task(`EAI-40${i}`, { next: [me(`backlog ${i}`)] }));
  addTasks(h.ctx, tasks);
  for (const t of tasks) activity(h.ctx, t.id, "2026-10-20T08:00:00Z");
  const first = digest(h, "2026-10-21", { launch: true });
  assert.equal(first.lines.length, MAX_LINES);
  const second = digest(h, "2026-10-22");
  assert.equal(second.lines.length, BACKLOG_PER_DAY);
  assert.ok(second.lines.every((l) => !first.lines.some((f) => f.task === l.task)), "already shown items are not repeated");
});

test("things the user owes that appeared since the last digest are fresh and outrank old waits", () => {
  const h = makeCtx("2026-10-20T00:00:00Z");
  const waits = Array.from({ length: 5 }, (_, i) => task(`PCT-50${i}`, { waits: [{ who: "RD", what: `logs ${i}`, since: "2026-10-15T00:00:00Z" }] }));
  addTasks(h.ctx, waits);
  for (const t of waits) activity(h.ctx, t.id, "2026-10-15T00:00:00Z");
  digest(h, "2026-10-21", { launch: true });
  const fresh = task("CAS-600", { next: [me("approve push of the fix")] });
  addTasks(h.ctx, [fresh]);
  activity(h.ctx, "CAS-600", "2026-10-21T18:00:00Z");
  const d = digest(h, "2026-10-22");
  assert.equal(d.lines[0].task, "CAS-600");
  const event = h.ctx.store.getEvent(d.event.id);
  assert.equal(event.data.lines[0].category, "fresh");
});

test("archive suggestions are one batched line a day", () => {
  const h = makeCtx("2026-11-02T00:00:00Z");
  addTasks(h.ctx, [task("A-100"), task("A-101"), task("A-102")]);
  for (const id of ["A-100", "A-101", "A-102"]) suggestArchive(h.ctx, { task: id, why: "quiet" });
  const d = digest(h, "2026-11-02", { launch: true });
  const archive = d.lines.filter((l) => l.kind === "archive");
  assert.equal(archive.length, 1);
  assert.deepEqual(archive[0].tasks, ["A-100", "A-101", "A-102"]);
});

test("an unanswered item comes back only after its task changes or five working days", () => {
  const h = makeCtx("2026-11-02T00:00:00Z");
  addTasks(h.ctx, [task("CAS-700", { next: [me("decide on the rollout")] })]);
  activity(h.ctx, "CAS-700", "2026-11-01T10:00:00Z");
  assert.equal(digest(h, "2026-11-02", { launch: true }).lines.length, 1);
  assert.equal(digest(h, "2026-11-03").lines.length, 0, "not repeated the next day");
  activity(h.ctx, "CAS-700", "2026-11-03T15:00:00Z");
  assert.equal(digest(h, "2026-11-04").lines.length, 1, "repeated after the task changed");
  assert.equal(digest(h, "2026-11-05").lines.length, 0);
  // Shown Wed 11-04; five working days later is Wed 11-11.
  assert.equal(digest(h, "2026-11-10").lines.length, 0);
  assert.equal(digest(h, "2026-11-11").lines.length, 1);
});

test("waits on people surface on the third day without change; system waits never do", () => {
  const h = makeCtx("2026-10-20T00:00:00Z");
  addTasks(h.ctx, [task("PCT-800", {
    waits: [
      { who: "customer", what: "re-authorize", since: "2026-10-20T15:00:00Z" },
      { who: "pr", what: "review of #9", since: "2026-10-01T00:00:00Z" },
    ],
  })]);
  activity(h.ctx, "PCT-800", "2026-10-20T15:00:00Z");
  const opts = (date) => ({ date, clock: utcClock });
  assert.equal(collectCandidates(h.ctx.store, opts("2026-10-22"), new Date("2026-10-22T13:00:00Z")).length, 0);
  const due = collectCandidates(h.ctx.store, opts("2026-10-23"), new Date("2026-10-23T13:00:00Z"));
  assert.deepEqual(due.map((c) => c.category), ["waiting"]);
  assert.match(due[0].text, /customer 3 天/);
});

test("selection is deterministic for the same state", () => {
  const h = makeCtx("2026-11-02T00:00:00Z");
  addTasks(h.ctx, Array.from({ length: 6 }, (_, i) => task(`X-10${i}`, { next: [me(`n${i}`)] })));
  const options = { date: "2026-11-02", clock: utcClock, launch: true };
  const a = selectLines(collectCandidates(h.ctx.store, options, h.ctx.now()), h.ctx.store, options).map((c) => c.key);
  const b = selectLines(collectCandidates(h.ctx.store, options, h.ctx.now()), h.ctx.store, options).map((c) => c.key);
  assert.deepEqual(a, b);
});
