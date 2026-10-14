import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/native-theme.css", import.meta.url), "utf8");

// Upstream caps an inline Mermaid preview at min(600px, 60dvh) for the chat
// column (app/globals.css). The artifact panel reuses MermaidBlock but scrolls
// by itself, so that cap cut tall diagrams off with free space below them.
test("the artifact panel lifts upstream's Mermaid preview height cap", () => {
  assert.match(css, /\.artifact-panel-body \.mermaid-preview-button\s*\{\s*max-height:\s*none;/);
});

// Mermaid sizes its SVG `width: 100%` capped by an inline `max-width: <natural>px`,
// so narrow diagrams stayed small and wide ones shrank until unreadable. The
// panel fits them instead, within bounds; the !important is what beats the
// inline max-width.
test("the artifact panel fits Mermaid diagrams to its width within bounds", () => {
  const rule = /\.mermaid-fit svg\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /max-width:\s*calc\(var\(--mermaid-natural-width[^)]*\)\s*\*\s*1\.75\)\s*!important/);
  assert.match(rule, /min-width:\s*calc\(var\(--mermaid-natural-width[^)]*\)\s*\*\s*0\.6\)\s*!important/);
});

test("the panel opts its Mermaid diagrams into fit mode", async () => {
  const source = await readFile(new URL("./ArtifactPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /<MermaidBlock[^>]*defaultPreview fit/);
});
