import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_FENCE_LANG,
  artifactFileName,
  assistantTexts,
  collectArtifacts,
  decodeArtifactFence,
  encodeArtifactsForMarkdown,
  parseArtifactAttributes,
  splitArtifacts,
  versionIndexOf,
  shouldInlineArtifact,
} from "./artifacts.ts";

const page = "<!DOCTYPE html>\n<html><body>hi</body></html>";
const directive = (attrs, body, lang = "html") => `:::artifact{${attrs}}\n\`\`\`${lang}\n${body}\n\`\`\`\n:::`;

test("parses attributes in any quoting style", () => {
  assert.deepEqual(
    parseArtifactAttributes(`identifier="calc-v1" type='html' title="Tip calculator" extra=bare`),
    { identifier: "calc-v1", type: "html", title: "Tip calculator", extra: "bare" },
  );
});

test("splits text and a complete artifact", () => {
  const segments = splitArtifacts(`Before\n\n${directive('identifier="calc" type="html" title="Calc"', page)}\n\nAfter`);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], { kind: "text", text: "Before\n" });
  assert.deepEqual(segments[1], {
    kind: "artifact",
    block: { identifier: "calc", title: "Calc", type: "html", lang: "html", content: page, complete: true },
  });
  assert.deepEqual(segments[2], { kind: "text", text: "\nAfter" });
});

test("keeps a streaming artifact open and incomplete", () => {
  const [, artifact] = splitArtifacts(`Intro\n:::artifact{identifier="x" type="html" title="X"}\n\`\`\`html\n<!DOCTYPE html>\n<p>part`);
  assert.equal(artifact.block.complete, false);
  assert.equal(artifact.block.content, "<!DOCTYPE html>\n<p>part");

  const [, opened] = splitArtifacts("Intro\n:::artifact{identifier=\"x\" title=\"X\"}");
  assert.equal(opened.block.complete, false);
  assert.equal(opened.block.content, "");
});

test("accepts content without an inner fence", () => {
  const [artifact] = splitArtifacts(':::artifact{identifier="d" type="mermaid" title="Flow"}\ngraph TD\n  A --> B\n:::');
  assert.equal(artifact.block.type, "mermaid");
  assert.equal(artifact.block.content, "graph TD\n  A --> B");
  assert.equal(artifact.block.complete, true);
});

test("infers type and identifier when they are missing", () => {
  const [svg] = splitArtifacts(`:::artifact{title="Blue Box"}\n\`\`\`svg\n<svg/>\n\`\`\`\n:::`);
  assert.equal(svg.block.type, "svg");
  assert.equal(svg.block.identifier, "blue-box");

  const [code] = splitArtifacts(`:::artifact{identifier="script" type="code" title="S"}\n\`\`\`Python\nprint(1)\n\`\`\`\n:::`);
  assert.equal(code.block.type, "code");
  assert.equal(code.block.lang, "python");

  const [mime] = splitArtifacts(`:::artifact{identifier="m" type="text/markdown" title="Doc"}\n\`\`\`\n# Hi\n\`\`\`\n:::`);
  assert.equal(mime.block.type, "markdown");
});

test("ignores directives inside code fences", () => {
  const markdown = "```md\n:::artifact{identifier=\"x\"}\n```\n";
  assert.deepEqual(splitArtifacts(markdown), [{ kind: "text", text: markdown }]);
});

test("survives nested fences inside the content", () => {
  const body = "# Guide\n\n```js\nconsole.log(1)\n```";
  const markdown = `:::artifact{identifier="g" type="markdown" title="Guide"}\n\`\`\`\`markdown\n${body}\n\`\`\`\`\n:::`;
  const [artifact] = splitArtifacts(markdown);
  assert.equal(artifact.block.content, body);

  const encoded = encodeArtifactsForMarkdown(markdown);
  assert.ok(encoded.startsWith(`\`\`\`\`${ARTIFACT_FENCE_LANG}\n`));
  const raw = encoded.split("\n").slice(1, -1).join("\n");
  assert.deepEqual(decodeArtifactFence(raw), artifact.block);
});

test("ends the artifact at the fence followed by :::, not a nested one", () => {
  const body = "# Notes\n\n```js\nconsole.log(1)\n```\n\nMore text";
  const markdown = `:::artifact{identifier="n" type="markdown" title="Notes"}\n\`\`\`markdown\n${body}\n\`\`\`\n:::\n\nAfter`;
  const segments = splitArtifacts(markdown);
  assert.equal(segments[0].block.content, body);
  assert.equal(segments[0].block.complete, true);
  assert.deepEqual(segments[1], { kind: "text", text: "\nAfter" });
});

test("does not run into the next artifact when ::: is missing", () => {
  const markdown = [
    ':::artifact{identifier="a" type="html" title="A"}', "```html", "<p>a</p>", "```", "",
    ':::artifact{identifier="b" type="html" title="B"}', "```html", "<p>b</p>", "```", ":::",
  ].join("\n");
  const artifacts = splitArtifacts(markdown).filter((segment) => segment.kind === "artifact");
  assert.deepEqual(artifacts.map((segment) => [segment.block.identifier, segment.block.content]), [["a", "<p>a</p>"], ["b", "<p>b</p>"]]);
});

test("leaves markdown without artifacts untouched", () => {
  const markdown = "Use `:::` and a ratio 3:2.";
  assert.equal(encodeArtifactsForMarkdown(markdown), markdown);
});

test("rejects fences that are not artifact headers", () => {
  assert.equal(decodeArtifactFence("not json\nbody"), null);
  assert.equal(decodeArtifactFence('{"title":"no id"}\nbody'), null);
});

test("collects versions by identifier in transcript order", () => {
  const texts = [
    directive('identifier="calc" type="html" title="Calc"', "<p>v1</p>"),
    `${directive('identifier="calc" type="html" title="Calc"', "<p>v2</p>")}\n${directive('identifier="logo" type="svg" title="Logo"', "<svg/>", "svg")}`,
  ];
  const entries = collectArtifacts(texts);
  assert.deepEqual(entries.map((entry) => [entry.identifier, entry.versions.length]), [["calc", 2], ["logo", 1]]);
  assert.equal(versionIndexOf(entries[0], { content: "<p>v2</p>", title: "Calc" }), 1);
  assert.equal(versionIndexOf(entries[0], { content: "<p>v3</p>", title: "Calc" }), -1);
});

test("reads artifacts from assistant text blocks only", () => {
  const text = directive('identifier="a" title="A"', page);
  assert.deepEqual(assistantTexts([
    { role: "user", content: text },
    { role: "assistant", content: [{ type: "thinking", thinking: text }, { type: "text", text }, { type: "text", text: "plain" }] },
    { role: "toolResult", content: [{ type: "text", text }] },
  ]), [text]);
});

test("names downloads after the identifier and type", () => {
  assert.equal(artifactFileName("calc", { type: "html", lang: "html" }), "calc.html");
  assert.equal(artifactFileName("flow", { type: "mermaid", lang: "mermaid" }), "flow.mmd");
  assert.equal(artifactFileName("s", { type: "code", lang: "python" }), "s.py");
  assert.equal(artifactFileName("s", { type: "code", lang: "brainfuck" }), "s.txt");
});

test("recognises React artifacts by type or fence", () => {
  const [typed] = splitArtifacts(':::artifact{identifier="c" type="application/vnd.ant.react" title="C"}\n```tsx\nexport default () => <p/>;\n```\n:::');
  assert.equal(typed.block.type, "react");
  assert.equal(typed.block.lang, "tsx");
  const [byFence] = splitArtifacts(':::artifact{identifier="d" title="D"}\n```jsx\nexport default () => <p/>;\n```\n:::');
  assert.equal(byFence.block.type, "react");
  assert.equal(byFence.block.lang, "jsx");
  assert.equal(artifactFileName("d", byFence.block), "d.jsx");
  assert.equal(artifactFileName("c", typed.block), "c.tsx");
});

test("keeps simple artifacts in the message and complex artifacts in the panel", () => {
  assert.equal(shouldInlineArtifact({
    type: "mermaid",
    content: "graph TD\n A --> B",
    complete: true,
  }), true);
  assert.equal(shouldInlineArtifact({
    type: "svg",
    content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    complete: true,
  }), false);
  assert.equal(shouldInlineArtifact({
    type: "html",
    content: "<!DOCTYPE html><html><body><p>Quiet page</p></body></html>",
    complete: true,
  }), true);
  assert.equal(shouldInlineArtifact({
    type: "html",
    content: '<!DOCTYPE html><html><body><script>alert(1)</script></body></html>',
    complete: true,
  }), false);
  assert.equal(shouldInlineArtifact({
    type: "react",
    content: "export default () => <p />;",
    complete: true,
  }), false);
  assert.equal(shouldInlineArtifact({
    type: "mermaid",
    content: "graph TD\n A --> B",
    complete: false,
  }), false);
  assert.equal(shouldInlineArtifact({
    type: "markdown",
    content: "x".repeat(8_001),
    complete: true,
  }), false);
});

test("extends an earlier collection without changing it", () => {
  const base = collectArtifacts([directive('identifier="calc" title="Calc"', "<p>v1</p>")]);
  const snapshot = JSON.stringify(base);
  const entries = collectArtifacts([
    directive('identifier="calc" title="Calc"', "<p>v2</p>"),
    directive('identifier="logo" type="svg" title="Logo"', "<svg></svg>", "svg"),
  ], base);
  assert.equal(JSON.stringify(base), snapshot, "base must not be mutated");
  assert.deepEqual(entries.map((entry) => [entry.identifier, entry.versions.length]), [["calc", 2], ["logo", 1]]);
  assert.equal(collectArtifacts([], base)[0], base[0], "untouched entries keep their identity");
});
