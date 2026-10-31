import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// List thumbnails render history without the user asking, so they must never
// run an artifact's code, and a live frame per row made scrolling drop frames.
// Every thumbnail is an <img> (HTML pages through an SVG foreignObject image,
// with scripts and frames stripped first) or a text excerpt.
test("thumbnails are images, never frames", async () => {
  const source = await readFile(new URL("./ArtifactThumbnail.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<iframe/);
  assert.doesNotMatch(source, /allow-(scripts|same-origin|forms|popups)/);
  assert.match(source, /<img className=\{`artifacts-thumb-image/);
  assert.match(source, /querySelectorAll\("script, noscript, iframe, frame, object, embed, link, base"\)/);
});

// Work waits for scrolling to stop, so dragging the scrollbar only moves pixels.
test("thumbnail work waits for the list to stop scrolling", async () => {
  const source = await readFile(new URL("./ArtifactThumbnail.tsx", import.meta.url), "utf8");
  assert.match(source, /await waitForScrollIdle\(\);/);
});
