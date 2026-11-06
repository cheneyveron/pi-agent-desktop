import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const client = await jiti.import("../lib/main-session-client.ts");
const { createFixtureBackend } = await jiti.import("../lib/main-session-fixture.ts");
const store = await jiti.import("./useMainSession.ts");

function install(overrides = {}) {
  const backend = createFixtureBackend();
  const api = { fixture: true, stream: () => () => undefined, ...Object.fromEntries(Object.keys(backend).filter((k) => typeof backend[k] === "function").map((k) => [k, backend[k]])), ...overrides };
  client.setMainSessionApi(api);
  store.resetMainSessionStore();
  return backend;
}
const counts = () => ["need", "watch", "done"].map((s) => store.getMainSessionState().tasks[s].length);

test("refresh loads all three lists and the narrative", async () => {
  install();
  await store.refreshMainSession();
  assert.equal(store.getMainSessionState().status, "ready");
  assert.deepEqual(counts(), [14, 3, 17]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getMainSessionState().chat[0].label, "since");
});

test("an answer updates counts at once and offers a 5 second undo that restores the row", async () => {
  install();
  await store.refreshMainSession();
  const pending = store.answerTask("CAS-4764", "推", "CAS-4764");
  assert.deepEqual(counts(), [13, 4, 17], "counts change before the service answers");
  await pending;
  const { undo, lastAnswer } = store.getMainSessionState();
  assert.equal(undo.kind, "answer");
  assert.ok(undo.until - Date.now() <= store.UNDO_MS && undo.until - Date.now() > store.UNDO_MS - 1000);
  assert.deepEqual(lastAnswer, { taskId: "CAS-4764", label: "CAS-4764", word: "推", segment: "watch" });
  await store.undoLast();
  assert.deepEqual(counts(), [14, 3, 17]);
  assert.equal(store.getMainSessionState().undo, null);
  store.dismissUndo();
});

test("a failed answer puts the row back and reports the error", async () => {
  install({ answer: async () => { throw new Error("boom"); } });
  await store.refreshMainSession();
  await store.answerTask("CAS-4766", "等", "CAS-4766");
  assert.deepEqual(counts(), [14, 3, 17]);
  assert.equal(store.getMainSessionState().actionError, "boom");
});

test("an unreachable service reads as not running, not as an error", async () => {
  install({ listTasks: async () => { throw new client.MainSessionError("bad gateway", 502); } });
  await store.refreshMainSession();
  assert.equal(store.getMainSessionState().status, "offline");
  install({ listTasks: async () => { throw new TypeError("fetch failed"); } });
  await store.refreshMainSession();
  assert.equal(store.getMainSessionState().status, "offline");
  install({ listTasks: async () => { throw new client.MainSessionError("bad request", 400); } });
  await store.refreshMainSession();
  assert.equal(store.getMainSessionState().status, "error");
});

test("seen marks freeze during a visit and are posted for visited segments when it ends", async () => {
  const backend = install();
  await store.refreshMainSession();
  store.beginVisit();
  const frozen = store.getMainSessionState().visitSeen;
  await store.endVisit(["need", "done", "need"]);
  assert.equal(store.getMainSessionState().visitSeen, null);
  assert.deepEqual(backend.calls.filter((c) => c.method === "seen").map((c) => c.args[0]), ["need", "done"]);
  assert.notEqual(store.getMainSessionState().seen.need, frozen.need);
});

test("chat shows a pending reply, then the answer with its cites", async () => {
  install();
  await store.refreshMainSession();
  const sending = store.sendMainChat("CAS-4685 卡在哪");
  const pendingChat = store.getMainSessionState().chat;
  assert.equal(pendingChat.at(-1).pending, true);
  await sending;
  const last = store.getMainSessionState().chat.at(-1);
  assert.equal(last.pending, false);
  assert.equal(last.cites[0].task, "CAS-4685");
});

test("a digest from the stream reaches the notification handlers once per date", async () => {
  let emit;
  install({ stream: (onEvent) => { emit = onEvent; return () => undefined; } });
  const seen = [];
  const stop = store.onMainSessionDigest((digest) => seen.push(digest.date));
  const release = store.retainMainSessionStream();
  await store.refreshMainSession();
  emit({ type: "digest", digest: { date: "2026-11-07", lines: [], narrative: "today" } });
  assert.deepEqual(seen, ["2026-11-07"]);
  assert.equal(store.getMainSessionState().chat.at(-1).label, "digest");
  stop();
  release();
});

test("opening a task session posts the context message and tells the service", async () => {
  const backend = install();
  await store.refreshMainSession();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true, sessionId: "new-session" }), { status: 200 });
  };
  const id = await store.startTaskSession("CAS-4764", "/work/cas-auth");
  assert.equal(id, "new-session");
  assert.equal(calls[0].url, "/api/agent/new");
  assert.equal(calls[0].body.cwd, "/work/cas-auth");
  assert.equal(calls[0].body.type, "prompt");
  assert.match(calls[0].body.message, /任务 CAS-4764/);
  assert.deepEqual(backend.calls.find((c) => c.method === "sessionStarted").args, ["new-session", "CAS-4764"]);
  await assert.rejects(store.startTaskSession("CAS-4764", null), /no project folder/);
});

test("a remount right after a visit ends continues it instead of marking it seen", async () => {
  const backend = install();
  await store.refreshMainSession();
  store.beginVisit();
  const ended = store.endVisit(["need"]);
  store.beginVisit();
  await ended;
  assert.notEqual(store.getMainSessionState().visitSeen, null, "the visit is still open");
  assert.equal(backend.calls.filter((c) => c.method === "seen").length, 0);
});

test("a visit that never began (page closed before the lists loaded) posts nothing", async () => {
  const backend = install();
  await store.endVisit(["need"]);
  assert.equal(backend.calls.filter((c) => c.method === "seen").length, 0);
});

test("a health probe reporting ok:false means not running, without asking for any list", async () => {
  const backend = install({ health: async () => ({ ok: false }) });
  await store.refreshMainSession();
  assert.equal(store.getMainSessionState().status, "offline");
  assert.equal(backend.calls.filter((c) => c.method === "listTasks").length, 0);
});
