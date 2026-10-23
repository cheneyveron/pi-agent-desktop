import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { CHAT_UNLOCK_TYPE, appendChatUnlock, readChatUnlocked } = await jiti.import("./chat-unlock.ts");

const entry = (data, customType = CHAT_UNLOCK_TYPE) => ({ type: "custom", customType, data });

test("a chat is locked until a session entry unlocks it, and the newest entry wins", () => {
  assert.equal(readChatUnlocked([]), false);
  assert.equal(readChatUnlocked([entry({ version: 1, unlocked: true })]), true);
  assert.equal(readChatUnlocked([entry({ version: 1, unlocked: true }), entry({ version: 1, unlocked: false })]), false);
  assert.equal(readChatUnlocked([entry({ version: 1, unlocked: false }), entry({ version: 1, unlocked: true })]), true);
});

test("entries that are not valid unlock records are ignored", () => {
  assert.equal(readChatUnlocked([entry({ version: 2, unlocked: true })]), false);
  assert.equal(readChatUnlocked([entry({ version: 1, unlocked: "yes" })]), false);
  assert.equal(readChatUnlocked([entry(null)]), false);
  assert.equal(readChatUnlocked([entry({ version: 1, unlocked: true }, "pi-web:something-else")]), false);
  // A bad newest entry does not hide an older valid one.
  assert.equal(readChatUnlocked([entry({ version: 1, unlocked: true }), entry({ junk: true })]), true);
});

test("appendChatUnlock writes the record the reader understands", () => {
  const written = [];
  appendChatUnlock({ appendCustomEntry: (type, data) => written.push({ type: "custom", customType: type, data }) }, true);
  assert.equal(written[0].customType, CHAT_UNLOCK_TYPE);
  assert.equal(readChatUnlocked(written), true);
});
