import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseInsertEvent, parseSseFrames, startMainSessionStream } = await jiti.import("./main-session-insert-client.ts");
const { AgentSessionWrapper, injectMainSessionNote, ensureMainSessionInsertClient } = await jiti.import("./rpc-manager.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");

const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

test("SSE frames parse per the EventSource format and keep an unfinished tail", () => {
  const { frames, rest } = parseSseFrames(
    ": keep-alive\n\nevent: insert\ndata: {\"a\":1}\n\nevent: task\r\ndata: x\r\ndata: y\r\n\r\ndata: plain\n\nevent: insert\ndata: {\"b\"",
  );
  assert.deepEqual(frames, [
    { event: "insert", data: "{\"a\":1}" },
    { event: "task", data: "x\ny" },
    { event: "message", data: "plain" },
  ]);
  assert.equal(rest, "event: insert\ndata: {\"b\"");
});

test("an insert event needs a session id and text", () => {
  assert.deepEqual(parseInsertEvent(JSON.stringify({ sessionId: "s1", text: "check CI", task: "CAS-1", eventId: "ev" })), {
    sessionId: "s1", text: "check CI", task: "CAS-1", eventId: "ev",
  });
  assert.deepEqual(parseInsertEvent(JSON.stringify({ sessionId: "s1", text: "t" })), { sessionId: "s1", text: "t" });
  assert.equal(parseInsertEvent(JSON.stringify({ sessionId: "s1", text: " " })), undefined);
  assert.equal(parseInsertEvent(JSON.stringify({ text: "t" })), undefined);
  assert.equal(parseInsertEvent("{"), undefined);
});

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("the stream client delivers inserts, reconnects after a refused connection, and stops", async () => {
  const urls = [];
  const inserts = [];
  let connects = 0;
  let attempt = 0;
  let resolveSecondInsert;
  const secondInsert = new Promise((resolve) => { resolveSecondInsert = resolve; });
  const stream = startMainSessionStream({
    url: "http://svc",
    minDelayMs: 5,
    maxDelayMs: 10,
    fetch: async (url) => {
      urls.push(url);
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
      // Split mid-frame: the client must buffer across chunks.
      return sseResponse([
        "event: task\ndata: {}\n\nevent: insert\ndata: {\"sessionId\":\"s1\",",
        `"text":"note ${attempt}","task":"CAS-1"}\n\n`,
      ]);
    },
    onConnect: () => { connects += 1; },
    onInsert: (event) => {
      inserts.push(event);
      if (inserts.length === 2) resolveSecondInsert();
    },
  });
  await secondInsert;
  stream.stop();
  await stream.done;
  assert.equal(urls[0], "http://svc/stream");
  assert.ok(connects >= 2);
  assert.deepEqual(inserts.slice(0, 2), [
    { sessionId: "s1", text: "note 2", task: "CAS-1" },
    { sessionId: "s1", text: "note 3", task: "CAS-1" },
  ]);
});

test("the insert client does not start under node --test", () => {
  ensureMainSessionInsertClient();
  assert.equal(globalThis.__piWebMainSessionStream, undefined);
});

// ---------------------------------------------------------------------------
// injectMainSessionNote
// ---------------------------------------------------------------------------

function makeInner({ streaming = false, compacting = false } = {}) {
  const sent = [];
  const inner = {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    isStreaming: streaming,
    isCompacting: compacting,
    get isIdle() { return !streaming && !compacting; },
    isBashRunning: false,
    sessionManager: { getCwd: () => "/tmp" },
    agent: { state: {} },
    settingsManager: { getDefaultTools: () => [] },
    subscribe: () => () => {},
    dispose() {},
    sent,
    async sendCustomMessage(message, options) {
      sent.push({ message, options });
    },
  };
  return inner;
}

function register(inner) {
  const wrapper = new AgentSessionWrapper(inner);
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[inner.sessionId, wrapper]]);
  return () => {
    wrapper.destroy();
    globalThis.__piSessions = previous;
  };
}

test("a streaming session takes the note as a steer", async () => {
  const inner = makeInner({ streaming: true });
  const unregister = register(inner);
  try {
    const result = await injectMainSessionNote("s1", "  PR #752 merged, verify on staging  ", "CAS-4764", { eventId: "ev-9" });
    assert.equal(result.delivered, true);
    assert.equal(result.delivery, "steer");
    assert.equal(inner.sent.length, 1);
    const { message, options } = inner.sent[0];
    assert.deepEqual(options, { deliverAs: "steer" });
    assert.equal(message.customType, "main-session-note");
    assert.equal(message.display, true);
    assert.deepEqual(message.content, [{ type: "text", text: "[主会话提醒] PR #752 merged, verify on staging" }]);
    assert.equal(message.details.v, 1);
    assert.equal(message.details.id, result.id);
    assert.match(message.details.id, /^msn_/);
    assert.equal(message.details.text, "PR #752 merged, verify on staging");
    assert.equal(message.details.task, "CAS-4764");
    assert.equal(message.details.eventId, "ev-9");
    assert.equal(message.details.delivery, "steer");
    assert.ok(!Number.isNaN(Date.parse(message.details.t)));
  } finally {
    unregister();
  }
});

test("an idle session gets the note in its context without starting a turn", async () => {
  const inner = makeInner();
  const unregister = register(inner);
  try {
    const result = await injectMainSessionNote("s1", "remember the cron window");
    assert.equal(result.delivery, "append");
    assert.deepEqual(inner.sent[0].options, { triggerTurn: false });
    assert.equal(inner.sent[0].message.details.task, undefined);
  } finally {
    unregister();
  }
});

test("a session busy without streaming (compaction, retry) holds the note for its next prompt", async () => {
  const inner = makeInner({ compacting: true });
  const unregister = register(inner);
  try {
    const result = await injectMainSessionNote("s1", "note", "T-1");
    assert.equal(result.delivery, "next-turn");
    assert.deepEqual(inner.sent[0].options, { deliverAs: "nextTurn" });
  } finally {
    unregister();
  }
});

test("a session that is not open, or an empty note, is not delivered", async () => {
  assert.deepEqual(await injectMainSessionNote("nobody", "hi"), { delivered: false, reason: "not-open" });
  const inner = makeInner();
  const unregister = register(inner);
  try {
    assert.deepEqual(await injectMainSessionNote("s1", "   "), { delivered: false, reason: "empty" });
    assert.equal(inner.sent.length, 0);
  } finally {
    unregister();
  }
});

// ---------------------------------------------------------------------------
// session-reader surfaces both entries
// ---------------------------------------------------------------------------

test("the transcript surfaces closeout cards and main-session notes, and no other custom entry", () => {
  const closeoutData = {
    v: 1,
    id: "co_1",
    t: "2026-11-06T12:00:00.000Z",
    trigger: "idle",
    range: { afterEntryId: null, toEntryId: "a1", entries: 2 },
    model: { provider: "rdsec", id: "claude-haiku-5-5" },
    delivery: { status: "queued", at: "2026-11-06T12:00:00.000Z" },
    closeout: {
      sessionId: "s1", cwd: "/repo", t: "2026-11-06T12:00:00.000Z", thread: "none",
      stands: "Login fixed.", next: [], produced: [], learned: [], user_said: [], open: [],
    },
  };
  const note = { v: 1, id: "msn_1", t: "2026-11-06T12:01:00.000Z", text: "check CI", task: "CAS-1", delivery: "append" };
  const ts = "2026-11-06T12:00:00.000Z";
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: ts, message: { role: "user", content: "fix", timestamp: 1 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } },
    { type: "custom", id: "c1", parentId: "a1", timestamp: ts, customType: "closeout", data: closeoutData },
    { type: "custom", id: "c2", parentId: "c1", timestamp: ts, customType: "something-else", data: {} },
    { type: "custom", id: "c3", parentId: "c2", timestamp: ts, customType: "closeout", data: { broken: true } },
    {
      type: "custom_message", id: "n1", parentId: "c3", timestamp: ts, customType: "main-session-note", display: true,
      content: [{ type: "text", text: "[主会话提醒] check CI" }], details: note,
    },
  ];
  const context = buildSessionContext(entries, "n1");
  assert.deepEqual(context.entryIds, ["u1", "a1", "c1", "n1"]);
  assert.deepEqual(context.messages[2], {
    role: "custom", customType: "closeout", content: "Login fixed.", display: true, details: closeoutData, timestamp: Date.parse(ts),
  });
  assert.deepEqual(context.messages[3], {
    role: "custom", customType: "main-session-note", content: [{ type: "text", text: "[主会话提醒] check CI" }],
    display: true, details: note, timestamp: Date.parse(ts),
  });
});

// ---------------------------------------------------------------------------
// The write gate's switch, and what the cards read from a session
// ---------------------------------------------------------------------------

test("the latest message decides whether the turn is gated: the main session's is, the user's is not", async () => {
  const inner = { ...makeInner({ streaming: true }), steer: async () => {}, followUp: async () => {} };
  const gate = { gated: false };
  const wrapper = new AgentSessionWrapper(inner, { mainSessionGate: gate });
  try {
    await wrapper.send({ type: "follow_up", message: "[主会话续做] 跑单测", mainSession: true });
    assert.equal(gate.gated, true);
    // Commands that are not messages leave it alone.
    await wrapper.send({ type: "get_state" }).catch(() => {});
    assert.equal(gate.gated, true);
    await wrapper.send({ type: "steer", message: "我来接手" });
    assert.equal(gate.gated, false);
    // Only the literal flag gates: a truthy look-alike from a request body does not un-gate, a missing one does.
    await wrapper.send({ type: "follow_up", message: "x", mainSession: "yes" });
    assert.equal(gate.gated, false);
  } finally {
    wrapper.destroy();
  }
});

test("a session's snapshot carries the waiting dialog's id and text for the card to answer", async () => {
  const inner = makeInner();
  const wrapper = new AgentSessionWrapper(inner);
  try {
    wrapper.pendingUiRequests.set("d1", { type: "extension_ui_request", id: "d1", method: "confirm", title: "主会话续做：需要你批准", message: "git push origin main" });
    wrapper.pendingUiRequests.set("n1", { type: "extension_ui_request", id: "n1", method: "notify", title: "fyi" });
    assert.deepEqual(wrapper.getTaskSnapshot().waiting, [
      { method: "confirm", prompt: "主会话续做：需要你批准", id: "d1", message: "git push origin main" },
    ]);
  } finally {
    wrapper.pendingUiRequests.clear();
    wrapper.destroy();
  }
});
