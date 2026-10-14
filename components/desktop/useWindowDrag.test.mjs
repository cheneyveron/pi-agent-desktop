import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * Tauri's native drag-region listener only checks `event.target` itself, not
 * its ancestors, so a click on a child nested inside a `data-tauri-drag-region`
 * container silently fails to drag the window. `shouldStartDrag` re-derives
 * the same decision with `closest()` starting from whatever element was
 * actually clicked. These fakes implement just `closest()` — enough to drive
 * the decision without a real DOM.
 */

const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const jiti = createJiti(import.meta.url, { alias: { "@": rootDir } });
const { shouldStartDrag } = await jiti.import("./useWindowDrag.ts");

// Builds a fake element whose `closest()` reports which of the given
// selectors it (or an ancestor) matches — mirroring what a real click target
// nested inside a drag region would report.
function fakeTarget(matchedSelectors) {
  return {
    closest(selector) {
      return matchedSelectors.includes(selector) ? {} : null;
    },
  };
}

test("starts a drag when the clicked element (or an ancestor) is the drag region", () => {
  // closest() matches the element itself or a nested child equally — that's
  // the fix: Tauri's own check only matched event.target directly.
  assert.equal(shouldStartDrag(fakeTarget(["[data-tauri-drag-region]"])), true);
});

test("does not start a drag outside any drag region", () => {
  assert.equal(shouldStartDrag(fakeTarget([])), false);
});

test("does not start a drag on an interactive descendant inside the region", () => {
  const noDragSelector =
    'button, a, input, textarea, select, [role="button"], [role="tab"], [contenteditable="true"], [data-no-drag]';
  assert.equal(
    shouldStartDrag(fakeTarget(["[data-tauri-drag-region]", noDragSelector])),
    false,
  );
});
