import assert from "node:assert/strict";
import test from "node:test";
import {
  answer, archiveNow, ask, assign, hasUnpushedCommits, openAsks, pendingArchive, processPendingArchives, shortHash, suggestArchive, undo,
} from "./actions.ts";
import { chipsFor, intakeCloseout, parseCloseout } from "./intake.ts";
import { HOUR, closeout, makeCtx, task } from "./test-helpers.mjs";

// ── archive: the 48-hour rule ────────────────────────────────────────────

test("an archive suggestion takes effect after 48 hours without objection", () => {
  const h = makeCtx();
  h.ctx.store.putTask(task("CAS-1"));
  suggestArchive(h.ctx, { task: "CAS-1", why: "done" });
  h.advance(47 * HOUR);
  assert.deepEqual(processPendingArchives(h.ctx), []);
  assert.equal(h.ctx.store.getTask("CAS-1").status, "watch");
  h.advance(2 * HOUR);
  assert.deepEqual(processPendingArchives(h.ctx), ["CAS-1"]);
  assert.equal(h.ctx.store.getTask("CAS-1").status, "archived");
});

test("activity on the task after the suggestion cancels it", () => {
  const h = makeCtx();
  h.ctx.store.putTask(task("CAS-2"));
  const suggestion = suggestArchive(h.ctx, { task: "CAS-2", why: "quiet" });
  h.advance(HOUR);
  h.ctx.store.addEvent({ task: "CAS-2", action: "closeout", auto: true, t: h.ctx.now().toISOString(), why: "work", data: {} });
  h.advance(48 * HOUR);
  assert.deepEqual(processPendingArchives(h.ctx), []);
  assert.equal(h.ctx.store.getEvent(suggestion.id).data.state, "cancelled");
});

test("unpushed commits or a P1 hold the archive back", () => {
  const h = makeCtx();
  h.ctx.store.putTask(task("CAS-3", { branch: "fix/x", checks: { branch: { state: "local-only", at: "x" } } }));
  h.ctx.store.putTask(task("PCT-4", { priority: "P1" }));
  const a = suggestArchive(h.ctx, { task: "CAS-3", why: "quiet" });
  const b = suggestArchive(h.ctx, { task: "PCT-4", why: "quiet" });
  h.advance(49 * HOUR);
  assert.deepEqual(processPendingArchives(h.ctx), []);
  assert.equal(h.ctx.store.getEvent(a.id).data.state, "blocked");
  assert.equal(h.ctx.store.getEvent(b.id).data.reason, "tied to a P1");
  assert.equal(hasUnpushedCommits(task("x", { artifacts: ["commit:abc (not pushed)"] })), true);
  assert.equal(hasUnpushedCommits(task("x", { branch: "b", checks: { branch: { state: "pushed", at: "x" } }, stands: "not pushed" })), false);
});

test("a second suggestion for the same task returns the pending one", () => {
  const h = makeCtx();
  h.ctx.store.putTask(task("CAS-5"));
  const first = suggestArchive(h.ctx, { task: "CAS-5", why: "a" });
  assert.equal(suggestArchive(h.ctx, { task: "CAS-5", why: "b" }).id, first.id);
  assert.equal(pendingArchive(h.ctx.store, "CAS-5").id, first.id);
});

// ── answers: idempotent, writes only approved ────────────────────────────

test("answering the same ask twice returns the first answer", () => {
  const h = makeCtx();
  h.ctx.store.putTask(task("CAS-10"));
  const q = ask(h.ctx, { task: "CAS-10", question: "推还是放弃？", chips: ["推", "放弃"], write: true, why: "t" });
  assert.equal(h.ctx.store.getTask("CAS-10").status, "need");
  const first = answer(h.ctx, "CAS-10", { word: "推", eventId: q.id });
  const again = answer(h.ctx, "CAS-10", { word: "放弃", eventId: q.id });
  assert.equal(again.event.id, first.event.id);
  assert.equal(first.event.data.effect, "approved");
  assert.equal(first.event.data.approval, "推");
  assert.equal(h.ctx.store.getTask("CAS-10").status, "watch", "no open asks left");
  assert.equal(h.ctx.store.listEvents().filter((e) => e.action === "answer").length, 1);
  // Posting the answer event's own id is also a no-op.
  assert.equal(answer(h.ctx, "CAS-10", { word: "x", eventId: first.event.id }).event.id, first.event.id);
});

test("an archiving answer archives every task of a batched ask; keep cancels the suggestions", () => {
  const h = makeCtx();
  for (const id of ["A-1", "A-2"]) { h.ctx.store.putTask(task(id)); suggestArchive(h.ctx, { task: id, why: "quiet" }); }
  const batch = ask(h.ctx, { task: "A-1", question: "归档 2 个？", tasks: ["A-1", "A-2"], category: "archive_suggest", why: "digest" });
  answer(h.ctx, "A-1", { word: "归档", eventId: batch.id });
  assert.equal(h.ctx.store.getTask("A-1").status, "archived");
  assert.equal(h.ctx.store.getTask("A-2").status, "archived");

  h.ctx.store.putTask(task("A-3"));
  suggestArchive(h.ctx, { task: "A-3", why: "quiet" });
  const keep = ask(h.ctx, { task: "A-3", question: "归档？", tasks: ["A-3"], category: "archive_suggest", why: "digest" });
  answer(h.ctx, "A-3", { word: "保留", eventId: keep.id });
  assert.equal(pendingArchive(h.ctx.store, "A-3"), undefined);
  assert.equal(h.ctx.store.getTask("A-3").status, "watch");
});

test("a done answer ticks the step the ask was about", () => {
  const h = makeCtx();
  h.ctx.store.putTask(task("CAS-11", { next: [{ text: "verify on dev", run: "me" }] }));
  const q = ask(h.ctx, { task: "CAS-11", question: "verify?", key: `verify:CAS-11:${shortHash("verify on dev")}`, why: "t" });
  answer(h.ctx, "CAS-11", { word: "已验证", eventId: q.id });
  assert.equal(h.ctx.store.getTask("CAS-11").next[0].done, true);
});

// ── undo ─────────────────────────────────────────────────────────────────

test("undo restores the task and reopens the ask within five minutes, not after", () => {
  const h = makeCtx();
  h.ctx.store.putTask(task("CAS-20"));
  const q = ask(h.ctx, { task: "CAS-20", question: "放弃？", why: "t" });
  const { event } = answer(h.ctx, "CAS-20", { word: "放弃", eventId: q.id });
  assert.equal(h.ctx.store.getTask("CAS-20").status, "archived");
  h.advance(4 * 60_000);
  const restored = undo(h.ctx, "CAS-20", event.id);
  assert.equal(restored.status, "need");
  assert.equal(openAsks(h.ctx.store, "CAS-20").length, 1);
  assert.equal(undo(h.ctx, "CAS-20", event.id).status, "need", "undoing twice is a no-op");

  const second = answer(h.ctx, "CAS-20", { word: "稍后", eventId: q.id });
  h.advance(6 * 60_000);
  assert.throws(() => undo(h.ctx, "CAS-20", second.event.id), /5 minutes/);
});

test("an immediate archive can be undone", () => {
  const h = makeCtx();
  h.ctx.store.putTask(task("CAS-21", { status: "need" }));
  const event = archiveNow(h.ctx, { task: "CAS-21", why: "user" });
  assert.equal(undo(h.ctx, "CAS-21", event.id).status, "need");
});

test("merging tasks moves sessions, aliases and events", () => {
  const h = makeCtx();
  h.ctx.store.putTask(task("CAS-30", { sessions: ["s-a"] }));
  h.ctx.store.putTask(task("repo:x:fix", { sessions: ["s-b"], aliases: ["branch:fix"] }));
  ask(h.ctx, { task: "repo:x:fix", question: "q?", why: "t" });
  assign(h.ctx, { merge: { from: "repo:x:fix", into: "CAS-30" }, why: "same work" });
  const merged = h.ctx.store.getTask("CAS-30");
  assert.deepEqual(merged.sessions, ["s-a", "s-b"]);
  assert.ok(merged.aliases.includes("repo:x:fix") && merged.aliases.includes("branch:fix"));
  assert.equal(h.ctx.store.getTask("repo:x:fix"), undefined);
  assert.equal(openAsks(h.ctx.store, "CAS-30").length, 1);
});

// ── close-out intake ─────────────────────────────────────────────────────

test("intake creates a task, asks the user's open questions, waits on others, remembers", async () => {
  const h = makeCtx();
  const c = parseCloseout(closeout({
    thread: "CAS-4764", stands: "Fix committed, not pushed. Root fix for P1 PCT-121470.",
    next: [{ text: "push and open PR", run: "me" }, { text: "verify force-sync", run: "me", on: "pr merged" }],
    produced: ["branch:cheney/bug/CAS-4764-x"],
    open: [{ question: "推还是放弃？", who: "me", answerGoesTo: "task" }, { question: "delegator logs", who: "Ronghui", answerGoesTo: "task" }],
    user_said: [{ text: "use int", kind: "instruction" }], learned: [{ text: "merge is by group" }],
  }));
  const { task: t } = await intakeCloseout(h.ctx, c);
  assert.equal(t.id, "CAS-4764");
  assert.equal(t.status, "need");
  assert.equal(t.priority, "P1");
  assert.equal(t.branch, "cheney/bug/CAS-4764-x");
  assert.deepEqual(t.waits.map((w) => w.who), ["Ronghui", "pr"]);
  const asks = openAsks(h.ctx.store, "CAS-4764");
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0].data.chips, ["推", "放弃"]);
  assert.equal(asks[0].data.write, true);
  assert.equal(h.memory.records.length, 2);
});

test("the same close-out posted twice is taken once; a later one updates the task", async () => {
  const h = makeCtx();
  const c = parseCloseout(closeout({ thread: "EAI-370", open: [{ question: "approve design?", who: "me", answerGoesTo: "task" }] }));
  const first = await intakeCloseout(h.ctx, c);
  const again = await intakeCloseout(h.ctx, c);
  assert.equal(again.duplicate, true);
  assert.equal(again.event.id, first.event.id);
  assert.equal(h.ctx.store.listEvents().filter((e) => e.action === "closeout").length, 1);
  h.advance(HOUR);
  const later = parseCloseout(closeout({ t: "2026-11-02T11:00:00.000Z", stands: "design approved", produced: ["pr:#260"] }));
  const second = await intakeCloseout(h.ctx, later);
  assert.equal(second.task.id, "EAI-370", "same session goes to the same task");
  assert.equal(openAsks(h.ctx.store, "EAI-370").length, 0, "questions the newer close-out dropped are settled");
  assert.equal(second.task.status, "watch");
});

test("a close-out declaring no thread and nothing to track is recorded without a task", async () => {
  const h = makeCtx();
  const result = await intakeCloseout(h.ctx, parseCloseout(closeout({ thread: "none", stands: "explored OAuth" })));
  assert.equal(result.task, null);
  assert.equal(h.ctx.store.listTasks().length, 0);
});

test("parseCloseout rejects bodies without a session and fills defaults", () => {
  assert.throws(() => parseCloseout({}), /sessionId/);
  const c = parseCloseout({ sessionId: "x", next: ["do it"], open: ["why?"] });
  assert.deepEqual(c.next, [{ text: "do it", run: "me" }]);
  assert.equal(c.open[0].who, "me");
  assert.equal(c.thread, "none");
});

test("either/or questions become chips", () => {
  assert.deepEqual(chipsFor("推还是放弃？"), ["推", "放弃"]);
  assert.deepEqual(chipsFor("CAS-4764 修复在本地 4 天没推，推还是放弃？"), ["推", "放弃"]);
  assert.equal(chipsFor("what should we do?"), undefined);
});
