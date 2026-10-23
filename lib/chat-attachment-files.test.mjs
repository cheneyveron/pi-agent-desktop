import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { saveAttachedFilesToFolder } = await jiti.import("./chat-attachment-files.ts");
const { composeMessageWithAttachedFiles } = await jiti.import("./chat-attachments.ts");

const message = (...files) => composeMessageWithAttachedFiles("summarise these", files.map(([name, text]) => ({ name, text })));

test("text files attached to a message are kept in the chat folder's attachments directory", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "pi-chat-attach-"));
  const written = saveAttachedFilesToFolder(folder, message(["notes.md", "# hello"], ["data.csv", "a,b\n1,2"]));
  assert.equal(written.length, 2);
  assert.equal(await readFile(path.join(folder, "attachments", "notes.md"), "utf8"), "# hello");
  assert.equal(await readFile(path.join(folder, "attachments", "data.csv"), "utf8"), "a,b\n1,2");
});

test("the same file attached twice is saved once, a different one with the same name keeps both", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "pi-chat-attach-"));
  saveAttachedFilesToFolder(folder, message(["notes.md", "one"]));
  assert.deepEqual(saveAttachedFilesToFolder(folder, message(["notes.md", "one"])), []);
  assert.equal(saveAttachedFilesToFolder(folder, message(["notes.md", "two"])).length, 1);
  assert.deepEqual((await readdir(path.join(folder, "attachments"))).sort(), ["notes (1).md", "notes.md"]);
});

test("a name cannot leave the directory or become a program", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "pi-chat-attach-"));
  saveAttachedFilesToFolder(folder, message(["../../escape.md", "x"], ["run.command", "echo hi"], [".hidden", "h"]));
  const names = (await readdir(path.join(folder, "attachments"))).sort();
  assert.ok(names.every((name) => !name.includes("/") && !name.startsWith(".")), names.join(","));
  assert.ok(!names.includes("run.command"), "a program extension is stored as text");
  assert.equal((await readdir(folder)).includes("escape.md"), false);
});

test("a message without attachments writes nothing", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "pi-chat-attach-"));
  assert.deepEqual(saveAttachedFilesToFolder(folder, "just text"), []);
  assert.deepEqual(await readdir(folder), []);
});
