"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { BLOCK_ROWS, blockRangeFor, estimateBlockHeights, type BlockRange } from "@/lib/virtual-blocks";

/** Height of one unwrapped code row in the file viewer: 13px × 1.6. */
export const CODE_ROW_HEIGHT = 20.8;

/** Rendered distance beyond the visible area, above and below. */
const OVERSCAN_PX = 1_200;

const defaultRowHeight = () => CODE_ROW_HEIGHT;

interface VirtualCodeListProps {
  /** The scrolling ancestor. */
  scrollRef: RefObject<HTMLElement | null>;
  rowCount: number;
  /** Stable while the rows are unchanged: a new function re-renders and re-measures every block. */
  renderRow: (index: number) => ReactNode;
  /** Height of a row before its block has been measured. */
  estimateRowHeight?: (index: number) => number;
  /**
   * Render every block, e.g. while the find bar searches the DOM. Off-screen
   * blocks then use `content-visibility: auto` so the browser skips their layout.
   */
  renderAll?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface CodeBlockProps {
  index: number;
  renderRow: (index: number) => ReactNode;
  rowCount: number;
  observe: (element: HTMLElement) => () => void;
  /** Height for `contain-intrinsic-height` while rendering every block; 0 otherwise. */
  lazyHeight: number;
}

const CodeBlock = memo(function CodeBlock({ index, renderRow, rowCount, observe, lazyHeight }: CodeBlockProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? observe(ref.current) : undefined), [observe]);

  const rows: ReactNode[] = [];
  const end = Math.min(rowCount, (index + 1) * BLOCK_ROWS);
  for (let row = index * BLOCK_ROWS; row < end; row++) rows.push(renderRow(row));

  return (
    <div
      ref={ref}
      data-code-block={index}
      style={lazyHeight > 0 ? { contentVisibility: "auto", containIntrinsicHeight: `auto ${lazyHeight}px` } : undefined}
    >
      {rows}
    </div>
  );
});

function blockOf(list: HTMLElement, node: Node | null): number {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
  const block = element?.closest<HTMLElement>("[data-code-block]");
  return block && list.contains(block) ? Number(block.dataset.codeBlock) : -1;
}

/**
 * Renders a long list of code rows, mounting only the blocks of rows near the
 * visible part of `scrollRef`. The rest of the list is spacer height, so a file
 * of any length costs about the same DOM as one screenful. Block heights start
 * as estimates and are replaced by measured ones, which keeps wrapped rows
 * (variable height) in place. Blocks holding the ends of the current selection
 * stay mounted so the selection survives scrolling.
 */
export function VirtualCodeList({
  scrollRef,
  rowCount,
  renderRow,
  estimateRowHeight = defaultRowHeight,
  renderAll = false,
  className,
  style,
}: VirtualCodeListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const blockCount = Math.ceil(rowCount / BLOCK_ROWS);
  const estimates = useMemo(
    () => estimateBlockHeights(rowCount, estimateRowHeight),
    [rowCount, estimateRowHeight],
  );

  // Measured block heights belong to the rows they were measured with.
  const measuredRef = useRef<{ rows: unknown; heights: Map<number, number> }>({ rows: null, heights: new Map() });
  if (measuredRef.current.rows !== renderRow) {
    measuredRef.current = { rows: renderRow, heights: new Map() };
  }
  const [measuredVersion, setMeasuredVersion] = useState(0);
  const heightOf = useCallback(
    (block: number) => measuredRef.current.heights.get(block) ?? estimates[block] ?? 0,
    [estimates],
  );
  const heightOfRef = useRef(heightOf);
  heightOfRef.current = heightOf;

  const [range, setRange] = useState<BlockRange>({ first: 0, last: 0 });
  const [pinned, setPinned] = useState<number[]>([]);

  const updateRange = useCallback(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const top = scroller.scrollTop - listTop;
    const next = blockRangeFor(blockCount, heightOfRef.current, top - OVERSCAN_PX, top + scroller.clientHeight + OVERSCAN_PX);
    setRange((current) => (current.first === next.first && current.last === next.last ? current : next));
  }, [blockCount, scrollRef]);

  // Not after every render: the viewer re-renders with the app (e.g. while a
  // reply streams), and reading layout there would force it each time.
  useLayoutEffect(() => {
    updateRange();
  }, [updateRange, estimates, renderRow, measuredVersion, renderAll]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", updateRange, { passive: true });
    const resizeObserver = new ResizeObserver(updateRange);
    resizeObserver.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", updateRange);
      resizeObserver.disconnect();
    };
  }, [scrollRef, updateRange]);

  useEffect(() => {
    const updatePinned = () => {
      const list = listRef.current;
      const selection = window.getSelection();
      if (!list || !selection || selection.rangeCount === 0) {
        setPinned((current) => (current.length === 0 ? current : []));
        return;
      }
      const next = [...new Set([blockOf(list, selection.anchorNode), blockOf(list, selection.focusNode)])]
        .filter((block) => block >= 0)
        .sort((a, b) => a - b);
      setPinned((current) => (
        current.length === next.length && current.every((block, index) => block === next[index]) ? current : next
      ));
    };
    document.addEventListener("selectionchange", updatePinned);
    return () => document.removeEventListener("selectionchange", updatePinned);
  }, []);

  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  useEffect(() => () => resizeObserverRef.current?.disconnect(), []);
  const observe = useCallback((element: HTMLElement) => {
    if (!resizeObserverRef.current) {
      resizeObserverRef.current = new ResizeObserver((entries) => {
        const scroller = scrollRef.current;
        const viewportTop = scroller?.getBoundingClientRect().top ?? 0;
        const heights = measuredRef.current.heights;
        let shiftAbove = 0;
        let changed = false;
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          if (!target.isConnected) continue;
          const block = Number(target.dataset.codeBlock);
          const rect = target.getBoundingClientRect();
          const previous = heightOfRef.current(block);
          if (Math.abs(rect.height - previous) < 0.5) continue;
          heights.set(block, rect.height);
          changed = true;
          // The list does its own scroll anchoring (overflow-anchor: none): a
          // block above the viewport that turned out taller or shorter than
          // its estimate must not move the rows being read.
          if (rect.bottom <= viewportTop) shiftAbove += rect.height - previous;
        }
        if (scroller && shiftAbove !== 0) scroller.scrollTop += shiftAbove;
        if (changed) setMeasuredVersion((version) => version + 1);
      });
    }
    const observer = resizeObserverRef.current;
    observer.observe(element);
    return () => observer.unobserve(element);
  }, [scrollRef]);

  const children: ReactNode[] = [];
  let gap = 0;
  for (let block = 0; block < blockCount; block++) {
    const mounted = renderAll || (block >= range.first && block <= range.last) || pinned.includes(block);
    if (!mounted) {
      gap += heightOf(block);
      continue;
    }
    if (gap > 0) children.push(<div key={`gap-${block}`} aria-hidden="true" style={{ height: gap }} />);
    gap = 0;
    children.push(
      <CodeBlock
        key={block}
        index={block}
        renderRow={renderRow}
        rowCount={rowCount}
        observe={observe}
        lazyHeight={renderAll ? heightOf(block) : 0}
      />,
    );
  }
  if (gap > 0) children.push(<div key="gap-end" aria-hidden="true" style={{ height: gap }} />);

  return (
    <div ref={listRef} className={className} style={{ ...style, overflowAnchor: "none" }}>
      {children}
    </div>
  );
}
