// The file viewer's line numbers (and the diff's +/- markers) are separate
// spans with `user-select: none`. WebKit, which the desktop app runs on, still
// puts that text on the clipboard when a selection spans several lines, so a
// copy came out as "12  const x = 1;". Build the plain text from the line
// contents instead.

const CODE_LINE_SELECTOR = ".file-source-line, .file-diff-line";
const CODE_LINE_CONTENT_SELECTOR = ".file-source-line-content, .file-diff-line-content";

interface TextLike {
  textContent: string | null;
}

interface CodeLineLike extends TextLike {
  querySelector(selector: string): TextLike | null;
}

interface CopiedFragmentLike extends CodeLineLike {
  querySelectorAll(selector: string): ArrayLike<CodeLineLike>;
}

function lineText(content: TextLike | null): string {
  const text = (content?.textContent ?? "").replace(/\r?\n$/, "");
  // Empty diff lines render a no-break space so the row keeps its height.
  return text === "\u00a0" ? "" : text;
}

/**
 * Plain text for a copied range of the source or diff view, without line
 * numbers or diff markers. Returns null when the selection holds no code line
 * gutter, leaving the browser's own copy in place.
 */
export function copiedCodeText(fragment: CopiedFragmentLike): string | null {
  const lines = Array.from(fragment.querySelectorAll(CODE_LINE_SELECTOR));
  if (lines.length > 0) {
    return lines.map((line) => lineText(line.querySelector(CODE_LINE_CONTENT_SELECTOR))).join("\n");
  }
  // A selection inside one line clones that line's children, not the line:
  // the gutter span and the (partial) content span.
  const content = fragment.querySelector(CODE_LINE_CONTENT_SELECTOR);
  return content ? lineText(content) : null;
}
