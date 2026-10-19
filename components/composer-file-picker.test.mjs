import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { englishMessages } = await jiti.import("../lib/i18n/locale-plugins.ts");

const chatInputSource = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const chatWindowSource = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("the desktop composer picker routes all picked files through ChatWindow", () => {
  assert.match(chatInputSource, /onAttachFiles\?: \(files: File\[\]\) => void;/);
  assert.match(chatInputSource, /accept=\{chatOnly \|\| !onAttachFiles \? "image\/\*" : undefined\}/);
  assert.match(chatInputSource, /if \(onAttachFiles\) onAttachFiles\(files\);/);
  assert.match(chatWindowSource, /<ChatInput[\s\S]*?onAttachFiles=\{onAttachFiles\}/);
});

test("plus picks split images from project imports in ChatWindow", () => {
  const source = chatWindowSource.slice(
    chatWindowSource.indexOf("const onAttachFiles = useCallback"),
    chatWindowSource.indexOf("const { isDragOver, handleDragEnter", chatWindowSource.indexOf("const onAttachFiles = useCallback")),
  );
  assert.match(source, /partitionChatDroppedFiles\(files\)/);
  assert.match(source, /chatInputRef\?\.current\?\.addImages\(images\)/);
  assert.match(source, /importProjectFiles\(projectFiles\)/);
});

test("the add-files label is available in every locale", () => {
  assert.equal(englishMessages["chat.attachFiles"], "Add files");
  assert.equal(englishMessages["chat.attachImage"], "Attach image");
  assert.match(chatInputSource, /t\(chatOnly \|\| !onAttachFiles \? "chat\.attachImage" : "chat\.attachFiles"\)/);
});

test("chat-only composers keep the picker and label images-only", () => {
  assert.match(chatInputSource, /accept=\{chatOnly \|\| !onAttachFiles \? "image\/\*" : undefined\}/);
  assert.match(
    chatInputSource,
    /title=\{t\(chatOnly \|\| !onAttachFiles \? "chat\.attachImage" : "chat\.attachFiles"\)\}/,
  );
  assert.match(
    chatInputSource,
    /aria-label=\{t\(chatOnly \|\| !onAttachFiles \? "chat\.attachImage" : "chat\.attachFiles"\)\}/,
  );
});
