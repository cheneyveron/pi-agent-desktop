// Block arithmetic for components/VirtualCodeList.tsx. Rows are grouped into
// fixed-size blocks; a block is either rendered or stands in as spacer height.

/** Rows per rendered block. */
export const BLOCK_ROWS = 100;

export interface BlockRange {
  first: number;
  last: number;
}

/**
 * The blocks that intersect [top, bottom), offsets relative to the start of the
 * list. Positions past either end clamp to the first or last block.
 */
export function blockRangeFor(
  blockCount: number,
  heightOf: (block: number) => number,
  top: number,
  bottom: number,
): BlockRange {
  if (blockCount <= 0) return { first: 0, last: -1 };
  let first = -1;
  let last = 0;
  let offset = 0;
  for (let block = 0; block < blockCount; block++) {
    if (offset >= bottom) break;
    const height = heightOf(block);
    if (first === -1 && offset + height > top) first = block;
    last = block;
    offset += height;
  }
  if (first === -1) first = blockCount - 1;
  return { first, last: Math.max(first, last) };
}

/** Estimated height of every block, from per-row estimates. */
export function estimateBlockHeights(
  rowCount: number,
  estimateRowHeight: (row: number) => number,
): Float64Array {
  const heights = new Float64Array(Math.ceil(rowCount / BLOCK_ROWS));
  for (let row = 0; row < rowCount; row++) {
    heights[Math.floor(row / BLOCK_ROWS)] += estimateRowHeight(row);
  }
  return heights;
}
