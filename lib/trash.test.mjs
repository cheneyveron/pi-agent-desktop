import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { moveFolderToTrash } = await jiti.import("./trash.ts");

async function folder(root, name) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "notes.md"), "kept");
  return dir;
}

test("on macOS a folder goes to ~/.Trash with its files", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-trash-home-"));
  const dir = await folder(home, "chat-1");
  const target = await moveFolderToTrash(dir, { platform: "darwin", home });
  assert.equal(target, path.join(home, ".Trash", "chat-1"));
  assert.equal(await readFile(path.join(target, "notes.md"), "utf8"), "kept");
  await assert.rejects(stat(dir));
});

test("a name already in the Trash is not replaced", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-trash-home-"));
  await mkdir(path.join(home, ".Trash", "chat-1"), { recursive: true });
  const dir = await folder(home, "chat-1");
  const target = await moveFolderToTrash(dir, { platform: "darwin", home });
  assert.notEqual(target, path.join(home, ".Trash", "chat-1"));
  assert.match(path.basename(target), /^chat-1-[0-9a-f]{6}$/);
});

test("on Linux the folder goes to the XDG Trash with a .trashinfo record", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-trash-home-"));
  const previous = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  try {
    const dir = await folder(home, "chat-2");
    const target = await moveFolderToTrash(dir, { platform: "linux", home, now: new Date("2026-10-22T10:00:00Z") });
    assert.equal(target, path.join(home, ".local", "share", "Trash", "files", "chat-2"));
    const info = await readFile(path.join(home, ".local", "share", "Trash", "info", "chat-2.trashinfo"), "utf8");
    assert.match(info, /^\[Trash Info\]\nPath=.*chat-2\nDeletionDate=2026-10-22T10:00:00\n$/);
  } finally {
    if (previous !== undefined) process.env.XDG_DATA_HOME = previous;
  }
});

test("elsewhere the folder goes to the app's own chats-trash", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-trash-home-"));
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-trash-agent-"));
  const dir = await folder(home, "chat-3");
  const target = await moveFolderToTrash(dir, { platform: "win32", home, agentDir });
  assert.equal(target, path.join(agentDir, "chats-trash", "chat-3"));
  assert.equal(await readFile(path.join(target, "notes.md"), "utf8"), "kept");
});
