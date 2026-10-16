import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./message-keys.ts");
}

const user = { role: "user" };
const assistant = { role: "assistant" };

test("a pending message keeps its key once its entry id arrives", async () => {
  const { createMessageKeyTracker, assignMessageKeys } = await loadSubject();
  const tracker = createMessageKeyTracker();
  const before = assignMessageKeys(tracker, [user, assistant, user], ["a", "b"]);
  assert.deepEqual(before.slice(0, 2), ["a", "b"]);
  const streamed = assignMessageKeys(tracker, [user, assistant, user, assistant], ["a", "b"]);
  assert.equal(streamed[2], before[2]);
  const reloaded = assignMessageKeys(tracker, [user, assistant, user, assistant], ["a", "b", "c", "d"]);
  assert.deepEqual(reloaded, streamed);
  // and stays stable on later renders
  assert.deepEqual(assignMessageKeys(tracker, [user, assistant, user, assistant], ["a", "b", "c", "d"]), streamed);
});

test("a different role at the same position does not inherit the key", async () => {
  const { createMessageKeyTracker, assignMessageKeys } = await loadSubject();
  const tracker = createMessageKeyTracker();
  const [pendingKey] = assignMessageKeys(tracker, [user], []);
  const [key] = assignMessageKeys(tracker, [assistant], ["x"]);
  assert.equal(key, "x");
  assert.notEqual(key, pendingKey);
});

test("keys stay unique when a local key has been handed over", async () => {
  const { createMessageKeyTracker, assignMessageKeys } = await loadSubject();
  const tracker = createMessageKeyTracker();
  assignMessageKeys(tracker, [user], []);
  assignMessageKeys(tracker, [user], ["a"]);
  // the same position pending again (e.g. after switching branch) gets a fresh key
  assignMessageKeys(tracker, [user], []);
  assignMessageKeys(tracker, [user], ["b"]);
  const keys = assignMessageKeys(tracker, [user, user], ["a", "b"]);
  assert.equal(new Set(keys).size, 2);
});
