import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { CHAT_SHELL_BLOCK_MARKER, lastTurnHitChatShellBlock } = await jiti.import("./chat-shell-block.ts");
const { chatBlockedToolReason } = await jiti.import("./chat-workspace-policy.ts");

const user = { role: "user", content: "run it" };
const assistant = { role: "assistant", content: [] };
const blocked = (reason) => ({ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: reason }] });

test("the server's refusal of a shell in a chat with a folder carries the marker", () => {
  assert.ok(chatBlockedToolReason("bash", true).startsWith(CHAT_SHELL_BLOCK_MARKER));
  assert.ok(chatBlockedToolReason("powershell", true).startsWith(CHAT_SHELL_BLOCK_MARKER));
});

test("a refused shell call in the latest turn is found, and an older turn's is not", () => {
  const reason = chatBlockedToolReason("bash", true);
  assert.equal(lastTurnHitChatShellBlock([user, assistant, blocked(reason), assistant]), true);
  // The user has written since: the need is stale.
  assert.equal(lastTurnHitChatShellBlock([user, assistant, blocked(reason), assistant, user, assistant]), false);
  assert.equal(lastTurnHitChatShellBlock([user, assistant]), false);
  assert.equal(lastTurnHitChatShellBlock([]), false);
});

test("other tool errors do not offer the permission, and string content works", () => {
  assert.equal(lastTurnHitChatShellBlock([user, blocked("write failed: disk full")]), false);
  assert.equal(lastTurnHitChatShellBlock([user, { role: "toolResult", content: `${CHAT_SHELL_BLOCK_MARKER} nope` }]), true);
});
