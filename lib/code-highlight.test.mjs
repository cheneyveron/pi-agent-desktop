import assert from "node:assert/strict";
import test from "node:test";
import { refractor } from "refractor/core";
import javascript from "refractor/javascript";
import { HIGHLIGHT_MAX_CHARS, highlightCodeLines } from "./code-highlight.ts";

refractor.register(javascript);

const lineText = (line) => line.map((token) => token.type === "text" ? token.value : token.children[0].value).join("");

test("highlighted lines match the source lines one to one", () => {
  const code = "const a = 1;\n/* one\ntwo */\n\nlet s = `x\ny`;\n";
  const lines = highlightCodeLines(code, "javascript");
  assert.deepEqual(lines.map(lineText), code.split("\n"));
});

test("tokens keep the classes of every enclosing element", () => {
  const [first] = highlightCodeLines("const a = 1;", "javascript");
  const keyword = first.find((token) => token.type === "element" && lineText([token]) === "const");
  assert.deepEqual(keyword.properties.className, ["token", "keyword"]);
  // A comment split over lines keeps its class on every line.
  const lines = highlightCodeLines("/* one\ntwo */", "javascript");
  for (const line of lines) assert.ok(line[0].properties.className.includes("comment"));
});

test("plain text, unknown languages and very large files are not highlighted", () => {
  assert.equal(highlightCodeLines("a", "text"), null);
  assert.equal(highlightCodeLines("a", "no-such-language"), null);
  assert.equal(highlightCodeLines("a".repeat(HIGHLIGHT_MAX_CHARS + 1), "javascript"), null);
});
