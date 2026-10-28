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
