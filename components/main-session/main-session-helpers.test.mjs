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

test("B's close-out entry: the Closeout is details.closeout, and the re-post keeps id/trigger/range", () => {
  const range = { afterEntryId: null, toEntryId: "e9", entries: 12 };
  const message = {
    customType: "closeout",
    content: "PR open",
    details: { v: 1, id: "co-1", t: "2026-11-03T10:00:00Z", trigger: "idle", range, delivery: { status: "sent", at: "x" }, closeout },
  };
  const entry = h.parseCloseoutEntry(message);
  assert.equal(entry.id, "co-1");
  assert.equal(entry.closeout.thread, "CAS-4764");
  const payload = h.closeoutPayload(entry, h.applyCloseoutEdits(entry.closeout, { stands: "PR merged" }));
  assert.equal(payload.stands, "PR merged");
  assert.equal(payload.id, "co-1", "same id: the service records a revision, not a new close-out");
  assert.equal(payload.trigger, "idle");
  assert.deepEqual(payload.range, range);
  assert.equal("delivery" in payload, false);
  assert.equal(h.parseCloseoutMessage(message).stands, "PR open");
});

test("B's note: content is a text-block array; details.text has no prefix", () => {
  const message = {
    customType: "main-session-note",
    content: [{ type: "text", text: "[主会话提醒] 根因在 CAS-4764" }],
    details: { v: 1, id: "n1", t: "x", text: "根因在 CAS-4764", task: "CAS-4764", delivery: "steer" },
  };
  assert.deepEqual(h.parseMainSessionNote(message), { text: "根因在 CAS-4764", task: "CAS-4764" });
  assert.deepEqual(h.parseMainSessionNote({ content: message.content }), { text: "根因在 CAS-4764", task: "CAS-4764" });
});

test("the model picker offers none, the configured models, and a current choice the list lost", () => {
  const models = [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }, { provider: "openrouter", id: "qwen/qwen3-coder", name: "" }];
  assert.deepEqual(h.modelPickerOptions(models, null, t), [
    { value: "", label: "mainSession.model.none" },
    { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 · anthropic" },
    { value: "openrouter/qwen/qwen3-coder", label: "qwen/qwen3-coder · openrouter" },
  ]);
  const lost = h.modelPickerOptions(models, "rdsec/claude-haiku-5-5", t);
  assert.deepEqual(lost[1], { value: "rdsec/claude-haiku-5-5", label: 'mainSession.model.unlisted{"model":"rdsec/claude-haiku-5-5"}' });
  assert.equal(h.modelPickerOptions(models, "anthropic/claude-haiku-4-5", t).length, 3);
});

test("the page asks for a model only when the service runs model turns and has none", () => {
  const svc = (ref, extra = {}) => ({ model: { ref, source: ref ? "settings" : null }, judgeEnabled: true, lastError: null, ...extra });
  assert.equal(h.modelNotice(null), "none");
  assert.equal(h.modelNotice({ model: null, judgeEnabled: true, lastError: null }), "none", "an older service");
  assert.equal(h.modelNotice(svc(null)), "missing");
  assert.equal(h.modelNotice(svc(null, { judgeEnabled: false })), "none", "MAIN_SESSION_JUDGE=off");
  assert.equal(h.modelNotice(svc("anthropic/claude-haiku-4-5")), "none");
  assert.equal(h.modelNotice(svc("anthropic/claude-haiku-4-5", { lastError: "boom" })), "failed");
});

// ── cards ────────────────────────────────────────────────────────────────

test("the client's copy of the service's own answer words matches the service", async () => {
  const { readFile } = await import("node:fs/promises");
  const service = await readFile(new URL("../../main-session/actions.ts", import.meta.url), "utf8");
  const helpers = await readFile(new URL("./main-session-helpers.ts", import.meta.url), "utf8");
  for (const name of ["ARCHIVE_WORDS", "KEEP_WORDS", "DONE_WORDS", "SNOOZE_WORDS", "DISPATCH_WORDS"]) {
    const pattern = new RegExp(`const ${name} = (/.*/i);`).exec(service)[1];
    assert.ok(helpers.includes(`  ${pattern},\n`), `${name} ${pattern}`);
  }
  for (const word of ["归档", "保留", "做了", "稍后", "等", "派人查"]) assert.equal(h.goesToSession(word), false, word);
  for (const word of ["推", "可以", "能", "先别动，等我看完日志", "提到 512Mi"]) assert.equal(h.goesToSession(word), true, word);
  assert.equal(h.goesToSession("  "), false);
});

test("a card's text loses the task prefix its head already shows", () => {
  const task = { id: "CAS-4764", title: "根因修复" };
  assert.equal(h.withoutTaskPrefix("CAS-4764（P1 PCT-121470 根因修复）：4 天没推", task), "4 天没推");
  assert.equal(h.withoutTaskPrefix("CAS-4764: 只读检查没通过", task), "只读检查没通过");
  assert.equal(h.withoutTaskPrefix("先看 CAS-4764：再说", task), "先看 CAS-4764：再说");
  assert.equal(h.withoutTaskPrefix("CAS-4764：", task), "CAS-4764：");
});

test("a card shows a waiting dialog before a run, and a run before a finished one", () => {
  const row = { sessions: ["s1", "s2"], updatedAt: "2026-11-12T10:00:00.000Z" };
  const at = (iso) => Date.parse(iso);
  const idle = { running: false, runStartedAt: null, activity: null, waiting: [], lastRun: null };
  const snap = (entries) => new Map(entries.map(([id, extra]) => [id, { sessionId: id, ...idle, ...extra }]));

  assert.deepEqual(h.cardStateOf(row, snap([])), { kind: "idle" });
  assert.deepEqual(
    h.cardStateOf(row, snap([["s1", { running: true, runStartedAt: 5, activity: { kind: "tool", name: "bash" } }]])),
    { kind: "running", sessionId: "s1", step: "bash", since: 5 },
  );
  assert.deepEqual(
    h.cardStateOf(row, snap([
      ["s1", { running: true, activity: { kind: "thinking" } }],
      ["s2", { running: true, waiting: [{ method: "confirm", prompt: "需要你批准", message: "git push", id: "d1" }] }],
    ])),
    { kind: "approval", sessionId: "s2", title: "需要你批准", detail: "git push", confirmable: true, id: "d1" },
  );
  // A select dialog cannot be answered with yes / no from the card.
  assert.equal(h.cardStateOf(row, snap([["s1", { waiting: [{ method: "select", prompt: "选一个", id: "d2" }] }]])).confirmable, false);

  // A run that ended after the task last changed stands in for the close-out; an older one is history.
  const fresh = { outcome: { status: "aborted" }, finishedAt: at("2026-11-12T10:05:00.000Z"), summary: "做到第 2 步" };
  assert.deepEqual(h.cardStateOf(row, snap([["s1", { lastRun: fresh }]])), { kind: "ended", sessionId: "s1", outcome: "aborted", summary: "做到第 2 步" });
  const old = { outcome: { status: "done" }, finishedAt: at("2026-11-12T09:00:00.000Z"), summary: "旧的" };
  assert.deepEqual(h.cardStateOf(row, snap([["s1", { lastRun: old }]])), { kind: "idle" });
  const failed = { outcome: { status: "failed", error: "429" }, finishedAt: at("2026-11-12T10:06:00.000Z") };
  assert.deepEqual(h.cardStateOf(row, snap([["s1", { lastRun: fresh }], ["s2", { lastRun: failed }]])), { kind: "ended", sessionId: "s2", outcome: "failed", summary: "", error: "429" });
  // Sessions of other tasks never show on this card.
  assert.deepEqual(h.cardStateOf(row, snap([["other", { running: true }]])), { kind: "idle" });
});

test("the conversation's day separators say today, yesterday, then the date", () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  assert.equal(h.dayLabel(new Date(2026, 10, 12, 0, 5).toISOString(), now, t), "mainSession.today");
  assert.equal(h.dayLabel(new Date(2026, 10, 11, 23, 59).toISOString(), now, t), "mainSession.yesterday");
  assert.match(h.dayLabel(new Date(2026, 10, 9, 14, 51).toISOString(), now, t, "zh-CN"), /11月9日/);
  assert.match(h.dayLabel(new Date(2025, 10, 9).toISOString(), now, t, "zh-CN"), /2025/);
  assert.equal(h.dayKey(new Date(2026, 10, 9, 23, 59).toISOString()), "2026-11-09");
  assert.equal(h.clockTime(new Date(2026, 10, 9, 9, 5).toISOString()), "09:05");
  assert.equal(h.elapsedLabel(1_000, 66_000), "1:05");
});
