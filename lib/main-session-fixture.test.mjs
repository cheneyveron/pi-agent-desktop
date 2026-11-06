import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const { createFixtureBackend } = await jiti.import("./main-session-fixture.ts");
const { buildContextMessage, parseStreamEvent } = await jiti.import("./main-session-client.ts");

const now = () => new Date("2026-11-06T10:00:00").getTime();
const counts = async (b) => Promise.all(["need", "watch", "done"].map(async (s) => (await b.listTasks(s)).tasks.length));

test("answering moves a need task to watch; a closing word moves it to done; undo restores it", async () => {
  const b = createFixtureBackend({ now });
  assert.deepEqual(await counts(b), [14, 3, 17]);
  const { task, event } = await b.answer("CAS-4764", "推", "ask-CAS-4764");
  assert.equal(task.status, "watch");
  assert.equal(task.answered.word, "推");
  assert.equal(task.last.short, "等你在会话里执行「推」");
  assert.deepEqual(await counts(b), [13, 4, 17]);
  await b.undo("CAS-4764", event.id);
  assert.deepEqual(await counts(b), [14, 3, 17]);
  assert.equal((await b.answer("PCT-120665", "关")).task.status, "done");
  assert.deepEqual(await counts(b), [13, 3, 18]);
});

test("answers carrying an eventId are idempotent", async () => {
  const b = createFixtureBackend({ now });
  const first = await b.answer("CAS-4766", "等", "ask-CAS-4766");
  const second = await b.answer("CAS-4766", "等", "ask-CAS-4766");
  assert.equal(second.event.id, first.event.id);
});

test("archive moves a task to done; seen marks the visit", async () => {
  const b = createFixtureBackend({ now });
  await b.archive("EAI-317");
  assert.equal((await b.getTask("EAI-317")).task.status, "done");
  const { seen } = await b.seen("need");
  assert.equal(seen.need, new Date(now()).toISOString());
});

test("chat answers from task state with cites, and records reminders", async () => {
  const b = createFixtureBackend({ now });
  const reply = await b.chat("CAS-4685 卡在哪");
  assert.match(reply.reply, /dev 验证都卡在你这边/);
  assert.equal(reply.cites[0].task, "CAS-4685");
  assert.equal(reply.cites[0].sessionId, "fixture-h490");
  const remind = await b.chat("明天提醒我看 #260");
  assert.equal(remind.actions[0].action, "schedule");
  assert.equal(remind.cites[0].task, "EAI-370");
});

test("the digest narrative is computed from state", async () => {
  const b = createFixtureBackend({ now });
  const digest = await b.digest();
  assert.match(digest.narrative, /之后 7 件新的要你定，它处理掉 10 件，最老的是 EAI-264/);
  assert.ok(digest.lines.length <= 5);
});

test("a task session's first message is the context pack, else one built from the task", async () => {
  const b = createFixtureBackend({ now });
  const { task } = await b.getTask("CAS-4764");
  assert.equal(buildContextMessage(task, "PACK"), "PACK");
  const built = buildContextMessage(task);
  assert.match(built, /^\[主会话\] 任务 CAS-4764/);
  assert.match(built, /现状：CAS-4764（P1 PCT-121470 根因修复）/);
  assert.match(built, /主会话在问：/);
});

test("SSE frames are wrapped whether or not the payload is enveloped", () => {
  assert.equal(parseStreamEvent("task", { id: "X" }).task.id, "X");
  assert.equal(parseStreamEvent("task", { task: { id: "Y" } }).task.id, "Y");
  assert.equal(parseStreamEvent("digest", { date: "2026-11-06", lines: [], narrative: "n" }).digest.narrative, "n");
  assert.deepEqual(parseStreamEvent("insert", { sessionId: "s", text: "t", task: "CAS-1" }), { type: "insert", sessionId: "s", text: "t", task: "CAS-1" });
});
