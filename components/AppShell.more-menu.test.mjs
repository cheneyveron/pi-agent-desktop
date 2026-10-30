import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

// The topbar's More menu must live in a <body> portal: .app-topbar is a
// z-index 90 stacking context and the open file panel (z-index 100) used to
// paint over the inline menu, so every real pointer click hit the panel instead
// of the menu. An "inline menu + panel open" click was unclickable.
test("the More menu is portaled to the body so the open file panel cannot cover it", () => {
  assert.match(source, /topMoreOpen && topMorePos && createPortal\(/);
  assert.match(source, /document\.body/);
  // Fixed positioning is computed from the trigger rect, not the old absolute
  // "calc(100% + 7px) / right: -2px" that only worked inside the topbar.
  assert.match(source, /position: "fixed", zIndex: 700/);
  // The menu measures itself and flips above the trigger when the space below
  // is too small, so its last entries never fall off the window.
  assert.match(source, /useMenuPlacement\(topMoreOpen \? topMoreAnchor : null, topMoreMenuRef\)/);
  assert.match(source, /placedTopMorePos\.top, left: placedTopMorePos\.left/);
  assert.match(source, /setTopMorePos\(\{ top: rect\.bottom \+ 7, right: window\.innerWidth - rect\.right - 2 \}\)/);
});

test("outside-click containment covers both the trigger and the portaled menu", () => {
  assert.match(source, /topMoreRef\.current\?\.contains\(event\.target as Node\)/);
  assert.match(source, /topMoreMenuRef\.current\?\.contains\(event\.target as Node\)/);
});
