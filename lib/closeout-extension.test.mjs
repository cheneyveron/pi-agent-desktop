import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, mock } from "node:test";
import { createJiti } from "jiti";
import { renderCloseoutPromptModule } from "../scripts/build-closeout-prompt.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ext = await jiti.import("./closeout-extension.ts");
const {
  buildCloseoutTranscript,
  createCloseoutExtension,
  deliverCloseout,
  flushDeferredCloseoutEntries,
  isMainSessionDisabled,
  mainSessionUrl,
  normalizePrCondition,
  parseCloseoutResponse,
  replayCloseoutOutbox,
  resolveCloseoutModel,
  selectCloseoutRange,
  shouldCloseOut,
} = ext;
const { closeoutPayloadFromEntry } = await jiti.import("./closeout-types.ts");

// The extension's timers are unref'd so they never keep a server alive; keep the test loop running meanwhile.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-closeout-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

let nextId = 0;
const id = () => `e${(nextId++).toString().padStart(3, "0")}`;
const user = (text) => ({ type: "message", id: id(), message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text, toolCalls = []) => ({
  type: "message",
  id: id(),
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "secret reasoning" },
      ...(text ? [{ type: "text", text }] : []),
      ...toolCalls.map(([name, args]) => ({ type: "toolCall", id: id(), name, arguments: args })),
    ],
  },
});
const toolResult = (toolName, text, isError = false) => ({
  type: "message", id: id(), message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] },
});
const system = () => ({ type: "message", id: id(), message: { role: "system", content: "prompt" } });
const closeoutEntry = (toEntryId, extra = {}) => ({
  type: "custom",
  id: id(),
  customType: "closeout",
  data: {
    v: 1,
    id: `co_${nextId}`,
    t: "2026-11-06T10:00:00.000Z",
    trigger: "idle",
    range: { afterEntryId: null, toEntryId, entries: 1 },
    delivery: { status: "sent", at: "2026-11-06T10:00:00.000Z" },
    closeout: {
      sessionId: "s1", cwd: "/repo", t: "2026-11-06T10:00:00.000Z", thread: "CAS-1",
      stands: "earlier stands", next: [], produced: [], learned: [], user_said: [], open: [],
    },
    ...extra,
  },
});

// ---------------------------------------------------------------------------
// Prompt, settings
// ---------------------------------------------------------------------------

test("the generated prompt module matches lib/closeout-prompt.md (run scripts/build-closeout-prompt.mjs)", () => {
  const markdown = readFileSync(new URL("./closeout-prompt.md", import.meta.url), "utf8");
  const generated = readFileSync(new URL("./closeout-prompt.generated.ts", import.meta.url), "utf8");
  assert.equal(generated, renderCloseoutPromptModule(markdown));
  assert.match(markdown, /on: "pr #<n>"/, "PR numbers become `on: pr #N`");
  assert.match(markdown, /keep the fact/, "anchors are encouraged, never forced");
});

test("the main session is off on request and under node --test unless a test opts in", () => {
  assert.equal(isMainSessionDisabled({}), false);
  assert.equal(isMainSessionDisabled({ PI_WEB_DISABLE_MAIN_SESSION: "1" }), true);
  assert.equal(isMainSessionDisabled({ PI_WEB_DISABLE_MAIN_SESSION: "0" }), false);
  assert.equal(isMainSessionDisabled({ NODE_TEST_CONTEXT: "child" }), true);
  assert.equal(isMainSessionDisabled({ NODE_TEST_CONTEXT: "child", PI_WEB_MAIN_SESSION_IN_TESTS: "1" }), false);
  assert.equal(mainSessionUrl({}), "http://127.0.0.1:30180");
  assert.equal(mainSessionUrl({ MAIN_SESSION_PORT: "4100" }), "http://127.0.0.1:4100");
  assert.equal(mainSessionUrl({ MAIN_SESSION_URL: "http://127.0.0.1:9/" }), "http://127.0.0.1:9");
});

// ---------------------------------------------------------------------------
// Incremental range
// ---------------------------------------------------------------------------

test("the first close-out covers the whole branch, without system messages or state entries", () => {
  const branch = [system(), user("fix it"), { type: "model_change", id: id() }, assistant("done")];
  const selection = selectCloseoutRange(branch);
  assert.deepEqual(selection.entries.map((entry) => entry.id), [branch[1].id, branch[3].id]);
  assert.deepEqual(selection.range, { afterEntryId: null, toEntryId: branch[3].id, entries: 2 });
});

test("a later close-out starts after the previous one's last entry", () => {
  const first = [user("one"), assistant("a")];
  const mark = closeoutEntry(first[1].id);
  const later = [user("two"), assistant("b")];
  const branch = [...first, mark, ...later];
  const selection = selectCloseoutRange(branch);
  assert.deepEqual(selection.entries.map((entry) => entry.id), later.map((entry) => entry.id));
  assert.equal(selection.range.afterEntryId, first[1].id);
  assert.equal(selection.range.toEntryId, later[1].id);
});

test("entries written while a close-out ran are not skipped", () => {
  // The close-out summarized up to `a`, but `two` landed before its entry did.
  const head = [user("one"), assistant("a")];
  const raced = user("two");
  const branch = [...head, raced, closeoutEntry(head[1].id), assistant("b")];
  assert.deepEqual(selectCloseoutRange(branch).entries.map((entry) => entry.id), [raced.id, branch[4].id]);
});

test("a close-out whose range is on another branch marks by its own position", () => {
  const branch = [user("one"), assistant("a"), closeoutEntry("elsewhere"), user("two"), assistant("b")];
  assert.deepEqual(selectCloseoutRange(branch).entries.map((entry) => entry.id), [branch[3].id, branch[4].id]);
});

test("an in-memory mark counts before its entry lands, and nothing new means no close-out", () => {
  const branch = [user("one"), assistant("a"), user("two"), assistant("b")];
  assert.deepEqual(selectCloseoutRange(branch, branch[1].id).entries.length, 2);
  assert.equal(selectCloseoutRange(branch, branch[3].id), undefined);
  assert.equal(selectCloseoutRange([...branch, closeoutEntry(branch[3].id)]), undefined);
});

// ---------------------------------------------------------------------------
// Transcript and trigger conditions
// ---------------------------------------------------------------------------

test("the transcript keeps text, summarizes tool calls, cuts results and drops thinking", () => {
  const long = "x".repeat(1000);
  const entries = [
    user("please fix the login bug"),
    assistant("Looking.", [["read", { path: "/repo/src/login.ts" }], ["bash", { command: "npm test" }]]),
    toolResult("read", long),
    toolResult("bash", "1 failing", true),
    assistant("Fixed in PR #752."),
    { type: "custom_message", id: id(), customType: "main-session-note", content: [{ type: "text", text: "[主会话提醒] check CI" }] },
  ];
  const transcript = buildCloseoutTranscript(entries, "/repo");
  assert.equal(transcript.userMessages, 1);
  assert.equal(transcript.assistantMessages, 2);
  assert.equal(transcript.toolCalls, 2);
  assert.deepEqual(transcript.filesRead, ["src/login.ts"]);
  assert.match(transcript.text, /USER: please fix the login bug/);
  assert.match(transcript.text, /\[tool read: path=\/repo\/src\/login\.ts\]/);
  assert.match(transcript.text, /\[result bash \(error\): 1 failing\]/);
  assert.match(transcript.text, /\[MAIN SESSION NOTE\] \[主会话提醒\] check CI/);
  assert.ok(!transcript.text.includes("secret reasoning"));
  assert.ok(!transcript.text.includes("x".repeat(301)), "tool results are cut to 300 characters");
});

test("the idle trigger needs tool activity; shutdown and compaction need a user and an assistant turn", () => {
  const chat = buildCloseoutTranscript([user("hi"), assistant("hello")], "/repo");
  const work = buildCloseoutTranscript([user("go"), assistant("", [["bash", { command: "ls" }]])], "/repo");
  const toolsOnly = buildCloseoutTranscript([assistant("", [["bash", { command: "ls" }]])], "/repo");
  assert.equal(shouldCloseOut("idle", chat), false);
  assert.equal(shouldCloseOut("idle", work), true);
  assert.equal(shouldCloseOut("shutdown", chat), true);
  assert.equal(shouldCloseOut("compaction", chat), true);
  assert.equal(shouldCloseOut("shutdown", toolsOnly), false);
  assert.equal(shouldCloseOut("idle", buildCloseoutTranscript([user("hi")], "/repo")), false);
});

// ---------------------------------------------------------------------------
// Parsing the model's answer
// ---------------------------------------------------------------------------

test("the model's JSON is normalized to the contract's shapes", () => {
  const fields = parseCloseoutResponse(`Here you go:\n\`\`\`json\n${JSON.stringify({
    thread: null,
    stands: "Branch fix/login pushed; PR #752 open.",
    next: [
      { text: "Merge after CI passes on PR #752", run: "checker" },
      { text: "Deploy", run: "sometimes", on: "https://github.com/o/r/pull/9" },
      { text: "Watch", run: "notify", on: "null" },
      "Tell QA",
      { run: "me" },
    ],
    produced: ["branch:fix/login", "", 3],
    learned: [
      { text: "Login uses a cookie", anchors: [{ path: "src/login.ts", symbol: "setCookie" }, { symbol: "x" }] },
      { text: "No anchor fact", anchors: [] },
      "plain fact",
    ],
    user_said: [{ text: "don't use X", kind: "correction" }, "always run tests", { text: "y", kind: "odd" }],
    open: [{ question: "Is staging up?", who: "ops", answerGoesTo: "session", then: "rerun" }, "who owns it?"],
    next_time: ["check cron first"],
  })}\n\`\`\``);
  assert.equal(fields.thread, "none");
  assert.deepEqual(fields.next, [
    { text: "Merge after CI passes on PR #752", run: "checker", on: "pr #752" },
    { text: "Deploy", run: "me", on: "pr #9" },
    { text: "Watch", run: "notify" },
    { text: "Tell QA", run: "me" },
  ]);
  assert.deepEqual(fields.produced, ["branch:fix/login"]);
  assert.deepEqual(fields.learned, [
    { text: "Login uses a cookie", anchors: [{ path: "src/login.ts", symbol: "setCookie" }] },
    { text: "No anchor fact" },
    { text: "plain fact" },
  ]);
  assert.deepEqual(fields.user_said, [
    { text: "don't use X", kind: "correction" },
    { text: "always run tests", kind: "instruction" },
    { text: "y", kind: "instruction" },
  ]);
  assert.deepEqual(fields.open, [
    { question: "Is staging up?", who: "ops", answerGoesTo: "session", then: "rerun" },
    { question: "who owns it?", who: "unknown", answerGoesTo: "task" },
  ]);
  assert.deepEqual(fields.next_time, ["check cron first"]);
  assert.equal(normalizePrCondition("PR 12"), "pr #12");
  assert.equal(normalizePrCondition("date 2026-11-09"), "date 2026-11-09");
});

test("an answer without a JSON object or a stands paragraph is an error", () => {
  assert.throws(() => parseCloseoutResponse("sorry"), /no JSON object/);
  assert.throws(() => parseCloseoutResponse("{\"stands\": \"\"}"), /no stands/);
  assert.throws(() => parseCloseoutResponse("{not json}"), /invalid JSON/);
});

// ---------------------------------------------------------------------------
// Model choice
// ---------------------------------------------------------------------------

test("the session's own model, except a disallowed rdsec model, which closes out on haiku", () => {
  const haiku = { provider: "rdsec", id: "claude-haiku-5-5" };
  const registry = (auth = true) => ({
    find: (provider, modelId) => (provider === "rdsec" && modelId === "claude-haiku-5-5" ? haiku : undefined),
    hasConfiguredAuth: () => auth,
  });
  const own = { provider: "anthropic", id: "claude-opus-5-5" };
  assert.equal(resolveCloseoutModel({ model: own, modelRegistry: registry() }), own);
  const luna = { provider: "rdsec", id: "gpt-6-luna" };
  assert.equal(resolveCloseoutModel({ model: luna, modelRegistry: registry() }), luna);
  assert.equal(resolveCloseoutModel({ model: { provider: "rdsec", id: "claude-opus-5-5" }, modelRegistry: registry() }), haiku);
  assert.equal(resolveCloseoutModel({ model: own, modelRegistry: registry(false) }), undefined);
  assert.equal(resolveCloseoutModel({ model: undefined, modelRegistry: registry() }), undefined);
});

// ---------------------------------------------------------------------------
// Delivery, outbox, replay
// ---------------------------------------------------------------------------

function payload(n, t = `2026-11-06T10:0${n}:00.000Z`) {
  return {
    id: `co_${n}`, sessionId: "s1", cwd: "/repo", t, thread: "none", stands: `stands ${n}`,
    next: [], produced: [], learned: [], user_said: [], open: [], trigger: "idle",
    range: { afterEntryId: null, toEntryId: "e1", entries: 1 },
  };
}

function recordingFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return answer(calls.length, JSON.parse(init.body));
  };
  return { fetch, calls };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a delivered close-out records the task and event the service assigned", async () => {
  const outboxDir = join(tempDir(), "outbox");
  const { fetch, calls } = recordingFetch(() => json({ task: { id: "CAS-1" }, event: { id: "ev1" } }));
  const delivery = await deliverCloseout(payload(1), { url: "http://svc", outboxDir, fetch, now: () => new Date("2026-11-06T11:00:00Z") });
  assert.deepEqual(delivery, { status: "sent", at: "2026-11-06T11:00:00.000Z", task: "CAS-1", eventId: "ev1" });
  assert.equal(calls[0].url, "http://svc/closeouts");
  assert.equal(calls[0].body.id, "co_1");
  assert.equal(existsSync(outboxDir), false);
});

test("a close-out the service cannot take goes to the outbox", async () => {
  const outboxDir = join(tempDir(), "outbox");
  const down = async () => { throw new TypeError("fetch failed"); };
  assert.equal((await deliverCloseout(payload(1), { url: "http://svc", outboxDir, fetch: down })).status, "queued");
  const failing = async () => json({ error: "busy" }, 503);
  assert.equal((await deliverCloseout(payload(2), { url: "http://svc", outboxDir, fetch: failing })).status, "queued");
  assert.deepEqual(readdirSync(outboxDir).sort(), ["co_1.json", "co_2.json"]);
  assert.equal(JSON.parse(readFileSync(join(outboxDir, "co_1.json"), "utf8")).stands, "stands 1");
});

test("the outbox replays oldest first, stops while the service is down, and sets aside rejected items", async () => {
  const outboxDir = join(tempDir(), "outbox");
  const down = async () => { throw new TypeError("fetch failed"); };
  for (const n of [3, 1, 2]) await deliverCloseout(payload(n), { url: "http://svc", outboxDir, fetch: down });
  writeFileSync(join(outboxDir, "garbage.json"), "{");

  const stillDown = await replayCloseoutOutbox({ url: "http://svc", outboxDir, fetch: down });
  assert.equal(stillDown.sent.length, 0);
  assert.equal(stillDown.remaining, 3);
  assert.deepEqual(stillDown.rejected, ["garbage.json"], "an unreadable item is set aside at once");

  const { fetch, calls } = recordingFetch((_n, body) => (body.id === "co_2" ? json({ error: "bad" }, 400) : json({ task: "T" })));
  const result = await replayCloseoutOutbox({ url: "http://svc", outboxDir, fetch });
  assert.deepEqual(calls.map((call) => call.body.id), ["co_1", "co_2", "co_3"]);
  assert.deepEqual(result.sent, ["co_1", "co_3"]);
  assert.deepEqual(result.rejected, ["co_2"]);
  assert.deepEqual(readdirSync(outboxDir), ["rejected"]);
  assert.deepEqual(readdirSync(join(outboxDir, "rejected")).sort(), ["co_2.json", "garbage.json"]);
});

test("a successful delivery replays what an earlier outage queued", async () => {
  const outboxDir = join(tempDir(), "outbox");
  await deliverCloseout(payload(1), { url: "http://svc", outboxDir, fetch: async () => { throw new Error("down"); } });
  const { fetch, calls } = recordingFetch(() => json({ task: "T" }));
  await deliverCloseout(payload(2), { url: "http://svc", outboxDir, fetch });
  await settle(10);
  assert.deepEqual(calls.map((call) => call.body.id), ["co_2", "co_1"]);
  assert.deepEqual(readdirSync(outboxDir), []);
});

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

const MODEL_ANSWER = JSON.stringify({
  thread: "CAS-4764",
  stands: "Fixed the login redirect; PR #752 open.",
  next: [{ text: "Merge PR #752 once CI is green", run: "checker" }],
  produced: ["pr:#752"],
  learned: [{ text: "Redirects go through authGuard", anchors: [{ path: "src/login.ts", symbol: "authGuard" }] }],
  user_said: [{ text: "Never touch the legacy flow", kind: "instruction" }],
  open: [{ question: "Does QA need a build?", who: "QA", answerGoesTo: "task" }],
});

function harness({ entries = [], cwd = "/repo", answer = async () => MODEL_ANSWER, enabled = () => true, fetchAnswer, agentDir = tempDir(), idleMs = 15, shutdownWaitMs = 50 } = {}) {
  const handlers = new Map();
  const appended = [];
  const prompts = [];
  const posts = [];
  const state = { idle: true, entries: [...entries] };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
      state.entries.push({ type: "custom", id: id(), customType, data });
    },
  };
  const ctx = {
    cwd,
    isIdle: () => state.idle,
    model: { provider: "rdsec", id: "claude-haiku-5-5" },
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
    sessionManager: {
      getBranch: () => state.entries,
      getEntries: () => state.entries,
      getSessionId: () => "s1",
      getSessionFile: () => "/sessions/s1.jsonl",
      getSessionName: () => "Fix login",
    },
  };
  const fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return fetchAnswer ? fetchAnswer(posts.length) : json({ task: { id: "CAS-4764" }, event: { id: "ev-1" } });
  };
  createCloseoutExtension({
    agentDir,
    // null: leave it to Settings › Main session, as in the app.
    ...(idleMs === null ? {} : { idleMs }),
    shutdownWaitMs,
    ...(enabled === null ? {} : { enabled }),
    complete: async (_ctx, model, userText) => {
      prompts.push({ model, userText });
      return answer(prompts.length);
    },
    delivery: { url: "http://svc", fetch },
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    log: () => {},
  })(pi);
  const emit = (name, event = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  return { handlers, appended, prompts, posts, state, ctx, emit, agentDir };
}

test("five idle minutes after a run that used tools write a closeout entry and post it", async () => {
  const work = [user("fix login"), assistant("on it", [["read", { path: "/repo/src/login.ts" }]]), toolResult("read", "code"), assistant("done, PR #752")];
  const h = harness({ entries: work });
  h.emit("agent_settled");
  await settle(60);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].userText, /USER: fix login/);
  assert.match(h.prompts[0].userText, /- src\/login\.ts/);
  assert.doesNotMatch(h.prompts[0].userText, /PREVIOUS CLOSE-OUT/);

  assert.equal(h.appended.length, 1);
  const { customType, data } = h.appended[0];
  assert.equal(customType, "closeout");
  assert.equal(data.v, 1);
  assert.match(data.id, /^co_/);
  assert.equal(data.trigger, "idle");
  assert.deepEqual(data.range, { afterEntryId: null, toEntryId: work[3].id, entries: 4 });
  assert.deepEqual(data.model, { provider: "rdsec", id: "claude-haiku-5-5" });
  assert.deepEqual(data.delivery, { status: "sent", at: "2026-11-06T12:00:00.000Z", task: "CAS-4764", eventId: "ev-1" });
  assert.deepEqual(data.closeout, {
    sessionId: "s1",
    cwd: "/repo",
    t: "2026-11-06T12:00:00.000Z",
    thread: "CAS-4764",
    stands: "Fixed the login redirect; PR #752 open.",
    next: [{ text: "Merge PR #752 once CI is green", run: "checker", on: "pr #752" }],
    produced: ["pr:#752"],
    learned: [{ text: "Redirects go through authGuard", anchors: [{ path: "src/login.ts", symbol: "authGuard" }] }],
    user_said: [{ text: "Never touch the legacy flow", kind: "instruction" }],
    open: [{ question: "Does QA need a build?", who: "QA", answerGoesTo: "task" }],
  });
  assert.deepEqual(h.posts[0].body, { ...data.closeout, id: data.id, trigger: "idle", range: data.range, sessionFile: "/sessions/s1.jsonl" });
  assert.deepEqual(closeoutPayloadFromEntry(data, "/sessions/s1.jsonl"), h.posts[0].body);
});

test("Settings › Main session decides whether a session closes out, and after how long", async () => {
  const previous = process.env.PI_WEB_MAIN_SESSION_IN_TESTS;
  process.env.PI_WEB_MAIN_SESSION_IN_TESTS = "1";
  try {
    const work = () => [user("fix login"), assistant("on it", [["read", { path: "/repo/src/login.ts" }]]), toolResult("read", "code"), assistant("done")];
    // No settings file: the feature is off by default, so not even a shutdown closes out.
    const off = harness({ entries: work(), enabled: null, idleMs: null });
    await off.emit("session_shutdown", { reason: "quit" });
    assert.equal(off.prompts.length, 0);

    const agentDir = tempDir();
    mkdirSync(join(agentDir, "pi-web"), { recursive: true });
    writeFileSync(join(agentDir, "pi-web", "settings.json"), JSON.stringify({ mainSession: { enabled: true, takeoverMinutes: 2 } }));
    const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const on = harness({ entries: work(), enabled: null, idleMs: null, agentDir });
      on.emit("agent_settled");
      mock.timers.tick(2 * 60_000 - 1);
      await flush();
      assert.equal(on.prompts.length, 0);
      mock.timers.tick(1);
      await flush();
      assert.equal(on.prompts.length, 1);
    } finally {
      mock.timers.reset();
    }
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_MAIN_SESSION_IN_TESTS;
    else process.env.PI_WEB_MAIN_SESSION_IN_TESTS = previous;
  }
});

test("no idle close-out without tool activity, and a new run cancels the wait", async () => {
  const chat = harness({ entries: [user("hi"), assistant("hello")] });
  chat.emit("agent_settled");
  await settle(40);
  assert.equal(chat.prompts.length, 0);

  const work = harness({ entries: [user("go"), assistant("", [["bash", { command: "ls" }]])] });
  work.emit("agent_settled");
  work.emit("agent_start");
  await settle(40);
  assert.equal(work.prompts.length, 0, "agent_start cleared the idle timer");

  const busy = harness({ entries: [user("go"), assistant("", [["bash", { command: "ls" }]])] });
  busy.state.idle = false;
  busy.emit("agent_settled");
  await settle(40);
  assert.equal(busy.prompts.length, 0, "a session that is not idle when the timer fires is left alone");
});

test("each close-out covers only what came after the previous one, with it as background", async () => {
  const h = harness({ entries: [user("first task"), assistant("", [["bash", { command: "make" }]]), assistant("built")] });
  h.emit("agent_settled");
  await settle(40);
  assert.equal(h.prompts.length, 1);
  const firstTo = h.appended[0].data.range.toEntryId;

  h.state.entries.push(user("second task"), assistant("", [["bash", { command: "make test" }]]));
  h.emit("agent_settled");
  await settle(40);
  assert.equal(h.prompts.length, 2);
  const second = h.prompts[1].userText;
  assert.doesNotMatch(second, /first task/);
  assert.match(second, /second task/);
  assert.match(second, /PREVIOUS CLOSE-OUT/);
  assert.match(second, /Fixed the login redirect/);
  assert.equal(h.appended[1].data.range.afterEntryId, firstTo);

  h.emit("agent_settled");
  await settle(40);
  assert.equal(h.prompts.length, 2, "nothing new, no close-out");
});

test("compaction closes out without holding it up", async () => {
  const h = harness({ entries: [user("long work"), assistant("progress")] });
  assert.equal(h.emit("session_before_compact", { reason: "threshold" }), undefined);
  await settle(10);
  assert.equal(h.appended[0].data.trigger, "compaction");
});

test("shutdown closes out; one that outlasts the wait is deferred to the next open", async () => {
  const quick = harness({ entries: [user("a"), assistant("b")] });
  await quick.emit("session_shutdown", { reason: "quit" });
  assert.equal(quick.appended.length, 1);
  assert.equal(quick.appended[0].data.trigger, "shutdown");

  const agentDir = tempDir();
  let release;
  const slow = harness({
    agentDir,
    entries: [user("a"), assistant("b")],
    answer: () => new Promise((resolve) => { release = () => resolve(MODEL_ANSWER); }),
  });
  await slow.emit("session_shutdown", { reason: "quit" });
  assert.equal(slow.appended.length, 0, "the wait ended before the model answered");
  release();
  await settle(20);
  assert.equal(slow.appended.length, 0, "a closed session gets no entry");
  const deferredDir = join(agentDir, "main", "deferred-entries", "s1");
  assert.equal(readdirSync(deferredDir).length, 1);
  assert.equal(slow.posts.length, 1, "the service still got it");

  const reopened = harness({ agentDir, entries: slow.state.entries });
  reopened.emit("session_start", { reason: "startup" });
  assert.equal(reopened.appended.length, 1);
  assert.equal(reopened.appended[0].data.trigger, "shutdown");
  assert.deepEqual(readdirSync(deferredDir), []);
  // The restored entry marks the range: nothing is left to close out.
  await reopened.emit("session_shutdown", { reason: "quit" });
  assert.equal(reopened.prompts.length, 0);
});

test("a reload is not a shutdown, and a disabled session never closes out", async () => {
  const reload = harness({ entries: [user("a"), assistant("b")] });
  await reload.emit("session_shutdown", { reason: "reload" });
  assert.equal(reload.prompts.length, 0);

  const off = harness({ entries: [user("a"), assistant("b")], enabled: () => false });
  await off.emit("session_shutdown", { reason: "quit" });
  off.emit("session_before_compact");
  await settle(10);
  assert.equal(off.prompts.length, 0);
});

test("a failed model call writes nothing and leaves the range for the next trigger", async () => {
  let calls = 0;
  const h = harness({
    entries: [user("a"), assistant("b")],
    answer: async () => {
      calls += 1;
      if (calls === 1) throw new Error("rate limited");
      return MODEL_ANSWER;
    },
  });
  await h.emit("session_before_compact");
  await settle(10);
  assert.equal(h.appended.length, 0);
  await h.emit("session_shutdown", { reason: "quit" });
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].data.range.afterEntryId, null);
});

test("the service being down queues the close-out and says so in the entry", async () => {
  const agentDir = tempDir();
  const h = harness({ agentDir, entries: [user("a"), assistant("b")], fetchAnswer: () => { throw new TypeError("fetch failed"); } });
  await h.emit("session_shutdown", { reason: "quit" });
  assert.equal(h.appended[0].data.delivery.status, "queued");
  assert.deepEqual(readdirSync(join(agentDir, "main", "outbox")), [`${h.appended[0].data.id}.json`]);
});

test("deferred entries already in the session are not appended twice", () => {
  const agentDir = tempDir();
  const data = closeoutEntry("e1").data;
  const dir = join(agentDir, "main", "deferred-entries", "s1");
  ext.deferCloseoutEntry(agentDir, "s1", data);
  const appended = [];
  assert.equal(flushDeferredCloseoutEntries(agentDir, "s1", new Set([data.id]), (item) => appended.push(item)), 0);
  assert.deepEqual(appended, []);
  assert.deepEqual(readdirSync(dir), []);
});
