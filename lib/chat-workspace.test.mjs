import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  chatWorkspaceDir,
  createChatFolder,
  ensureChatCwd,
  ensureChatWorkspace,
  isChatFolderPath,
  isChatRootPath,
  isChatWorkspacePath,
  isLegacyChatWorkspacePath,
  legacyChatWorkspaceDir,
  pruneEmptyChatFolders,
} = await jiti.import("./chat-workspace.ts");

test("the chat root and the legacy cwd live under the configured agent directory", () => {
  const agentDir = path.join(os.tmpdir(), "pi-agent-test");
  assert.equal(chatWorkspaceDir(agentDir), path.join(agentDir, "chats"));
  assert.equal(legacyChatWorkspaceDir(agentDir), path.join(agentDir, "chat-workspace"));
});

test("ensureChatWorkspace creates a private root", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-workspace-"));
  const dir = await ensureChatWorkspace(agentDir);
  const info = await stat(dir);

  assert.equal(dir, path.join(agentDir, "chats"));
  assert.equal(info.isDirectory(), true);
  if (process.platform !== "win32") {
    assert.equal(info.mode & 0o777, 0o700);
  }
});

test("a chat is the root, one of its folders, or the legacy cwd, and nothing else", () => {
  const agentDir = path.join(os.tmpdir(), "pi-agent-test");
  const root = path.join(agentDir, "chats");
  const folder = path.join(root, "20261022-101500-ab12cd34");
  const legacy = path.join(agentDir, "chat-workspace");

  assert.equal(isChatRootPath(root, agentDir), true);
  assert.equal(isChatRootPath(`${root}${path.sep}`, agentDir), true);
  assert.equal(isChatRootPath(folder, agentDir), false);

  assert.equal(isChatFolderPath(folder, agentDir), true);
  assert.equal(isChatFolderPath(`${folder}${path.sep}`, agentDir), true);
  assert.equal(isChatFolderPath(root, agentDir), false, "the root is not a chat's folder");
  assert.equal(isChatFolderPath(path.join(folder, "attachments"), agentDir), false, "only direct children");
  assert.equal(isChatFolderPath(path.join(agentDir, "project"), agentDir), false);

  assert.equal(isLegacyChatWorkspacePath(legacy, agentDir), true);
  assert.equal(isChatFolderPath(legacy, agentDir), false);

  for (const cwd of [root, folder, legacy]) assert.equal(isChatWorkspacePath(cwd, agentDir), true, cwd);
  assert.equal(isChatWorkspacePath(path.join(agentDir, "project"), agentDir), false);
  assert.equal(isChatWorkspacePath(path.join(os.tmpdir(), "chats", "x"), agentDir), false);
  assert.equal(isChatWorkspacePath(undefined, agentDir), false);
});

test("createChatFolder makes a unique private folder under the root", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-folder-"));
  const now = new Date(2026, 9, 22, 10, 15, 30);
  const first = await createChatFolder(agentDir, now);
  const second = await createChatFolder(agentDir, now);

  assert.notEqual(first, second);
  assert.match(path.basename(first), /^20261022-101530-[0-9a-f]{8}$/);
  assert.equal(isChatFolderPath(first, agentDir), true);
  assert.equal((await stat(first)).isDirectory(), true);
  if (process.platform !== "win32") assert.equal((await stat(first)).mode & 0o777, 0o700);
});

test("ensureChatCwd brings back a chat's folder and the legacy cwd, and leaves other paths alone", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-ensure-"));
  const folder = path.join(agentDir, "chats", "20261022-101500-ab12cd34");
  const legacy = path.join(agentDir, "chat-workspace");
  const project = path.join(agentDir, "project");
  await ensureChatCwd(folder, agentDir);
  await ensureChatCwd(legacy, agentDir);
  await ensureChatCwd(project, agentDir);
  assert.equal((await stat(folder)).isDirectory(), true);
  assert.equal((await stat(legacy)).isDirectory(), true);
  await assert.rejects(stat(project));
});

test("pruneEmptyChatFolders removes only old, empty folders no session points at", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-prune-"));
  const root = await ensureChatWorkspace(agentDir);
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const make = async (name, { empty = true, aged = true } = {}) => {
    const dir = path.join(root, name);
    await mkdir(dir);
    if (!empty) await writeFile(path.join(dir, "notes.md"), "x");
    if (aged) await utimes(dir, old, old);
    return dir;
  };
  const stale = await make("stale");
  const fresh = await make("fresh", { aged: false });
  const withFile = await make("with-file", { empty: false });
  const inUse = await make("in-use");

  const removed = await pruneEmptyChatFolders(agentDir, { keep: new Set([inUse]) });
  assert.equal(removed, 1);
  await assert.rejects(stat(stale));
  for (const dir of [fresh, withFile, inUse]) assert.equal((await stat(dir)).isDirectory(), true, dir);
});
