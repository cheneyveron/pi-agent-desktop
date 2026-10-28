import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { mergePinnedSessionIds, splitPinnedFamilies } = await jiti.import("./pinned-sessions.ts");

const family = (id, modified) => ({ root: { id }, subagents: [], latestModified: modified });

test("pinned families are split out, and both halves are ordered by recency", () => {
  const families = [
    family("old", "2026-09-01T00:00:00Z"),
    family("new", "2026-10-19T00:00:00Z"),
    family("pinned-old", "2026-08-01T00:00:00Z"),
    family("pinned-new", "2026-10-01T00:00:00Z"),
  ];
  const { pinned, rest } = splitPinnedFamilies(families, new Set(["pinned-old", "pinned-new"]));
  assert.deepEqual(pinned.map((f) => f.root.id), ["pinned-new", "pinned-old"]);
  assert.deepEqual(rest.map((f) => f.root.id), ["new", "old"]);
  // The input is left alone.
  assert.deepEqual(families.map((f) => f.root.id), ["old", "new", "pinned-old", "pinned-new"]);
});

test("without pins everything is the rest, by recency", () => {
  const { pinned, rest } = splitPinnedFamilies([family("a", "2026-01-01T00:00:00Z"), family("b", "2026-02-01T00:00:00Z")], new Set());
  assert.deepEqual(pinned, []);
  assert.deepEqual(rest.map((f) => f.root.id), ["b", "a"]);
});

test("legacy chat pins are folded in only until the session-wide key exists", () => {
  // First read on an upgraded build: the chat pins become session pins.
  let result = mergePinnedSessionIds(null, ["chat-1", 7, "chat-2"]);
  assert.deepEqual([...result.ids], ["chat-1", "chat-2"]);
  assert.equal(result.migrated, true);
  // Later reads trust the new key alone, so an unpinned chat stays unpinned.
  result = mergePinnedSessionIds(["s-1"], ["chat-1"]);
  assert.deepEqual([...result.ids], ["s-1"]);
  assert.equal(result.migrated, true);
  result = mergePinnedSessionIds([], null);
  assert.deepEqual([...result.ids], []);
  assert.equal(result.migrated, false);
  // Nothing stored anywhere.
  result = mergePinnedSessionIds(null, null);
  assert.deepEqual([...result.ids], []);
  assert.equal(result.migrated, false);
});
