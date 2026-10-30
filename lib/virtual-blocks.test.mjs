import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_ROWS, blockRangeFor, estimateBlockHeights } from "./virtual-blocks.ts";

test("block heights sum their rows' estimates", () => {
  const heights = estimateBlockHeights(BLOCK_ROWS * 2 + 5, (row) => (row === 0 ? 30 : 20));
  assert.deepEqual([...heights], [BLOCK_ROWS * 20 + 10, BLOCK_ROWS * 20, 5 * 20]);
  assert.equal(estimateBlockHeights(0, () => 20).length, 0);
});

test("the range covers every block intersecting the window", () => {
  const height = () => 100;
  assert.deepEqual(blockRangeFor(10, height, 0, 50), { first: 0, last: 0 });
  assert.deepEqual(blockRangeFor(10, height, 150, 320), { first: 1, last: 3 });
  // A window edge on a block boundary does not pull in the neighbour.
  assert.deepEqual(blockRangeFor(10, height, 100, 300), { first: 1, last: 2 });
});

test("windows past either end clamp to the list", () => {
  const height = () => 100;
  assert.deepEqual(blockRangeFor(10, height, -500, 50), { first: 0, last: 0 });
  assert.deepEqual(blockRangeFor(10, height, 5_000, 6_000), { first: 9, last: 9 });
  assert.deepEqual(blockRangeFor(0, height, 0, 100), { first: 0, last: -1 });
});
