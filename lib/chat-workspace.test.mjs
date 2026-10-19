import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  chatWorkspaceDir,
  ensureChatWorkspace,
  isChatWorkspacePath,
} = await jiti.import("./chat-workspace.ts");

test("chat workspace lives under the configured agent directory", () => {
  const agentDir = path.join(os.tmpdir(), "pi-agent-test");
  assert.equal(chatWorkspaceDir(agentDir), path.join(agentDir, "chat-workspace"));
});

test("ensureChatWorkspace creates a private directory", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-workspace-"));
  const dir = await ensureChatWorkspace(agentDir);
  const info = await stat(dir);

  assert.equal(dir, path.join(agentDir, "chat-workspace"));
  assert.equal(info.isDirectory(), true);
  if (process.platform !== "win32") {
    assert.equal(info.mode & 0o777, 0o700);
  }
});

test("isChatWorkspacePath recognizes only the hidden chat cwd", () => {
  const agentDir = path.join(os.tmpdir(), "pi-agent-test");
  const chatDir = path.join(agentDir, "chat-workspace");

  assert.equal(isChatWorkspacePath(chatDir, agentDir), true);
  assert.equal(isChatWorkspacePath(`${chatDir}${path.sep}`, agentDir), true);
  assert.equal(isChatWorkspacePath(path.join(agentDir, "project"), agentDir), false);
  assert.equal(isChatWorkspacePath(undefined, agentDir), false);
});
