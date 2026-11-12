import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { toggleId } = await jiti.import("./chat-groups.ts");

test("toggleId returns a new set and flips membership", () => {
  const base = new Set(["a"]);
  assert.deepEqual([...toggleId(base, "b")], ["a", "b"]);
  assert.deepEqual([...toggleId(base, "a")], []);
  assert.deepEqual([...base], ["a"]);
});

test("pinnedFirst puts pinned items first and keeps each part's order (S2)", async () => {
  const { pinnedFirst } = await import("./chat-groups.ts");
  assert.deepEqual(pinnedFirst(["a", "b", "c", "d"], (item) => item === "c" || item === "a"), ["a", "c", "b", "d"]);
  assert.deepEqual(pinnedFirst([], () => true), []);
});
