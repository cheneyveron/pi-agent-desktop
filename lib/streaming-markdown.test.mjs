import assert from "node:assert/strict";
import test from "node:test";
import { needsWholeMarkdownDocument, streamingMarkdownInterval } from "./streaming-markdown.ts";

test("ordinary prose, lists, tables and code can use the streaming engine", () => {
  for (const source of [
    "中文 **回复**\n\nAnother paragraph",
    "- first\n\n  continued\n- second",
    "| A | B |\n| - | - |\n| 1 | 2 |",
    "```js\nconst answer = 42;\n```",
    "inline $x + y$ and a $20 price",
    "[file](src/main.ts) and ![chart](image.png)",
  ]) assert.equal(needsWholeMarkdownDocument(source), false, source);
});

test("document-wide references, HTML, frontmatter and display math stay together", () => {
  for (const source of [
    "[reference][doc]\n\n[doc]: https://example.com",
    "Text[^1]\n\n[^1]: Footnote",
    "---\ntitle: hidden\n---\n\nBody",
    "Before\n\n$$\nx = y\n$$\n\nAfter",
    "- formula\n  $$\nx = y\n  $$",
    "> \\[\nx = y\n\\]",
    "<div>\n\n**nested**\n\n</div>",
    "Before <kbd>Ctrl</kbd>",
    "Before <script",
  ]) assert.equal(needsWholeMarkdownDocument(source), true, source);
});

test("preprocessing cadence is bounded while long streams grow", () => {
  assert.equal(streamingMarkdownInterval(""), 48);
  assert.equal(streamingMarkdownInterval("x".repeat(512)), 49);
  assert.equal(streamingMarkdownInterval("x".repeat(100_000)), 96);
});
