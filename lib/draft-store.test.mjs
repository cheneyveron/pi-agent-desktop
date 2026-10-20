import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); },
  },
};

const { clearDraft, getDraft, restoreDraftSubmission, setDraft } = await createJiti(import.meta.url, { tsconfigPaths: true })
  .import("./draft-store.ts");

after(() => {
  delete globalThis.window;
});

test("the persistence cap keeps the most recently edited drafts", async () => {
  for (let index = 0; index < 41; index++) {
    setDraft(`session-${index}`, { value: `draft-${index}`, images: [] });
  }
  setDraft("session-0", { value: "edited-most-recently", images: [] });

  await new Promise((resolve) => setTimeout(resolve, 300));
  const persisted = JSON.parse(storage.get("pi-chat-drafts-v1"));
  assert.equal(Object.keys(persisted).length, 40);
  assert.equal(persisted["session-0"].value, "edited-most-recently");
  assert.equal(persisted["session-1"], undefined);
});

const file = (id, name, text) => ({ id, name, size: text.length, text });

test("attached files belong to the draft they were attached in and never reach storage", async () => {
  setDraft("chat-a", { value: "", images: [], files: [file("f1", "notes.md", "SECRET A")] });
  assert.equal(getDraft("chat-b"), null);
  assert.deepEqual(getDraft("chat-a").files.map((f) => f.name), ["notes.md"]);
  // A draft holding only a file is not empty.
  setDraft("chat-a", { value: "", images: [], files: [file("f1", "notes.md", "SECRET A")] });
  assert.ok(getDraft("chat-a"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const persisted = JSON.parse(storage.get("pi-chat-drafts-v1"));
  assert.equal(JSON.stringify(persisted).includes("SECRET A"), false);
  clearDraft("chat-a");
  assert.equal(getDraft("chat-a"), null);
});

test("a submission restored with file markup comes back as attachments, not text", () => {
  const message = 'look\n\n<attached_file name="a.txt">\nBODY\n</attached_file>';
  const restored = restoreDraftSubmission("chat-r", message);
  assert.equal(restored.value, "look");
  assert.deepEqual(restored.files.map((f) => [f.name, f.text]), [["a.txt", "BODY"]]);
  clearDraft("chat-r");
});
