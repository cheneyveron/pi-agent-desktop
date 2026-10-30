import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { placeMenuWithinViewport, MENU_GAP, MENU_MARGIN } = await jiti.import("./menu-placement.ts");

const viewport = { width: 1000, height: 800 };
const anchor = { top: 100, bottom: 128, right: 260 };

test("a menu with room below opens downward", () => {
  const placed = placeMenuWithinViewport(anchor, { width: 168, height: 200 }, viewport);
  assert.deepEqual(placed, { top: anchor.bottom + MENU_GAP, left: anchor.right - 168 });
});

test("a menu that does not fit below flips above the anchor", () => {
  const nearBottom = { top: 700, bottom: 728, right: 260 };
  const placed = placeMenuWithinViewport(nearBottom, { width: 168, height: 200 }, viewport);
  assert.equal(placed.top, nearBottom.top - MENU_GAP - 200);
  assert.ok(placed.top + 200 <= viewport.height - MENU_MARGIN);
});

test("the menu never leaves the viewport when neither side fits", () => {
  const tall = { width: 168, height: 900 };
  const placed = placeMenuWithinViewport({ top: 380, bottom: 408, right: 260 }, tall, viewport);
  assert.ok(placed.top >= MENU_MARGIN);
  assert.ok(placed.top <= viewport.height - MENU_MARGIN);
});

test("the menu keeps its right edge aligned with the anchor and stays inside the window", () => {
  const aligned = placeMenuWithinViewport({ top: 100, bottom: 128, right: 990 }, { width: 168, height: 100 }, viewport);
  assert.equal(aligned.left, 990 - 168);
  assert.ok(aligned.left + 168 <= viewport.width - MENU_MARGIN);
  const beyond = placeMenuWithinViewport({ top: 100, bottom: 128, right: 1200 }, { width: 168, height: 100 }, viewport);
  assert.equal(beyond.left, viewport.width - 168 - MENU_MARGIN);
  const farLeft = placeMenuWithinViewport({ top: 100, bottom: 128, right: 4 }, { width: 168, height: 100 }, viewport);
  assert.equal(farLeft.left, MENU_MARGIN);
});
