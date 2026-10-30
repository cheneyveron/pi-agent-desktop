/**
 * In-page text search over a rendered DOM subtree, used by the file viewer's
 * Ctrl/Cmd+F bar. Matches are painted with the CSS Custom Highlight API so the
 * React-owned DOM (syntax-highlight spans, markdown) is never mutated.
 *
 * Text is indexed per visual block: the nearest non-inline ancestor of each text
 * node. A match therefore never spans two source lines or two paragraphs, but it
 * does span the token spans inside one line. Blocks that cannot be selected
 * (`user-select: none`, i.e. the line-number gutter) are skipped.
 */

export const FIND_HIGHLIGHT_NAME = "file-find";
export const FIND_CURRENT_HIGHLIGHT_NAME = "file-find-current";
export const FIND_MAX_MATCHES = 5_000;

interface TextSlice {
  node: Text;
  /** Offset of this node's first character inside its block's joined text. */
  start: number;
}

interface TextBlock {
  text: string;
  slices: TextSlice[];
}

export interface DomTextIndex {
  blocks: TextBlock[];
}

export function supportsDomFind(): boolean {
  return typeof CSS !== "undefined"
    && "highlights" in CSS
    && typeof Highlight !== "undefined"
    && typeof document !== "undefined"
    && typeof document.createTreeWalker === "function";
}

interface BlockInfo {
  element: Element;
  selectable: boolean;
}

export function buildDomTextIndex(root: HTMLElement): DomTextIndex {
  const blockCache = new WeakMap<Element, BlockInfo>();
  const resolveBlock = (start: Element): BlockInfo => {
    const trail: Element[] = [];
    let current: Element | null = start;
    let found: BlockInfo | null = null;
    while (current) {
      const cached = blockCache.get(current);
      if (cached) {
        found = cached;
        break;
      }
      trail.push(current);
      const style = getComputedStyle(current);
      if (style.display !== "inline" && style.display !== "contents") {
        const visible = typeof current.checkVisibility !== "function" || current.checkVisibility();
        found = { element: current, selectable: visible && style.userSelect !== "none" };
        break;
      }
      if (current === root) break;
      current = current.parentElement;
    }
    const info = found ?? { element: root, selectable: true };
    for (const element of trail) blockCache.set(element, info);
    return info;
  };

  const blocks = new Map<Element, TextBlock>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, noscript, [hidden], [aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const info = resolveBlock(textNode.parentElement!);
    if (!info.selectable) continue;
    let block = blocks.get(info.element);
    if (!block) {
      block = { text: "", slices: [] };
      blocks.set(info.element, block);
    }
    block.slices.push({ node: textNode, start: block.text.length });
    block.text += textNode.nodeValue ?? "";
  }

  return { blocks: [...blocks.values()] };
}

export interface FindResult {
  ranges: Range[];
  /** True when the match list stopped at FIND_MAX_MATCHES. */
  capped: boolean;
}

function locate(block: TextBlock, offset: number, preferEnd: boolean): { node: Text; offset: number } {
  const { slices } = block;
  let low = 0;
  let high = slices.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (slices[mid].start <= offset) low = mid;
    else high = mid - 1;
  }
  let slice = slices[low];
  // A range end that sits exactly on a node boundary belongs to the earlier node.
  if (preferEnd && offset === slice.start && low > 0) slice = slices[low - 1];
  return { node: slice.node, offset: offset - slice.start };
}

export function findInIndex(index: DomTextIndex, query: string, caseSensitive: boolean): FindResult {
  const ranges: Range[] = [];
  if (!query) return { ranges, capped: false };
  const needle = caseSensitive ? query : query.toLowerCase();

  for (const block of index.blocks) {
    const haystack = caseSensitive ? block.text : block.text.toLowerCase();
    // toLowerCase can change string length (e.g. "İ"); skip the rare block rather than mis-map offsets.
    if (haystack.length !== block.text.length) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const start = locate(block, at, false);
      const end = locate(block, at + needle.length, true);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      ranges.push(range);
      if (ranges.length >= FIND_MAX_MATCHES) return { ranges, capped: true };
      from = at + needle.length;
    }
  }
  return { ranges, capped: false };
}

export function paintFindHighlights(ranges: Range[], currentIndex: number): void {
  if (!supportsDomFind()) return;
  CSS.highlights.delete(FIND_HIGHLIGHT_NAME);
  CSS.highlights.delete(FIND_CURRENT_HIGHLIGHT_NAME);
  if (ranges.length === 0) return;
  CSS.highlights.set(FIND_HIGHLIGHT_NAME, new Highlight(...ranges));
  const current = ranges[currentIndex];
  if (current) CSS.highlights.set(FIND_CURRENT_HIGHLIGHT_NAME, new Highlight(current));
}

export function clearFindHighlights(): void {
  if (!supportsDomFind()) return;
  CSS.highlights.delete(FIND_HIGHLIGHT_NAME);
  CSS.highlights.delete(FIND_CURRENT_HIGHLIGHT_NAME);
}

/** Scroll `container` so `range` sits roughly mid-viewport, only when it is not already comfortably visible. */
export function scrollRangeIntoView(container: HTMLElement, range: Range, retry = true): void {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // Text inside `content-visibility: auto` content the browser has not laid
    // out yet (the file viewer's off-screen code blocks) has no box. Centre the
    // nearest ancestor that has one; once on screen it is laid out, and the next
    // frame can place the match itself.
    let element = range.startContainer.parentElement;
    while (element && element !== container && element.getBoundingClientRect().height === 0) {
      element = element.parentElement;
    }
    if (!retry || !element || element === container) return;
    const target = element.getBoundingClientRect();
    const view = container.getBoundingClientRect();
    container.scrollTop += target.top - view.top - view.height / 2 + target.height / 2;
    requestAnimationFrame(() => scrollRangeIntoView(container, range, false));
    return;
  }
  const box = container.getBoundingClientRect();
  const marginY = Math.min(48, box.height / 4);
  const marginX = Math.min(48, box.width / 4);
  if (rect.top < box.top + marginY || rect.bottom > box.bottom - marginY) {
    container.scrollTop += rect.top - box.top - box.height / 2 + rect.height / 2;
  }
  if (rect.left < box.left + marginX || rect.right > box.right - marginX) {
    container.scrollLeft += rect.left - box.left - box.width / 2 + rect.width / 2;
  }
}
