import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("a chat with its own folder opens files it made; a legacy chat opens none", () => {
  assert.match(source, /const chatFolderCwd = chatOnly && session\?\.chatFolder \? session\.cwd : undefined;/);
  assert.match(source, /const openFile = chatOnly \? \(chatFolderCwd \? onOpenFile : undefined\) : onOpenFile;/);
  // Relative links and the "files written" card resolve against the chat folder, never the hidden legacy cwd.
  assert.match(source, /const messageCwd = chatOnly \? chatFolderCwd : /);
  // Composer behaviour (file import, @ completion) keeps treating a chat as project-less.
  assert.match(source, /const cwd = chatOnly \? undefined : session\?\.cwd \?\? newSessionCwd;/);
});
