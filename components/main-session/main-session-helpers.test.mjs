import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../..", import.meta.url).pathname.replace(/\/$/, "") } });
const h = await jiti.import("./main-session-helpers.ts");
const { fixtureTasks, FIXTURE_SEEN } = await jiti.import("../../lib/main-session-fixture.ts");

const t = (key, params) => (params ? `${key}${JSON.stringify(params)}` : key);
const seen = { need: FIXTURE_SEEN, watch: FIXTURE_SEEN, done: FIXTURE_SEEN };
const tasks = fixtureTasks();
const bySegment = (segment) => tasks.filter((task) => h.segmentOf(task) === segment).map((task) => h.rowOf(task, segment, seen));

test("the fixture reproduces the prototype's three counts and its +N since the last visit", () => {
  assert.deepEqual(["need", "watch", "done"].map((s) => bySegment(s).length), [14, 3, 17]);
  assert.deepEqual(["need", "watch", "done"].map((s) => h.newCount(bySegment(s))), [7, 3, 10]);
});

test("a need row: short status first, reason second, chips are the answers", () => {
  const row = bySegment("need").find((r) => r.id === "CAS-4764");
  assert.equal(row.line1, "4 天没推：推还是放弃");
  assert.match(row.line2, /^10-30 收尾后/);
  assert.deepEqual(row.chips, ["推", "放弃"]);
  assert.equal(row.act, "ask");
  assert.equal(row.isNew, true);
});

test("rows fall back to open/next/stands when the service sends no ask", () => {
  const bare = { id: "CAS-1", aliases: [], title: "t", status: "need", stands: "stands text", next: [{ text: "do it", run: "me" }], waits: [], artifacts: [], sessions: [], open: [], log: [], createdAt: "2026-11-01T00:00:00", updatedAt: "2026-11-01T00:00:00" };
  const row = h.rowOf(bare, "need", seen);
  assert.equal(row.line1, "do it");
  assert.equal(row.line2, "stands text");
  assert.deepEqual(row.chips, []);
  assert.equal(h.rowOf({ ...bare, open: [{ question: "Q?", who: "你", answerGoesTo: "task" }] }, "need", seen).line1, "Q?");
});

test("org/memory ids show their title", () => {
  const row = bySegment("need").find((r) => r.id === "org:773e0cdf");
  assert.equal(row.label, "org 773e0cdf");
});

test("immediate rows sort first, then newest first", () => {
  const rows = [
    { id: "a", at: "2026-11-01T00:00", immediate: false },
    { id: "b", at: "2026-11-03T00:00", immediate: false },
    { id: "c", at: "2026-10-01T00:00", immediate: true },
  ];
  assert.deepEqual(h.sortRows(rows).map((r) => r.id), ["c", "b", "a"]);
});

test("a write answer on a watch row asks to open a session to execute it", () => {
  const task = { ...tasks.find((x) => x.id === "EAI-264"), status: "watch", ask: undefined, answered: { word: "补测", at: "2026-11-06T10:00" } };
  assert.equal(h.rowOf(task, "watch", seen).needsExecution, true);
  assert.equal(h.rowOf({ ...task, answered: { word: "等", at: "x" } }, "watch", seen).needsExecution, false);
});

test("drag height stays between 96px and the column minus 220px", () => {
  assert.equal(h.clampListHeight(20, 800), 96);
  assert.equal(h.clampListHeight(700, 800), 580);
  assert.equal(h.clampListHeight(300, 800), 300);
  assert.equal(h.clampListHeight(300, 300), 140, "a short column still leaves the list 140px");
});

test("j/k focus movement and the row focused after one leaves", () => {
  const ids = ["a", "b", "c"];
  assert.equal(h.moveFocus(ids, null, 1), "a");
  assert.equal(h.moveFocus(ids, "a", 1), "b");
  assert.equal(h.moveFocus(ids, "c", 1), "c");
  assert.equal(h.moveFocus(ids, "a", -1), "a");
  assert.equal(h.moveFocus([], "a", 1), null);
  assert.equal(h.focusAfterRemoval(ids, "b"), "c");
  assert.equal(h.focusAfterRemoval(ids, "c"), "b");
  assert.equal(h.focusAfterRemoval(["a"], "a"), null);
});

test("task references in text become links; other text stays", () => {
  assert.deepEqual(h.linkifyTasks("CAS-4685 和 CAS-4687 卡在 PR #752"), [
    { task: "CAS-4685" }, { text: " 和 " }, { task: "CAS-4687" }, { text: " 卡在 PR #752" },
  ]);
  assert.deepEqual(h.linkifyTasks("no refs"), [{ text: "no refs" }]);
  assert.equal(h.resolveTask(tasks, "PCT-121470").id, "CAS-4764", "aliases resolve to their task");
});

test("ages count calendar days", () => {
  const now = new Date("2026-11-06T09:00:00").getTime();
  assert.equal(h.ageLabel("2026-11-06T01:00:00", now, t), "mainSession.today");
  assert.equal(h.ageLabel("2026-11-03T23:00:00", now, t), 'mainSession.days{"count":3}');
});

test("suggestions ask where the oldest open item is stuck", () => {
  const list = h.suggestions(bySegment("need"), t);
  assert.equal(list[0], 'mainSession.sug.stuck{"task":"EAI-264"}');
});

const closeout = {
  sessionId: "s1", cwd: "/r", t: "2026-11-03T10:00:00", thread: "CAS-4764", stands: "PR open",
  next: [{ text: "merge", run: "me" }, { text: "verify dev", run: "agent", on: "pr #12" }],
  produced: ["commit:a58e342"],
  learned: [{ text: "old rows block refresh", anchors: [{ path: "dao/entitlement.js", symbol: "merge" }] }],
  user_said: [{ text: "push needs my ok", kind: "instruction" }],
  open: [{ question: "customer ETA?", who: "你", answerGoesTo: "task", then: "reply" }],
};

test("close-out fields round-trip through their edit text, keeping structure by position", () => {
  const texts = Object.fromEntries(h.CLOSEOUT_FIELDS.map((f) => [f, h.closeoutFieldText(closeout, f)]));
  assert.equal(texts.next, "merge\nverify dev · run: agent · on: pr #12");
  assert.deepEqual(h.applyCloseoutEdits(closeout, texts).next, closeout.next);
  const edited = h.applyCloseoutEdits(closeout, {
    stands: "PR merged",
    learned: "old rows block refresh (reworded)",
    open: "customer ETA?\nnew question",
    next: "merge\nverify dev · run: agent · on: pr #12\nwrite docs",
  });
  assert.equal(edited.stands, "PR merged");
  assert.deepEqual(edited.learned[0].anchors, closeout.learned[0].anchors, "anchors survive a reword");
  assert.equal(edited.open[0].then, "reply");
  assert.deepEqual(edited.open[1], { who: "你", answerGoesTo: "task", question: "new question" });
  assert.deepEqual(edited.next[2], { text: "write docs", run: "me" });
});

test("custom entries: close-out from details or JSON content; note prefix stripped and task found", () => {
  assert.equal(h.parseCloseoutMessage({ customType: "closeout", details: closeout }).thread, "CAS-4764");
  assert.equal(h.parseCloseoutMessage({ customType: "closeout", content: JSON.stringify(closeout) }).stands, "PR open");
  assert.equal(h.parseCloseoutMessage({ customType: "closeout", content: "not json" }), null);
  assert.deepEqual(h.parseMainSessionNote({ content: "[主会话提醒] 这个 case 的根因在 CAS-4764" }), { text: "这个 case 的根因在 CAS-4764", task: "CAS-4764" });
  assert.deepEqual(h.parseMainSessionNote({ content: "[主会话提醒] x", details: { text: "[主会话提醒] y", task: "EAI-1" } }), { text: "y", task: "EAI-1" });
});
