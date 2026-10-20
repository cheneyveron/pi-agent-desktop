import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { keepDocumentTitle, normalizeDocumentTitle } = await jiti.import("./document-title.ts");

test("normalizeDocumentTitle matches what the browser reads back", () => {
  assert.equal(normalizeDocumentTitle("调研  手机app - Pi Agent"), "调研 手机app - Pi Agent");
  assert.equal(normalizeDocumentTitle("  a\n\tb\r\nc  "), "a b c");
  assert.equal(normalizeDocumentTitle("plain"), "plain");
});

/** A document whose title behaves like the real one and whose head observer fires on every write. */
function fakeDocument() {
  const callbacks = [];
  let stored = "";
  let writes = 0;
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { callbacks.push(this.callback); }
    disconnect() { callbacks.splice(callbacks.indexOf(this.callback), 1); }
  };
  const doc = {
    head: {},
    get title() { return stored; },
    set title(value) {
      writes += 1;
      if (writes > 50) throw new Error("title rewritten in a loop");
      stored = normalizeDocumentTitle(String(value));
      // The write itself mutates <head>, which wakes the observer.
      for (const callback of [...callbacks]) callback();
    },
  };
  return { doc, writes: () => writes, mutateHead: () => callbacks.forEach((callback) => callback()) };
}

test("a title with a double space settles after one write instead of looping", () => {
  const { doc, writes, mutateHead } = fakeDocument();
  const stop = keepDocumentTitle(doc, "调研  手机app - Pi Agent");
  assert.equal(doc.title, "调研 手机app - Pi Agent");
  const afterSetup = writes();
  // Opening Settings changes <head>; that must not rewrite the title again.
  mutateHead();
  mutateHead();
  assert.equal(writes(), afterSetup);
  stop();
});

test("an outside rewrite of the title is put back once", () => {
  const { doc, writes } = fakeDocument();
  const stop = keepDocumentTitle(doc, "Chat - Pi Agent");
  const afterSetup = writes();
  doc.title = "Something else";
  assert.equal(doc.title, "Chat - Pi Agent");
  assert.equal(writes(), afterSetup + 2);
  stop();
});
