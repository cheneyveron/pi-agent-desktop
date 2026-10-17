// Artifacts: standalone content an assistant message marks for a preview.
//
//   :::artifact{identifier="tip-calculator" type="html" title="Tip calculator"}
//   ```html
//   <!DOCTYPE html>...
//   ```
//   :::
//
// The syntax is LibreChat's container directive. It is parsed here with a
// line scanner rather than remark-directive: that plugin also turns ordinary
// chat text such as `:name` into directives, while this one only ever matches
// a line starting with `:::artifact{`. Outside Pi Web the block still reads as
// a fenced code block between two marker lines.
//
// Versions: every occurrence of an identifier in a session is a new version,
// in transcript order (see collectArtifacts).

import { htmlPreviewHasActiveContent } from "./html-preview.ts";

export type ArtifactType = "html" | "svg" | "react" | "mermaid" | "markdown" | "code";

export interface ArtifactBlock {
  identifier: string;
  title: string;
  type: ArtifactType;
  /** Language of the content, used for highlighting the source view. */
  lang: string;
  content: string;
  /** False while the message is still streaming the block's body. */
  complete: boolean;
}

export type ArtifactSegment =
  | { kind: "text"; text: string }
  | { kind: "artifact"; block: ArtifactBlock };

export interface ArtifactVersion {
  title: string;
  type: ArtifactType;
  lang: string;
  content: string;
  complete: boolean;
}

export interface ArtifactEntry {
  identifier: string;
  versions: ArtifactVersion[];
}

const OPEN_RE = /^ {0,3}:::artifact[ \t]*\{(.*)\}[ \t]*$/;
const CLOSE_RE = /^ {0,3}:::[ \t]*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATTRIBUTE_RE = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;

const TYPE_ALIASES: Record<string, ArtifactType> = {
  html: "html",
  htm: "html",
  "text/html": "html",
  svg: "svg",
  "image/svg+xml": "svg",
  react: "react",
  jsx: "react",
  tsx: "react",
  "application/vnd.react": "react",
  "application/vnd.ant.react": "react",
  mermaid: "mermaid",
  "application/vnd.mermaid": "mermaid",
  "application/vnd.ant.mermaid": "mermaid",
  markdown: "markdown",
  md: "markdown",
  "text/markdown": "markdown",
  code: "code",
  "application/vnd.code": "code",
  "application/vnd.ant.code": "code",
};

const TYPE_LANG: Record<Exclude<ArtifactType, "code" | "react">, string> = {
  html: "html",
  svg: "svg",
  mermaid: "mermaid",
  markdown: "markdown",
};

export function parseArtifactAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE_RE)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function resolveType(declared: string | undefined, fenceLang: string): ArtifactType {
  const byDeclared = declared ? TYPE_ALIASES[declared.trim().toLowerCase()] : undefined;
  if (byDeclared) return byDeclared;
  return TYPE_ALIASES[fenceLang.toLowerCase()] ?? "code";
}

function toBlock(attributes: Record<string, string>, fenceLang: string, content: string, complete: boolean): ArtifactBlock {
  const type = resolveType(attributes.type, fenceLang);
  const title = (attributes.title ?? "").trim() || (attributes.identifier ?? "").trim() || "Artifact";
  const identifier = slugify(attributes.identifier ?? "") || slugify(title) || "artifact";
  const lang = type === "code"
    ? (fenceLang || attributes.language || "text").toLowerCase()
    : type === "react"
      ? (fenceLang.toLowerCase() === "tsx" ? "tsx" : "jsx")
      : TYPE_LANG[type];
  return { identifier, title, type, lang, content, complete };
}

function isClosingFence(line: string, char: string, length: number): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === char && match[1].length >= length);
}

/** Splits markdown into plain text and artifact blocks, in order. */
export function splitArtifacts(markdown: string): ArtifactSegment[] {
  if (!markdown.includes(":::artifact")) return [{ kind: "text", text: markdown }];

  const lines = markdown.split("\n");
  const segments: ArtifactSegment[] = [];
  let text: string[] = [];
  let outerFence: { char: string; length: number } | null = null;
  const flushText = () => {
    if (text.length) segments.push({ kind: "text", text: text.join("\n") });
    text = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (outerFence) {
      if (isClosingFence(line, outerFence.char, outerFence.length)) outerFence = null;
      text.push(line);
      i += 1;
      continue;
    }
    const open = OPEN_RE.exec(line);
    if (!open) {
      const fence = FENCE_OPEN_RE.exec(line);
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        outerFence = { char: fence[1][0], length: fence[1].length };
      }
      text.push(line);
      i += 1;
      continue;
    }

    flushText();
    const attributes = parseArtifactAttributes(open[1]);
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j += 1;
    const fence = j < lines.length ? FENCE_OPEN_RE.exec(lines[j]) : null;

    let content: string;
    let fenceLang = "";
    let complete = false;
    let next: number;
    if (fence) {
      const char = fence[1][0];
      const length = fence[1].length;
      fenceLang = fence[2].trim().split(/\s+/)[0] ?? "";
      // Models often nest a same-length fence inside the artifact (a Markdown
      // document with code samples). The fence that ends the artifact is the
      // one followed by the `:::` line; the first bare fence is only the
      // fallback, for a block without `:::` or one still streaming.
      let firstClose = -1;
      let close = -1;
      let closeMarker = -1;
      for (let k = j + 1; k < lines.length; k += 1) {
        if (OPEN_RE.test(lines[k])) break;
        if (!isClosingFence(lines[k], char, length)) continue;
        if (firstClose === -1) firstClose = k;
        let m = k + 1;
        while (m < lines.length && !lines[m].trim()) m += 1;
        if (m < lines.length && CLOSE_RE.test(lines[m])) {
          close = k;
          closeMarker = m;
          break;
        }
      }
      if (close === -1) close = firstClose;
      complete = close !== -1;
      content = lines.slice(j + 1, complete ? close : lines.length).join("\n");
      next = closeMarker !== -1 ? closeMarker + 1 : complete ? close + 1 : lines.length;
    } else {
      const body: string[] = [];
      let k = i + 1;
      while (k < lines.length && !CLOSE_RE.test(lines[k])) {
        body.push(lines[k]);
        k += 1;
      }
      content = body.join("\n").replace(/^\n+|\n+$/g, "");
      complete = k < lines.length;
      next = complete ? k + 1 : lines.length;
    }

    segments.push({ kind: "artifact", block: toBlock(attributes, fenceLang, content, complete) });
    i = next;
  }
  flushText();
  return segments;
}

export const ARTIFACT_FENCE_LANG = "pi-artifact";

/**
 * Rewrites artifact directives into fenced blocks the markdown renderer hands
 * to its `code` component: the first line is the block's JSON header, the
 * rest its content. The fence is longer than any backtick run inside, so
 * content that contains fences of its own survives.
 */
export function encodeArtifactsForMarkdown(markdown: string): string {
  const segments = splitArtifacts(markdown);
  if (segments.length === 1 && segments[0].kind === "text") return markdown;
  return segments.map((segment) => {
    if (segment.kind === "text") return segment.text;
    const { content, ...header } = segment.block;
    const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return `${fence}${ARTIFACT_FENCE_LANG}\n${JSON.stringify(header)}\n${content}\n${fence}`;
  }).join("\n");
}

export function decodeArtifactFence(raw: string): ArtifactBlock | null {
  const newline = raw.indexOf("\n");
  const headerLine = newline === -1 ? raw : raw.slice(0, newline);
  try {
    const header = JSON.parse(headerLine) as Partial<ArtifactBlock>;
    if (typeof header.identifier !== "string" || typeof header.type !== "string") return null;
    return {
      identifier: header.identifier,
      title: typeof header.title === "string" ? header.title : header.identifier,
      type: header.type as ArtifactType,
      lang: typeof header.lang === "string" ? header.lang : "text",
      complete: header.complete !== false,
      content: newline === -1 ? "" : raw.slice(newline + 1).replace(/\n$/, ""),
    };
  } catch {
    return null;
  }
}

/**
 * Every artifact in the given assistant texts, versions in order of
 * appearance. `base` is an earlier result the texts continue (the finished
 * transcript, while a reply streams); it is never mutated, so it can be
 * memoized and only the streaming text re-parsed on each chunk.
 */
export function collectArtifacts(texts: readonly string[], base: readonly ArtifactEntry[] = []): ArtifactEntry[] {
  const entries = new Map<string, ArtifactEntry>(base.map((entry) => [entry.identifier, entry]));
  const owned = new Set<string>();
  for (const text of texts) {
    for (const segment of splitArtifacts(text)) {
      if (segment.kind !== "artifact") continue;
      const { identifier, ...version } = segment.block;
      let entry = entries.get(identifier);
      if (!entry || !owned.has(identifier)) {
        entry = { identifier, versions: entry ? [...entry.versions] : [] };
        entries.set(identifier, entry);
        owned.add(identifier);
      }
      entry.versions.push(version);
    }
  }
  return [...entries.values()];
}

type MessageLike = { role?: unknown; content?: unknown } | null | undefined;

/** The text blocks of assistant messages, the only place artifacts are read from. */
export function assistantTexts(messages: readonly MessageLike[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    const { content } = message;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.includes(":::artifact")) texts.push(text);
      }
    }
  }
  return texts;
}

export function versionIndexOf(entry: ArtifactEntry | undefined, block: Pick<ArtifactBlock, "content" | "title">): number {
  if (!entry) return -1;
  return entry.versions.findIndex((version) => version.content === block.content && version.title === block.title);
}

/**
 * Artifacts that read as part of the answer stay in the message. Interactive
 * or scripted content goes to the panel: it needs space, and a historical page
 * must not run every time an old conversation opens.
 */
export function shouldInlineArtifact(block: Pick<ArtifactBlock, "type" | "content" | "complete">): boolean {
  if (!block.complete) return false;
  if (block.type === "mermaid") return block.content.length <= 24_000;
  if (block.type === "svg") return block.content.length <= 24_000 && !htmlPreviewHasActiveContent(block.content);
  if (block.type === "markdown") return block.content.length <= 8_000;
  if (block.type !== "html") return false;
  return block.content.length <= 12_000 && !htmlPreviewHasActiveContent(block.content);
}

const CODE_EXTENSIONS: Record<string, string> = {
  javascript: "js", js: "js", typescript: "ts", ts: "ts", tsx: "tsx", jsx: "jsx",
  python: "py", py: "py", json: "json", css: "css", bash: "sh", sh: "sh", shell: "sh",
  go: "go", rust: "rs", rs: "rs", java: "java", c: "c", cpp: "cpp", csharp: "cs",
  ruby: "rb", php: "php", sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml", swift: "swift", kotlin: "kt",
};

export function artifactFileName(identifier: string, version: Pick<ArtifactVersion, "type" | "lang">): string {
  const extension = version.type === "html" ? "html"
    : version.type === "svg" ? "svg"
    : version.type === "react" ? (version.lang === "tsx" ? "tsx" : "jsx")
      : version.type === "mermaid" ? "mmd"
        : version.type === "markdown" ? "md"
          : CODE_EXTENSIONS[version.lang] ?? "txt";
  return `${identifier}.${extension}`;
}
