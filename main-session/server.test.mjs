import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModelAvailable, envModelRef, lookupModel, parseModelRef, parseThinkingLevel } from "./pi-runtime.ts";
import { actionTools } from "./judge.ts";
import { startServer } from "./server.ts";
import { Store } from "./store.ts";
import { makeCtx, task } from "./test-helpers.mjs";

async function withServer(fn, options = {}) {
  const judged = [];
  const dispatched = [];
  const started = await startServer({
    port: 0, dir: null, timers: false, envModel: null,
    judgeRunner: async ({ user, tools, model, thinkingLevel }) => { judged.push({ user, tools: tools.map((t) => t.name), model, thinkingLevel }); return ""; },
    dispatcher: async (request) => { dispatched.push(request); return { ok: true, result: "PASS: fine" }; },
    checkModel: async () => undefined,
    memory: { write: async () => "sent" },
    settings: () => ({ enabled: true, autoContinue: true, takeoverMinutes: 5 }),
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
    await fn({ call, base, service: started.service, judged, dispatched });
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
    assert.equal(health.body.version, "1.1.0");
    assert.equal((await call("POST", "/model", { model: "anthropic/claude-haiku-4-5" })).status, 200);

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
    assert.deepEqual(judged[0].tools, ["assign", "update", "dispatch_readonly", "ask", "archive", "remember", "insert", "continue", "schedule", "digest"]);
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

test("model refs are provider/modelId; the registry must still have the model", async () => {
  assert.equal(parseModelRef(undefined), null);
  assert.equal(parseModelRef(" "), null);
  assert.deepEqual(parseModelRef("anthropic/claude-haiku-4-5"), { provider: "anthropic", modelId: "claude-haiku-4-5" });
  assert.deepEqual(parseModelRef("openrouter/qwen/qwen3-coder"), { provider: "openrouter", modelId: "qwen/qwen3-coder" });
  for (const bad of ["claude-haiku-5-5", "/x", "anthropic/", 7]) assert.throws(() => parseModelRef(bad), /provider\/modelId/);
  assert.equal(envModelRef(undefined), null);
  assert.throws(() => envModelRef("gpt-6-luna"), /MAIN_SESSION_MODEL: .*provider\/modelId/);

  const registry = {
    getModel: (provider, id) => (provider === "anthropic" && id === "claude-haiku-4-5") || (provider === "rdsec" && id === "x") ? { provider, id } : undefined,
    getAvailable: async (provider) => (provider === "anthropic" ? [{ provider: "anthropic", id: "claude-haiku-4-5" }] : []),
  };
  assert.deepEqual(lookupModel(registry, { provider: "anthropic", modelId: "claude-haiku-4-5" }), { provider: "anthropic", id: "claude-haiku-4-5" });
  assert.throws(() => lookupModel(registry, { provider: "rdsec", modelId: "claude-haiku-5-5" }), /rdsec\/claude-haiku-5-5 is not configured in Pi any more/);
  await checkModelAvailable(registry, { provider: "anthropic", modelId: "claude-haiku-4-5" });
  await assert.rejects(checkModelAvailable(registry, { provider: "rdsec", modelId: "x" }), /provider rdsec is not signed in/);
  await assert.rejects(checkModelAvailable(registry, { provider: "nope", modelId: "y" }), /not configured/);
});

test("without a chosen model no model turn runs; choosing one through POST /model takes effect at once", async () => {
  await withServer(async ({ call, judged, dispatched, service }) => {
    const health = (await call("GET", "/health")).body;
    assert.deepEqual(health.model, { ref: null, source: null, thinkingLevel: "off" });
    assert.equal(health.judge.enabled, true);
    assert.equal(health.judge.available, false);

    await call("POST", "/closeouts", closeout);
    const chat = await call("POST", "/chat", { text: "CAS-4764 卡在哪" });
    assert.match(chat.body.reply, /CAS-4764/, "answered from the store");
    const askId = (await call("GET", "/tasks/CAS-4764")).body.openAsks[0].id;
    await call("POST", "/tasks/CAS-4764/answer", { word: "派人查", eventId: askId });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(judged.length, 0, "no judgment turn without a model");
    assert.equal(dispatched.length, 0, "no dispatched session without a model");
    const paused = service.store.listEvents().find((e) => e.action === "dispatch_readonly" && e.data?.result);
    assert.match(paused.data.result, /no model is chosen/);

    assert.equal((await call("POST", "/model", {})).status, 400);
    assert.equal((await call("POST", "/model", { model: "claude-haiku-5-5" })).status, 400);
    const set = await call("POST", "/model", { model: "openai-codex/gpt-6" });
    assert.equal(set.status, 200);
    assert.equal(set.body.ref, "openai-codex/gpt-6");
    assert.equal(set.body.source, "settings");
    assert.equal((await call("GET", "/model")).body.ref, "openai-codex/gpt-6");
    const after = (await call("GET", "/health")).body;
    assert.equal(after.model.ref, "openai-codex/gpt-6");
    assert.equal(after.judge.available, true);

    await call("POST", "/closeouts", { ...closeout, sessionId: "sess-9", thread: "CAS-9" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(judged.length, 1);
    assert.deepEqual(judged[0].model, { provider: "openai-codex", modelId: "gpt-6" });

    const cleared = await call("POST", "/model", { model: null });
    assert.deepEqual(cleared.body, { ref: null, source: null, thinkingLevel: "off" });
    assert.equal((await call("GET", "/health")).body.judge.available, false);
  });
});

test("the reasoning level is chosen with POST /model, kept across model changes, and given to every turn", async () => {
  await withServer(async ({ call, judged }) => {
    assert.equal((await call("POST", "/model", { thinkingLevel: "deep" })).status, 400);
    const set = await call("POST", "/model", { thinkingLevel: "high" });
    assert.equal(set.status, 200);
    assert.equal(set.body.thinkingLevel, "high");
    assert.equal((await call("GET", "/health")).body.model.thinkingLevel, "high");
    const both = await call("POST", "/model", { model: "openai-codex/gpt-6", thinkingLevel: "low" });
    assert.deepEqual([both.body.ref, both.body.thinkingLevel], ["openai-codex/gpt-6", "low"]);
    await call("POST", "/model", { model: "anthropic/claude-haiku-4-5" });
    assert.equal((await call("GET", "/model")).body.thinkingLevel, "low", "changing the model keeps the level");

    await call("POST", "/closeouts", closeout);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(judged.at(-1).thinkingLevel, "low");

    assert.equal((await call("POST", "/model", { thinkingLevel: null })).body.thinkingLevel, "off");
    for (const bad of ["auto", 3, "HIGH"]) assert.throws(() => parseThinkingLevel(bad), /thinkingLevel must be one of/);
    assert.equal(parseThinkingLevel(undefined), "off");
  });
});

test("a chat reply streams as chat events while it is produced; the follow-up sees the conversation", async () => {
  await withServer(async ({ call, base }) => {
    await call("POST", "/model", { model: "anthropic/claude-haiku-4-5" });
    await call("POST", "/closeouts", closeout);
    await new Promise((r) => setTimeout(r, 20));
    const controller = new AbortController();
    const res = await fetch(`${base}/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    let seen = "";
    const until = async (pattern) => {
      while (!pattern.test(seen)) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += Buffer.from(value).toString("utf8");
      }
    };
    await until(/event: hello/);
    const first = await call("POST", "/chat", { text: "CAS-4764 卡在哪" });
    assert.equal(first.body.reply, "CAS-4764 等你决定推还是放弃。");
    await until(/event: chat\ndata: .*"delta":"CAS-4764 等你/);
    assert.match(seen, /"delta":"决定推还是放弃。"/, "the second delta arrived too");

    const second = await call("POST", "/chat", { text: "那下一步呢" });
    assert.equal(second.body.reply, "follow-up ok");
    controller.abort();
  }, {
    judgeRunner: async ({ user, onText, thinkingLevel }) => {
      assert.equal(thinkingLevel, "off");
      if (/那下一步呢/.test(user)) {
        assert.match(user, /## Recent conversation \(oldest first\)\nUser: CAS-4764 卡在哪\nMain: CAS-4764 等你决定推还是放弃。/);
        assert.match(user, /## Task CAS-4764/, "the task the last reply cited is given in full");
        return "follow-up ok";
      }
      onText("CAS-4764 等你");
      onText("决定推还是放弃。");
      return "CAS-4764 等你决定推还是放弃。";
    },
  });
});

test("a model the registry refuses is not saved, and the reason comes back", async () => {
  await withServer(async ({ call }) => {
    const refused = await call("POST", "/model", { model: "rdsec/claude-haiku-5-5" });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /rdsec\/claude-haiku-5-5 is not configured/);
    assert.equal((await call("GET", "/model")).body.ref, null);
  }, { checkModel: async (ref) => { lookupModel({ getModel: () => undefined }, ref); } });
});

test("MAIN_SESSION_MODEL overrides the saved choice and locks it", async () => {
  await withServer(async ({ call }) => {
    assert.deepEqual((await call("GET", "/health")).body.model, { ref: "anthropic/claude-haiku-4-5", source: "env", thinkingLevel: "off" });
    const locked = await call("POST", "/model", { model: "openai-codex/gpt-6" });
    assert.equal(locked.status, 409);
    assert.match(locked.body.error, /MAIN_SESSION_MODEL/);
  }, { envModel: "anthropic/claude-haiku-4-5" });
  await assert.rejects(startServer({ port: 0, dir: null, timers: false, envModel: "gpt-6-luna" }), /MAIN_SESSION_MODEL/);
});

test("the choice is saved in the state dir and survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "main-session-model-"));
  try {
    await withServer(async ({ call }) => {
      await call("POST", "/model", { model: "anthropic/claude-haiku-4-5" });
    }, { dir });
    assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).model, "anthropic/claude-haiku-4-5");
    assert.equal(new Store(dir).settings.model, "anthropic/claude-haiku-4-5");
    await withServer(async ({ call }) => {
      assert.equal((await call("GET", "/health")).body.model.ref, "anthropic/claude-haiku-4-5");
    }, { dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

// ── Settings › Main session ──────────────────────────────────────────────

test("with the main session off in Settings, close-outs are recorded but get no turn and nothing is continued", async () => {
  const settings = { enabled: false, autoContinue: true, takeoverMinutes: 5 };
  await withServer(async ({ call, service, judged }) => {
    const sent = [];
    service.subscribe((type, data) => { if (type === "continue") sent.push(data); });
    await call("POST", "/model", { model: "anthropic/claude-haiku-4-5" });
    assert.deepEqual((await call("GET", "/health")).body.settings, { enabled: false, autoContinue: true });
    assert.equal((await call("POST", "/closeouts", closeout)).status, 201);
    await call("POST", "/tasks/CAS-4764/answer", { word: "推" });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(judged.length, 0, "no judgment turn while off");
    assert.deepEqual(sent, [], "no answer goes on while off");
    assert.equal(service.judge.available, false);

    settings.enabled = true;
    assert.equal(service.judge.available, true, "read on every use: no restart needed");
  }, { settings: () => settings, forwardDelayMs: 20 });
});

test("without automatic continue the judge has no continue tool and the service refuses its own steps", async () => {
  await withServer(async ({ call, service, judged }) => {
    await call("POST", "/model", { model: "anthropic/claude-haiku-4-5" });
    await call("POST", "/closeouts", closeout);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(judged.length >= 1);
    assert.ok(!judged[0].tools.includes("continue"));
    assert.match(judged[0].user, /automatic continue off/);
    const tools = actionTools(service.ctx, { kind: "chat", text: "x" }, []);
    assert.ok(!tools.some((tool) => tool.name === "continue"));
    const { continueSession } = await import("./actions.ts");
    assert.throws(() => continueSession(service.ctx, { task: "CAS-4764", text: "run the tests", origin: "main", why: "w" }), /automatic continue is turned off/);
    // The user's own answer still reaches the session.
    const event = continueSession(service.ctx, { task: "CAS-4764", text: "你的回复：推", origin: "user", why: "the user's answer" });
    assert.equal(event.data.origin, "user");
  }, { settings: () => ({ enabled: true, autoContinue: false, takeoverMinutes: 5 }) });
});

// ── answers go on to the task's work session ─────────────────────────────

test("a decision is passed to the work session after the undo window; the service's own words and undone answers are not", async () => {
  await withServer(async ({ call, service }) => {
    const sent = [];
    service.subscribe((type, data) => { if (type === "continue") sent.push(data); });
    const wait = () => new Promise((resolve) => setTimeout(resolve, 60));
    await call("POST", "/closeouts", closeout);

    // "稍后" is the service's own (snooze): nothing is sent.
    await call("POST", "/tasks/CAS-4764/answer", { word: "稍后" });
    await wait();
    assert.deepEqual(sent, []);

    // An undone answer never reaches the session.
    await call("POST", "/closeouts", { ...closeout, t: "2026-11-05T11:00:00.000Z", open: [{ question: "推还是等？", who: "me" }] });
    const undone = await call("POST", "/tasks/CAS-4764/answer", { word: "推" });
    await call("POST", "/tasks/CAS-4764/undo", { eventId: undone.body.event.id });
    await wait();
    assert.deepEqual(sent, []);

    // A decision goes on, with the question it answers, as the user's own message.
    const answered = await call("POST", "/tasks/CAS-4764/answer", { word: "推" });
    await wait();
    assert.equal(sent.length, 1);
    assert.deepEqual(
      { task: sent[0].task, sessionId: sent[0].sessionId, origin: sent[0].origin, text: sent[0].text },
      { task: "CAS-4764", sessionId: "sess-1", origin: "user", text: "你的决定：推\n（针对：推还是等？）" },
    );
    assert.equal(service.store.getEvent(answered.body.event.id).data.forwarded, sent[0].eventId);

    // A reply with nothing asked goes on too; the app reports where it landed.
    await call("POST", "/tasks/CAS-4764/answer", { word: "先别合并，等我看完日志" });
    await wait();
    assert.equal(sent[1].text, "你的回复：先别合并，等我看完日志");
    const delivered = await call("POST", `/continues/${sent[1].eventId}/delivered`, { sessionId: "sess-2" });
    assert.equal(delivered.status, 200);
    assert.deepEqual(service.store.getTask("CAS-4764").sessions, ["sess-2", "sess-1"]);
    assert.equal((await call("POST", "/continues/e_nope/delivered", {})).status, 404);
  }, { forwardDelayMs: 20 });
});
