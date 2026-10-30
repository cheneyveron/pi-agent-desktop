// Syntax highlighting for the file viewer, split into per-line token lists so
// the viewer can render only the lines on screen.
//
// react-syntax-highlighter's own line splitting splices its flat token array
// once per multi-line token, which is quadratic: a 1 MB file took over a second.
// Tokenize with refractor and split the tree in one linear pass instead. This is
// the instance PrismLight registers its languages in: callers import
// lib/syntax-highlighting.ts so the languages are there.

import { refractor } from "refractor/core";

/** Above this size the viewer shows plain text: tokenizing costs ~0.3 s per MB. */
export const HIGHLIGHT_MAX_CHARS = 1_000_000;

export type CodeToken =
  | { type: "text"; value: string }
  | {
      type: "element";
      tagName: "span";
      properties: { className: string[] };
      children: [{ type: "text"; value: string }];
    };

export type CodeLine = CodeToken[];

interface TreeNode {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: TreeNode[];
}

function classNamesOf(node: TreeNode): string[] {
  const className = node.properties?.className;
  if (Array.isArray(className)) return className.map(String);
  return typeof className === "string" ? className.split(" ") : [];
}

/**
 * Highlighted tokens for each line of `code` (lines split on "\n", like
 * `code.split("\n")`), or null when the language is unknown or the text too
 * large to highlight.
 */
export function highlightCodeLines(code: string, language: string): CodeLine[] | null {
  if (!language || language === "text" || language === "plaintext") return null;
  if (code.length > HIGHLIGHT_MAX_CHARS) return null;

  let tree: { children: TreeNode[] };
  try {
    tree = refractor.highlight(code, language) as unknown as { children: TreeNode[] };
  } catch {
    // Unregistered language.
    return null;
  }

  const lines: CodeLine[] = [[]];
  const pushText = (value: string, classNames: string[]) => {
    const parts = value.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (!part) return;
      lines[lines.length - 1].push(classNames.length === 0
        ? { type: "text", value: part }
        : {
            type: "element",
            tagName: "span",
            properties: { className: classNames },
            children: [{ type: "text", value: part }],
          });
    });
  };
  const visit = (nodes: TreeNode[], classNames: string[]) => {
    for (const node of nodes) {
      if (node.type === "text") pushText(node.value ?? "", classNames);
      else if (node.type === "element" && node.children) {
        visit(node.children, [...classNames, ...classNamesOf(node)]);
      }
    }
  };
  visit(tree.children, []);
  return lines;
}
