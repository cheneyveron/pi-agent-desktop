import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("source and diff views mount only the rows near the viewport", () => {
  // Rendering every line of a large file (and re-rendering the diff on every
  // parent render) slowed the whole app; both views go through the virtualized list.
  assert.equal(source.match(/<VirtualCodeList\b/g)?.length, 2);
  assert.match(source, /rowCount=\{sourceLines\.length\}\s+renderRow=\{renderSourceRow\}/);
  assert.match(source, /rowCount=\{rows\.length\}\s+renderRow=\{renderRow\}/);
  // Ctrl/Cmd+F searches the DOM, so the find bar mounts every row while open.
  assert.equal(source.match(/renderAll=\{find\.open\}/g)?.length, 2);
  assert.doesNotMatch(source, /useLightweightSource|SOURCE_HIGHLIGHT_MAX_LINES/);
});

test("large files keep their syntax highlighting", () => {
  // react-syntax-highlighter's line splitter is quadratic; tokens come from
  // lib/code-highlight.ts, computed once per load and not per render.
  assert.doesNotMatch(source, /<SyntaxHighlighter\b/);
  assert.match(source, /const sourceTokens = useMemo\(\s*\(\) => \(showsSource \? highlightCodeLines\(viewerContent, language\) : null\)/);
  assert.match(source, /const diff = useMemo\(\(\) => diffLines\(patch\), \[patch\]\);/);
  assert.match(source, /highlightCodeLines\(diff\.map\(\(line\) => line\.text\)\.join\("\\n"\), language\)/);
});

test("copying several source lines reads the file text, not the rendered rows", () => {
  // Rows scrolled out of the virtualized view are not in the DOM.
  assert.match(source, /copiedSourceText\(contentRef\.current, range, sourceLines\)/);
  assert.match(source, /\?\? copiedCodeText\(range\.cloneContents\(\)\)/);
});

test("markdown preview links carry PDF page fragments", () => {
  assert.match(source, /parsePdfPageFragment/);
  assert.match(source, /onOpenFile\(linkedFile, parsePdfPageFragment\(href\) \?\? undefined\)/);
});
