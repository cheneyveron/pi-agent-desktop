import assert from "node:assert/strict";
import test from "node:test";
import { copiedCodeText } from "./code-copy.ts";

const CONTENT = ".file-source-line-content, .file-diff-line-content";
const LINES = ".file-source-line, .file-diff-line";

// Minimal stand-ins for the cloned DOM fragment of a selection.
const content = (text) => ({ textContent: text });
const line = (number, text) => ({
  textContent: `${number}${text}`,
  querySelector: (selector) => (selector === CONTENT ? content(text) : null),
});
const fragment = ({ lines = [], single = null }) => ({
  textContent: "",
  querySelectorAll: (selector) => (selector === LINES ? lines : []),
  querySelector: (selector) => (selector === CONTENT ? single : null),
});

test("a multi-line copy keeps the code and drops the line numbers", () => {
  const copied = copiedCodeText(fragment({ lines: [line(12, "const x = 1;\n"), line(13, "  return x;\n"), line(14, "}")] }));
  assert.equal(copied, "const x = 1;\n  return x;\n}");
});

test("empty diff rows copy as empty lines, not no-break spaces", () => {
  assert.equal(copiedCodeText(fragment({ lines: [line(1, "a"), line(2, "\u00a0"), line(3, "b")] })), "a\n\nb");
});

test("a selection inside one line drops its number, and plain text is left to the browser", () => {
  assert.equal(copiedCodeText(fragment({ single: content("return x;\n") })), "return x;");
  assert.equal(copiedCodeText(fragment({})), null);
});
