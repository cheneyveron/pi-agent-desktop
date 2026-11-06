import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelId } from "./pi-runtime.ts";
import { actionTools } from "./judge.ts";
import { startServer } from "./server.ts";
import { makeCtx, task } from "./test-helpers.mjs";

async function withServer(fn, options = {}) {
  const judged = [];
  const started = await startServer({
    port: 0, dir: null, timers: false,
    judgeRunner: async ({ user, tools }) => { judged.push({ user, tools: tools.map((t) => t.name) }); return ""; },
    dispatcher: async () => ({ ok: true, result: "PASS: fine" }),
    memory: { write: async () => "sent" },
    ...options,
  });
  const base = `http://127.0.0.1:${started.port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn({ call, base, service: started.service, judged });
  } finally {
    await started.close();
  }
}

const closeout = {
  sessionId: "sess-1", cwd: "/work/cas-account", t: "2026-11-05T10:00:00.000Z", thread: "CAS-4764",
  stands: "Fix committed, not pushed.", next: [{ text: "push and open PR", run: "me" }], produced: ["branch:cheney/bug/CAS-4764-x"],
  learned: [], user_said: [], open: [{ question: "推还是放弃？", who: "me", answerGoesTo: "task" }],
};

test("the contract's endpoints, end to end", async () => {
  await withServer(async ({ call, judged }) => {
    const health = await call("GET", "/health");
    assert.equal(health.body.ok, true);
    assert.equal(health.body.version, "1.0.0");

    const created = await call("POST", "/closeouts", closeout);
    assert.equal(created.status, 201);
    assert.equal(created.body.task.id, "CAS-4764");
    const dup = await call("POST", "/closeouts", closeout);
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, true);
    assert.equal(dup.body.event.id, created.body.event.id);

    const need = await call("GET", "/tasks?status=need");
    assert.deepEqual(need.body.tasks.map((t) => t.id), ["CAS-4764"]);
    assert.deepEqual(need.body.seen, {});
    assert.equal(need.body.newSince.need, 1);

    const detail = await call("GET", `/tasks/${encodeURIComponent("CAS-4764")}`);
    assert.match(detail.body.contextPack, /继续任务 CAS-4764/);
    assert.equal(detail.body.closeouts.length, 1);
    const askId = detail.body.openAsks[0].id;

    const answered = await call("POST", "/tasks/CAS-4764/answer", { word: "放弃", eventId: askId });
    assert.equal(answered.body.task.status, "archived");
    const again = await call("POST", "/tasks/CAS-4764/answer", { word: "推", eventId: askId });
    assert.equal(again.body.event.id, answered.body.event.id, "idempotent");
    const undone = await call("POST", "/tasks/CAS-4764/undo", { eventId: answered.body.event.id });
    assert.equal(undone.body.task.status, "need");

    const archived = await call("POST", "/tasks/CAS-4764/archive", {});
    assert.equal(archived.body.task.status, "archived");
    assert.equal((await call("POST", "/tasks/CAS-4764/archive", {})).body.task.status, "archived");

    const seen = await call("POST", "/seen", { segment: "need" });
    assert.ok(seen.body.seen.need);
    assert.equal((await call("POST", "/seen", { segment: "x" })).status, 400);

    const digest = await call("GET", "/digest?date=2020-01-01");
    assert.deepEqual(digest.body.lines, []);
    assert.equal((await call("GET", "/digest?date=nope")).status, 400);

    const events = await call("GET", "/events?since=2000-01-01T00:00:00Z");
    assert.ok(events.body.events.some((e) => e.action === "closeout"));

    const chat = await call("POST", "/chat", { text: "提醒我明天 看 CAS-4764" });
    assert.match(chat.body.reply, /提醒你/);
    assert.equal((await call("GET", "/chat")).body.messages.length, 2);

    const started = await call("POST", "/sessions/sess-2/started", { task: "CAS-4764" });
    assert.equal(started.body.task.sessions[0], "sess-2");

    const replayed = await call("POST", "/replay", { items: [{ id: "A", ticket: "CAS-1", dep: "person", desc: "user to decide", t0: "2026-10-01T12:00:00Z" }], to: "2026-10-03" });
    assert.equal(replayed.body.surfaced.A.date, "2026-10-01", "first digest after it, the same day at 13:00Z");

    await new Promise((r) => setTimeout(r, 20));
    assert.ok(judged.length >= 1, "the close-out got a judgment turn");
    assert.deepEqual(judged[0].tools, ["assign", "update", "dispatch_readonly", "ask", "archive", "remember", "insert", "schedule", "digest"]);
  });
});

test("errors are JSON with a 4xx status", async () => {
  await withServer(async ({ call }) => {
    assert.deepEqual(await call("GET", "/nope"), { status: 404, body: { error: "not found" } });
    assert.equal((await call("GET", "/tasks/NOPE-1")).status, 404);
    assert.equal((await call("POST", "/closeouts", "{bad json")).status, 400);
    assert.equal((await call("POST", "/closeouts", { cwd: "/x" })).status, 400);
    assert.equal((await call("POST", "/chat", { text: " " })).status, 400);
    assert.equal((await call("POST", "/tasks/NOPE-1/answer", { word: "x" })).status, 404);
  });
});

test("the stream sends hello, then task and event updates", async () => {
  await withServer(async ({ call, base }) => {
    const controller = new AbortController();
    const res = await fetch(`${base}/stream`, { signal: controller.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (pattern) => {
      while (!pattern.test(text)) text += decoder.decode((await reader.read()).value);
    };
    await until(/event: hello/);
    await call("POST", "/closeouts", closeout);
    await until(/event: task\ndata: .*CAS-4764/);
    await until(/event: event\n/);
    controller.abort();
  });
});

test("the judge's tools write events with their reason; digest is refused outside the tick", async () => {
  const h = makeCtx();
  h.ctx.store.putTask(task("CAS-1", { sessions: ["s-9"] }));
  const sink = [];
  const tools = Object.fromEntries(actionTools(h.ctx, { kind: "checker", eventId: "e" }, sink).map((t) => [t.name, t]));
  assert.match(await tools.update.execute({ task: "CAS-1", status: "need", add_next: [{ text: "verify", run: "agent" }], why: "PR merged" }), /^ok/);
  assert.match(await tools.insert.execute({ session: "s-9", task: "CAS-1", text: "PR merged, verify now", why: "context" }), /^ok/);
  assert.match(await tools.insert.execute({ session: "other", task: "CAS-1", text: "x", why: "y" }), /^error: session other is not on CAS-1/);
  assert.match(await tools.digest.execute({ narrative: "x", why: "y" }), /^error: digest is only available/);
  assert.match(await tools.ask.execute({ task: "NOPE", question: "q", why: "w" }), /^error: no task NOPE/);
  assert.deepEqual(sink.map((e) => [e.action, e.why]), [["update", "PR merged"], ["insert", "context"]]);
  assert.ok(h.emitted.some((e) => e.type === "insert" && e.data.sessionId === "s-9"));
});

test("only rdsec haiku or luna may run the main session's turns", () => {
  assert.equal(resolveModelId(undefined), "claude-haiku-5-5");
  assert.equal(resolveModelId("gpt-6-luna"), "gpt-6-luna");
  assert.equal(resolveModelId("rdsec/claude-haiku-5-5"), "claude-haiku-5-5");
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "gemini-3.8-flash"]) {
    assert.throws(() => resolveModelId(id), /not allowed/);
  }
});

test("task rows carry the derived ask/last/answered fields; a close-out id is the idempotency key", async () => {
  await withServer(async ({ call }) => {
    const body = { ...closeout, id: "co_1", trigger: "idle" };
    await call("POST", "/closeouts", body);
    const row = (await call("GET", "/tasks?status=need")).body.tasks[0];
    assert.equal(row.ask.text, "推还是放弃？");
    assert.deepEqual(row.ask.chips, ["推", "放弃"]);
    assert.equal(row.ask.act, "ask");
    assert.equal(row.last.action, "closeout");
    assert.equal((await call("POST", "/closeouts", body)).body.duplicate, true, "an outbox replay of the same body");
    // The card's "交接" button re-posts the same id with edited content.
    const replayed = await call("POST", "/closeouts", { ...body, t: "2026-11-05T10:05:00.000Z" });
    assert.equal(replayed.body.duplicate, undefined, "a changed body under the same id is a revision");
    const again = await call("POST", "/closeouts", { ...body, t: "2026-11-05T10:05:00.000Z" });
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.event.data.revisionOf !== undefined, true);
    const answered = await call("POST", "/tasks/CAS-4764/answer", { word: "推", eventId: row.ask.eventId });
    assert.equal(answered.body.task.answered.word, "推");
    assert.equal(answered.body.task.ask, undefined);
  });
});

test("the demo fixture seeds an empty state for UI work and e2e", async () => {
  const fixture = new URL("./fixtures/demo-state.json", import.meta.url).pathname;
  await withServer(async ({ call }) => {
    const need = (await call("GET", "/tasks?status=need")).body.tasks;
    assert.deepEqual(need.map((t) => t.id).sort(), ["CAS-4764", "EAI-370"]);
    assert.ok(need.every((t) => t.ask?.eventId));
    assert.equal((await call("GET", "/tasks?status=done")).body.tasks[0].id, "CAS-4739");
  }, { fixture });
});
