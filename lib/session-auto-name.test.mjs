import assert from "node:assert/strict";
import test from "node:test";

import { isFirstUserMessage, SessionAutoNamer } from "./session-auto-name.ts";

const user = { type: "message", message: { role: "user" } };
const assistant = { type: "message", message: { role: "assistant" } };

function harness({ name, first = true, generate = async () => "Fix login redirect" } = {}) {
  const state = { name, applied: [], logged: [], calls: 0, alive: true };
  const namer = new SessionAutoNamer({
    sessionName: () => state.name,
    isFirstUserMessage: () => first,
    generate: () => {
      state.calls += 1;
      return generate(state.calls);
    },
    apply: (title) => {
      state.applied.push(title);
      state.name = title;
    },
    isAlive: () => state.alive,
    log: (message) => state.logged.push(message),
  });
  return { namer, state };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("only the first user message counts as first", () => {
  assert.equal(isFirstUserMessage([]), true);
  assert.equal(isFirstUserMessage([{ type: "model_change" }, user]), true);
  assert.equal(isFirstUserMessage([user, assistant, user]), false);
});

test("names a new unnamed session from its first message, once", async () => {
  const { namer, state } = harness();
  namer.onUserMessage();
  namer.onUserMessage();
  await settle();
  namer.onAgentEnd();
  await settle();
  assert.deepEqual(state.applied, ["Fix login redirect"]);
  assert.equal(state.calls, 1);
});

test("leaves named and resumed sessions alone for good", async () => {
  for (const options of [{ name: "Nightly report" }, { first: false }]) {
    const { namer, state } = harness(options);
    namer.onUserMessage();
    namer.onAgentEnd();
    await settle();
    assert.equal(state.calls, 0);
  }
});

test("a name given while the title is generated wins", async () => {
  let release;
  const { namer, state } = harness({ generate: () => new Promise((resolve) => { release = resolve; }) });
  namer.onUserMessage();
  state.name = "Renamed by the user";
  release("Generated title");
  await settle();
  assert.deepEqual(state.applied, []);
});

test("a failed first attempt retries once when the run ends", async () => {
  const { namer, state } = harness({
    generate: async (call) => {
      if (call === 1) throw new Error("The session has no usable text to name");
      return "Second try";
    },
  });
  namer.onUserMessage();
  await settle();
  assert.equal(state.logged.length, 1);
  namer.onAgentEnd();
  await settle();
  assert.deepEqual(state.applied, ["Second try"]);
});

test("gives up after the retry fails", async () => {
  const { namer, state } = harness({ generate: async () => { throw new Error("rate limited"); } });
  namer.onUserMessage();
  await settle();
  namer.onAgentEnd();
  await settle();
  namer.onAgentEnd();
  await settle();
  assert.equal(state.calls, 2);
  assert.deepEqual(state.applied, []);
});
