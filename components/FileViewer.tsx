"use client";

import { useEffect, useState, useRef, useCallback, useMemo, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createElement as renderSyntaxNode, type createElementProps } from "react-syntax-highlighter";
import { vs, vscDarkPlus } from "@/lib/syntax-highlighting";
import { highlightCodeLines, type CodeLine } from "@/lib/code-highlight";
import { copiedCodeText } from "@/lib/code-copy";
import { CODE_ROW_HEIGHT, VirtualCodeList } from "./VirtualCodeList";
import ReactMarkdown from "react-markdown";
import { useTheme } from "@/hooks/useTheme";
import {
  DOCX_PREVIEW_MAX_BYTES,
  getFileExt,
  isAudioPath,
  isDocumentPreviewPath,
  isImagePath,
  isVideoPath,
} from "@/lib/file-types";
import { encodeFilePathForApi, getFileDirectory, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { parseFrontmatter } from "@/lib/frontmatter";
import { markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins, markdownUrlTransform, normalizeDisplayMath } from "@/lib/markdown";
import { CodeBlock, MermaidBlock } from "./MermaidBlock";
import { FrontmatterCard } from "./FrontmatterCard";
import { FindBar } from "./FindBar";
import { useFindShortcut } from "@/hooks/useFindShortcut";
import { supportsDomFind } from "@/lib/dom-find";
import { parseUnifiedPatch } from "@/lib/patch";
import type { GitFileDiffResponse } from "@/lib/git-types";
import { getTurnFilePatch, subscribeTurnFilePatches } from "@/lib/turn-file-patches";
import { getFileIcon } from "./FileIcons";
import { revealLabelKey } from "@/lib/file-context-menu";
import { useDesktopChrome } from "./desktop/useDesktopChrome";
import { useI18n } from "@/hooks/useI18n";
import {
  resolveInitialFileDisplayMode,
  type FileViewerDisplayMode as DisplayMode,
  type FileViewerState,
} from "@/lib/file-viewer-state";

export type { FileViewerState } from "@/lib/file-viewer-state";

interface Props {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  onOpenFile?: (filePath: string, page?: number) => void;
  onMentionLines?: (relativePath: string, startLine: number, endLine: number) => void;
  /** Insert this file's relative path into the chat input (@ mention). */
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  gitRefreshKey?: number;
  initialDisplayMode?: DisplayMode;
  /** PDF page to open on first render (`#page=N` from a markdown link). */
  initialPage?: number;
  initialState?: FileViewerState;
  onStateChange?: (state: FileViewerState) => void;
  watchEnabled?: boolean;
}

interface FileData {
  content: string;
  language: string;
  size: number;
  nextOffset: number;
  truncated: boolean;
}

const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  source: "Source",
  preview: "Preview",
  diff: "Diff",
};

const FILE_CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  lineHeight: 1.6,
};

const FILE_LINE_NUMBER_STYLE: CSSProperties = {
  width: 48,
  minWidth: 48,
  padding: "0 10px",
  textAlign: "right",
  color: "var(--text-dim)",
  background: "var(--bg-panel)",
  borderRight: "var(--hairline) solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontStyle: "normal",
  fontVariantNumeric: "tabular-nums",
  lineHeight: "20.8px",
  userSelect: "none",
  flexShrink: 0,
  verticalAlign: "top",
};

interface SelectedLineRange {
  startLine: number;
  endLine: number;
}

function MentionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function sourceLineElement(root: HTMLElement, lineNumber: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.file-source-line[data-line-number="${lineNumber}"]`);
}

function closestSourceLine(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.closest<HTMLElement>(".file-source-line[data-line-number]") ?? null;
}

function getSelectedSourceLineRange(root: HTMLElement, selection: Selection | null): SelectedLineRange | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  let startElement = closestSourceLine(range.startContainer);
  let endElement = closestSourceLine(range.endContainer);
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) return null;

  let startLine = Number(startElement.dataset.lineNumber);
  let endLine = Number(endElement.dataset.lineNumber);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;

  if (startLine < endLine) {
    // Browser ranges can start at the end of the preceding line or end at the
    // start of the following line. Exclude either boundary line when none of
    // its source text is actually selected.
    const startContent = startElement.querySelector<HTMLElement>(".file-source-line-content");
    if (startContent?.contains(range.startContainer)) {
      const selectedSuffix = document.createRange();
      selectedSuffix.selectNodeContents(startContent);
      selectedSuffix.setStart(range.startContainer, range.startOffset);
      if (selectedSuffix.toString().length === 0) {
        // Rows live in separately rendered blocks: find the neighbour by number.
        const nextLine = sourceLineElement(root, startLine + 1);
        if (nextLine) {
          startElement = nextLine;
          startLine = Number(startElement.dataset.lineNumber);
        }
      }
    }

    const endContent = endElement.querySelector<HTMLElement>(".file-source-line-content");
    if (endContent?.contains(range.endContainer)) {
      const selectedPrefix = document.createRange();
      selectedPrefix.selectNodeContents(endContent);
      selectedPrefix.setEnd(range.endContainer, range.endOffset);
      if (selectedPrefix.toString().length === 0) {
        const previousLine = sourceLineElement(root, endLine - 1);
        if (previousLine) {
          endElement = previousLine;
          endLine = Number(endElement.dataset.lineNumber);
        }
      }
    }
  }

  if (startLine > endLine) return null;
  return { startLine, endLine };
}

/**
 * Plain text of a selection spanning several source lines, read from the file
 * text rather than the DOM: lines scrolled out of the virtualized view are not
 * rendered, so the DOM range would skip them. Null for other selections.
 */
function copiedSourceText(root: HTMLElement, range: Range, sourceLines: string[]): string | null {
  const startElement = closestSourceLine(range.startContainer);
  const endElement = closestSourceLine(range.endContainer);
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) return null;
  const startLine = Number(startElement.dataset.lineNumber);
  const endLine = Number(endElement.dataset.lineNumber);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine >= endLine) return null;

  // Only part of the first and last line may be selected.
  const startContent = startElement.querySelector(".file-source-line-content");
  let first = sourceLines[startLine - 1] ?? "";
  if (startContent?.contains(range.startContainer)) {
    const suffix = document.createRange();
    suffix.selectNodeContents(startContent);
    suffix.setStart(range.startContainer, range.startOffset);
    first = suffix.toString();
  }
  const endContent = endElement.querySelector(".file-source-line-content");
  let last = sourceLines[endLine - 1] ?? "";
  if (endContent?.contains(range.endContainer)) {
    const prefix = document.createRange();
    prefix.selectNodeContents(endContent);
    prefix.setEnd(range.endContainer, range.endOffset);
    last = prefix.toString();
  }
  return [first, ...sourceLines.slice(startLine, endLine - 1), last].join("\n");
}

type SyntaxStylesheet = typeof vs;

const SOURCE_LINE_STYLE: CSSProperties = { display: "flex", minWidth: "100%" };
const SOURCE_LINE_CONTENT_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflowWrap: "normal",
  whiteSpace: "pre",
};
const WRAPPED_SOURCE_LINE_CONTENT_STYLE: CSSProperties = {
  ...SOURCE_LINE_CONTENT_STYLE,
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
};
/** "... N unchanged lines ..." row of the diff view, before it is measured. */
const DIFF_GAP_ROW_HEIGHT = 23;

function renderCodeTokens(tokens: CodeLine, stylesheet: SyntaxStylesheet): ReactNode[] {
  return tokens.map((node, index) => renderSyntaxNode({
    node: node as createElementProps["node"],
    stylesheet,
    useInlineStyles: true,
    key: index,
  }));
}

/** Text color of untokenized code in a Prism theme. */
function codeBaseColor(stylesheet: SyntaxStylesheet): string | undefined {
  return stylesheet['pre[class*="language-"]']?.color;
}

function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "serve" | "watch",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
    {error && <span role="alert">{error}</span>}
    <button
      type="button"
      disabled={busy}
      title={t("i18n.downloadFile")}
      aria-label={t("i18n.downloadFile")}
      className="file-viewer-icon-button"
      onClick={() => {
        void (async () => {
          setBusy(true);
          setError(null);
          try {
            const { downloadUrlAsFile } = await import("@/lib/desktop-native");
            await downloadUrlAsFile(
              getFileApiUrl(filePath, "download", sourceSessionId),
              getFileName(filePath),
            );
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>
    </>
  );
}

function DesktopPathActions({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const { isDesktop, platform } = useDesktopChrome();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isDesktop) return null;

  const run = async (action: "openPathNative" | "revealItemInDirNative") => {
    setBusy(true);
    setError(null);
    try {
      const native = await import("@/lib/desktop-native");
      await native[action](filePath);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <span role="alert">{error}</span>}
      <button
        type="button"
        disabled={busy}
        title={t("files.openDefaultApp")}
        aria-label={t("files.openDefaultApp")}
        className="file-viewer-icon-button"
        onClick={() => void run("openPathNative")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </button>
      <button
        type="button"
        disabled={busy}
        title={t(revealLabelKey(platform))}
        aria-label={t(revealLabelKey(platform))}
        className="file-viewer-icon-button"
        onClick={() => void run("revealItemInDirNative")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
      </button>
    </>
  );
}

function FileViewerToolbar({
  filePath,
  cwd,
  metadata,
  watching,
  sourceSessionId,
  children,
}: {
  filePath: string;
  cwd?: string;
  metadata?: string | null;
  watching: boolean;
  sourceSessionId?: string | null;
  children?: ReactNode;
}) {
  const relativePath = getRelativeFilePath(filePath, cwd);
  return (
    <div className="file-viewer-toolbar">
      <div className="file-viewer-identity">
        <span className="file-viewer-file-icon" aria-hidden="true">
          {getFileIcon(getFileName(filePath), 15)}
        </span>
        <span className="file-viewer-path" title={filePath}>{relativePath}</span>
        {metadata && <span className="file-viewer-meta" title={metadata}>{metadata}</span>}
      </div>
      <span
        title={watching ? "Live sync active" : "Live sync unavailable"}
        aria-label={watching ? "Live sync active" : "Live sync unavailable"}
        className={`file-viewer-live-status${watching ? " is-live" : ""}`}
      >
        <span className="file-viewer-live-indicator" />
        <span>{watching ? "Live" : "Static"}</span>
      </span>
      <div className="file-viewer-controls">
        {children}
        <DesktopPathActions filePath={filePath} />
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
    </div>
  );
}

type DiffLine = {
  type: "unchanged" | "removed" | "added";
  text: string;
  oldLineNo: number | null;
  newLineNo: number | null;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function diffLines(patch: string): DiffLine[] {
  const files = parseUnifiedPatch(patch);
  if (!files) return [];

  return files.flatMap((file) => file.rows.flatMap((row): DiffLine[] => {
    if (row.type === "hunk") return [];
    if (row.left.type === "context" && row.right.type === "context") {
      return [{
        type: "unchanged",
        text: row.right.text,
        oldLineNo: row.left.lineNo,
        newLineNo: row.right.lineNo,
      }];
    }

    const lines: DiffLine[] = [];
    if (row.left.type === "removed") {
      lines.push({
        type: "removed",
        text: row.left.text,
        oldLineNo: row.left.lineNo,
        newLineNo: null,
      });
    }
    if (row.right.type === "added") {
      lines.push({
        type: "added",
        text: row.right.text,
        oldLineNo: null,
        newLineNo: row.right.lineNo,
      });
    }
    return lines;
  }));
}

type DiffRow =
  | { type: "gap"; count: number }
  | { type: "line"; line: DiffLine; index: number };

/** Diff lines with runs of unchanged lines beyond 3 lines of a change collapsed. */
function diffRows(diff: DiffLine[]): DiffRow[] {
  const CONTEXT = 3;
  const visible = new Uint8Array(diff.length);
  diff.forEach((line, index) => {
    if (line.type === "unchanged") return;
    for (let j = Math.max(0, index - CONTEXT); j <= Math.min(diff.length - 1, index + CONTEXT); j++) visible[j] = 1;
  });

  const rows: DiffRow[] = [];
  for (let index = 0; index < diff.length; index++) {
    if (visible[index]) {
      rows.push({ type: "line", line: diff[index], index });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last?.type === "gap") last.count++;
    else rows.push({ type: "gap", count: 1 });
  }
  return rows;
}

function DiffView({
  patch,
  language,
  stylesheet,
  scrollRef,
  renderAll,
}: {
  patch: string;
  language: string;
  stylesheet: SyntaxStylesheet;
  scrollRef: RefObject<HTMLElement | null>;
  renderAll: boolean;
}) {
  const { t } = useI18n();
  const diff = useMemo(() => diffLines(patch), [patch]);
  const rows = useMemo(() => diffRows(diff), [diff]);
  // Old and new lines are tokenized together, in diff order: a line keeps its
  // place in multi-line constructs as long as both sides agree on them.
  const tokens = useMemo(
    () => highlightCodeLines(diff.map((line) => line.text).join("\n"), language),
    [diff, language],
  );

  const estimateRowHeight = useCallback(
    (index: number) => (rows[index].type === "gap" ? DIFF_GAP_ROW_HEIGHT : CODE_ROW_HEIGHT),
    [rows],
  );
  const renderRow = useCallback((index: number) => {
    const row = rows[index];
    if (row.type === "gap") {
      return (
        <div
          key={`gap-${index}`}
          style={{
            padding: "2px 16px",
            color: "var(--text-dim)",
            background: "var(--bg-panel)",
            fontSize: 11,
            borderTop: "var(--hairline) solid var(--border)",
            borderBottom: "var(--hairline) solid var(--border)",
          }}
        >
          ... {row.count} unchanged lines ...
        </div>
      );
    }

    const { line } = row;
    const bg =
      line.type === "added"
        ? "rgba(0,200,80,0.12)"
        : line.type === "removed"
        ? "rgba(240,60,60,0.14)"
        : "transparent";
    const prefix =
      line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
    const prefixColor =
      line.type === "added" ? "var(--success)" : line.type === "removed" ? "var(--danger)" : "var(--text-dim)";
    const lineTokens = tokens?.[row.index];

    return (
      <div
        key={`line-${index}`}
        className="file-diff-line"
        style={{
          display: "flex",
          minWidth: "100%",
          background: bg,
          borderLeft: line.type === "added"
            ? "3px solid var(--success)"
            : line.type === "removed"
            ? "3px solid var(--danger)"
            : "3px solid transparent",
        }}
      >
        <span
          style={FILE_LINE_NUMBER_STYLE}
        >
          {line.type === "removed" ? line.oldLineNo : line.newLineNo}
        </span>
        <span
          style={{
            minWidth: 16,
            padding: "0 6px",
            color: prefixColor,
            userSelect: "none",
            flexShrink: 0,
            fontWeight: 600,
          }}
        >
          {prefix}
        </span>
        <span
          className="file-diff-line-content"
          style={{
            flexShrink: 0,
            padding: "0 8px 0 0",
            whiteSpace: "pre",
          }}
        >
          {lineTokens && lineTokens.length > 0 ? renderCodeTokens(lineTokens, stylesheet) : line.text || "\u00a0"}
        </span>
      </div>
    );
  }, [rows, stylesheet, tokens]);

  const hasChanges = diff.some((l) => l.type !== "unchanged");
  if (!hasChanges) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {t("i18n.noChanges")}
      </div>
    );
  }

  return (
    <VirtualCodeList
      scrollRef={scrollRef}
      rowCount={rows.length}
      renderRow={renderRow}
      estimateRowHeight={estimateRowHeight}
      renderAll={renderAll}
      className="file-diff-view"
      style={{
        width: "max-content",
        minWidth: "100%",
        color: (tokens && codeBaseColor(stylesheet)) || "var(--text)",
        tabSize: 4,
        ...FILE_CODE_STYLE,
      }}
    />
  );
}

function ImageViewer({ filePath, cwd, sourceSessionId, watchEnabled = true }: Props) {
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const syncRequestRef = useRef(0);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setNaturalSize(null);
    setError(null);
    setWatching(false);
  }, [filePath, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    let active = true;
    const synchronize = () => {
      const requestId = ++syncRequestRef.current;
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!active || requestId !== syncRequestRef.current) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
          setNaturalSize(null);
          setError(null);
          setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (active && requestId === syncRequestRef.current) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      syncRequestRef.current += 1;
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setNaturalSize(null);
      setError(null);
      setBust((b) => b + 1);
    });
    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      active = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, sourceSessionId, watchEnabled]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  const formatSizeStr = size != null ? formatSize(size) : null;
  const metadata = [
    ext || "image",
    naturalSize ? `${naturalSize.w} × ${naturalSize.h}` : null,
    formatSizeStr,
  ].filter(Boolean).join(" · ");

  return (
    <div className="file-viewer-shell">
      <FileViewerToolbar
        filePath={filePath}
        cwd={cwd}
        metadata={metadata}
        watching={watching}
        sourceSessionId={sourceSessionId}
      />
      <div
        className="file-viewer-image-stage"
      >
        {error ? (
          <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError("Failed to load image")}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function AudioViewer({ filePath, cwd, sourceSessionId, watchEnabled = true }: Props) {
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    if (!watchEnabled) return;
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const synchronize = () => {
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
        })
        .catch((nextError) => setError(String(nextError)));
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath, sourceSessionId, watchEnabled]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);
  const metadata = [
    ext || "audio",
    duration != null ? formatDuration(duration) : null,
    size != null ? formatSize(size) : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="file-viewer-shell">
      <FileViewerToolbar
        filePath={filePath}
        cwd={cwd}
        metadata={metadata}
        watching={watching}
        sourceSessionId={sourceSessionId}
      />
      <div
        className="file-viewer-audio-stage"
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("Failed to load audio")}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function VideoViewer({ filePath, cwd, sourceSessionId, watchEnabled = true }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const syncRequestRef = useRef(0);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);
  }, [filePath, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    let active = true;
    const synchronize = () => {
      const requestId = ++syncRequestRef.current;
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!active || requestId !== syncRequestRef.current) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
          setDuration(null);
          setError(null);
          setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (active && requestId === syncRequestRef.current) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      syncRequestRef.current += 1;
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      active = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, sourceSessionId, watchEnabled]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "var(--hairline) solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "video"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
          minHeight: 0,
        }}
      >
        <div style={{ width: "min(960px, 100%)", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
          {error && (
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <video
            key={src}
            controls
            playsInline
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("Failed to load video")}
            style={{ maxWidth: "100%", maxHeight: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function DocumentViewer({ filePath, cwd, sourceSessionId, initialPage, watchEnabled = true }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileExt(filePath);
  const isPdf = ext === "pdf";
  const pageFragment = isPdf && initialPage && initialPage > 0 ? `#page=${initialPage}` : "";
  const previewUrl = isPdf
    ? `${getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined)}${pageFragment}`
    : getFileApiUrl(filePath, "preview", sourceSessionId, bust ? { v: bust } : undefined);

  useEffect(() => {
    if (!watchEnabled) return;
    setBust(0);
    setSize(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const synchronize = () => {
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
        .then((r) => r.json())
        .then((d: { size?: number; error?: string }) => {
          if (d.error) setError(d.error);
          if (typeof d.size === "number") {
            setSize(d.size);
            if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
              setError("DOCX too large for preview (>10MB)");
            }
          }
        })
        .catch((e) => setError(String(e)));
    };
    synchronize();

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
            return;
          }
        }
      } catch { /* ignore */ }
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath, isPdf, sourceSessionId, watchEnabled]);

  const metadata = [
    ext === "docx" ? "DOCX preview" : "PDF",
    size != null ? formatSize(size) : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="file-viewer-shell">
      <FileViewerToolbar
        filePath={filePath}
        cwd={cwd}
        metadata={metadata}
        watching={watching}
        sourceSessionId={sourceSessionId}
      />
      <div className="file-viewer-document-stage">
        {error ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "var(--danger)", fontSize: 13, textAlign: "center" }}>
            {error}
          </div>
        ) : (
          <iframe
            key={previewUrl}
            src={previewUrl}
            sandbox={isPdf ? undefined : "allow-same-origin"}
            title={t("i18n.previewFile", { file: getFileName(filePath) })}
            style={{ width: "100%", height: "100%", border: "none", background: isPdf ? "var(--bg)" : "#eef1f5" }}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({
  filePath,
  cwd,
  sourceSessionId,
  onOpenFile,
  onMentionLines,
  onAtMention,
  gitRefreshKey,
  initialDisplayMode,
  initialState,
  initialPage,
  onStateChange,
  watchEnabled = true,
}: Props) {
  if (isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} watchEnabled={watchEnabled} />;
  }
  if (isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} watchEnabled={watchEnabled} />;
  }
  if (isVideoPath(filePath)) {
    return <VideoViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} watchEnabled={watchEnabled} />;
  }
  if (isDocumentPreviewPath(filePath)) {
    return <DocumentViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} initialPage={initialPage} watchEnabled={watchEnabled} />;
  }
  return <TextFileViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} onOpenFile={onOpenFile} onMentionLines={onMentionLines} onAtMention={onAtMention} gitRefreshKey={gitRefreshKey} initialDisplayMode={initialDisplayMode} initialState={initialState} onStateChange={onStateChange} watchEnabled={watchEnabled} />;
}

function TextFileViewer({
  filePath,
  cwd,
  sourceSessionId,
  onOpenFile,
  onMentionLines,
  onAtMention,
  gitRefreshKey,
  initialDisplayMode,
  initialState,
  onStateChange,
  watchEnabled = true,
}: Props) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [data, setData] = useState<FileData | null>(null);
  const [gitDiff, setGitDiff] = useState<GitFileDiffResponse | null>(null);
  const [gitDiffLoading, setGitDiffLoading] = useState(false);
  const [gitDiffResolved, setGitDiffResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The path default is resolved here, before the first fetch, so a markdown or
  // HTML file renders its preview as the first thing painted. Deciding it after
  // the contents load painted the source view for a frame first.
  const requestedInitialDisplayMode = resolveInitialFileDisplayMode(initialState, initialDisplayMode, filePath);
  const initialWrapLines = initialState?.wrapLines ?? false;
  const initialScrollTop = initialState?.scrollTop ?? 0;
  const initialScrollLeft = initialState?.scrollLeft ?? 0;
  const [displayMode, setDisplayMode] = useState<DisplayMode>(requestedInitialDisplayMode);
  const [wrapLines, setWrapLines] = useState(initialWrapLines);
  const [watching, setWatching] = useState(false);
  // HTML preview: the file is served from the app origin so its relative CSS,
  // images and fonts load, which is only safe with scripts off (sandbox without
  // allow-scripts, plus the route's CSP). Pages that need JS can opt into an
  // isolated srcDoc sandbox instead, where scripts run but local files don't load.
  const [htmlScriptsEnabled, setHtmlScriptsEnabled] = useState(false);
  const [htmlPreviewRevision, setHtmlPreviewRevision] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const contentRequestRef = useRef(0);
  const gitDiffRequestRef = useRef(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const autoDiffAppliedRef = useRef(false);
  const scrollRestorePendingRef = useRef(true);
  const viewerStateRef = useRef<FileViewerState>({
    displayMode: requestedInitialDisplayMode,
    wrapLines: initialWrapLines,
    scrollTop: initialScrollTop,
    scrollLeft: initialScrollLeft,
  });
  const onStateChangeRef = useRef(onStateChange);
  const [selectedLineRange, setSelectedLineRange] = useState<SelectedLineRange | null>(null);

  onStateChangeRef.current = onStateChange;

  const updateDisplayMode = useCallback((nextDisplayMode: DisplayMode) => {
    viewerStateRef.current.displayMode = nextDisplayMode;
    setDisplayMode(nextDisplayMode);
  }, []);

  const toggleWrapLines = useCallback(() => {
    setWrapLines((current) => {
      const next = !current;
      viewerStateRef.current.wrapLines = next;
      return next;
    });
  }, []);

  useEffect(() => {
    const nextState: FileViewerState = {
      displayMode: requestedInitialDisplayMode,
      wrapLines: initialWrapLines,
      scrollTop: initialScrollTop,
      scrollLeft: initialScrollLeft,
    };

    viewerStateRef.current = nextState;
    scrollRestorePendingRef.current = true;
    autoDiffAppliedRef.current = false;
    setDisplayMode(requestedInitialDisplayMode);
    setWrapLines(initialWrapLines);

    return () => {
      onStateChangeRef.current?.({ ...viewerStateRef.current });
    };
  }, [
    filePath,
    sourceSessionId,
    requestedInitialDisplayMode,
    initialWrapLines,
    initialScrollTop,
    initialScrollLeft,
  ]);

  const fetchContent = useCallback((filePath: string, offset = 0) => {
    const requestId = ++contentRequestRef.current;
    return fetch(getFileApiUrl(filePath, "read", sourceSessionId, { offset: offset || undefined }))
      .then((r) => r.json())
      .then((d: FileData & { error?: string }) => {
        if (requestId !== contentRequestRef.current) return null;
        if (d.error) {
          setError(d.error);
          return null;
        }
        setError(null);
        setData((current) => offset && current
          ? { ...d, content: current.content + d.content }
          : d);
        return d;
      })
      .catch((e) => {
        if (requestId !== contentRequestRef.current) return null;
        setError(String(e));
        return null;
      });
  }, [sourceSessionId]);

  const fetchGitDiff = useCallback(async (targetPath: string) => {
    const requestId = ++gitDiffRequestRef.current;
    setGitDiffLoading(true);
    if (!cwd) {
      setGitDiff(null);
      setGitDiffLoading(false);
      setGitDiffResolved(true);
      return;
    }

    try {
      const params = new URLSearchParams({ cwd, path: targetPath });
      const response = await fetch(`/api/git/diff?${params.toString()}`);
      const next = await response.json() as GitFileDiffResponse & { error?: string };
      if (requestId !== gitDiffRequestRef.current) return;
      setGitDiff(response.ok && next.supported && typeof next.patch === "string" ? next : null);
    } catch {
      if (requestId === gitDiffRequestRef.current) setGitDiff(null);
    } finally {
      if (requestId === gitDiffRequestRef.current) {
        setGitDiffLoading(false);
        setGitDiffResolved(true);
      }
    }
  }, [cwd]);

  // Reset and load the file itself when its identity changes. Live watching is
  // managed separately so pausing it never clears the displayed content.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setData(null);
    setGitDiff(null);
    setGitDiffResolved(false);
    setWatching(false);

    fetchContent(filePath).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [filePath, fetchContent, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    const synchronize = () => {
      void fetchContent(filePath);
      void fetchGitDiff(filePath);
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      // The server emits connected only after its watcher exists. Reading now
      // closes the gap between the last snapshot and live events.
      synchronize();
    });

    es.addEventListener("change", () => {
      synchronize();
      // The served preview reads from disk itself; reload it on real changes
      // only (not on "connected", which would wipe what the user typed into it).
      setHtmlPreviewRevision((revision) => revision + 1);
    });

    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, fetchContent, fetchGitDiff, sourceSessionId, watchEnabled]);

  useEffect(() => {
    void fetchGitDiff(filePath);
  }, [fetchGitDiff, filePath, gitRefreshKey]);

  // The file tool's own diff (from the chat's "Files changed" list) wins over
  // git's: it is exactly what the tool changed, and exists without a repo.
  const turnPatch = useSyncExternalStore(
    subscribeTurnFilePatches,
    () => getTurnFilePatch(filePath),
    () => undefined,
  );
  const hasGitPatch = gitDiff?.supported === true && typeof gitDiff.patch === "string";
  const diffPatch = turnPatch ?? (hasGitPatch ? gitDiff!.patch! : null);
  // Name kept for the extraction tests: true for either diff source.
  const hasGitDiff = diffPatch !== null;
  const isDeletedDiff = hasGitPatch && gitDiff!.status === "deleted";

  useEffect(() => {
    if (gitDiffResolved && !hasGitDiff && displayMode === "diff") updateDisplayMode("source");
  }, [displayMode, gitDiffResolved, hasGitDiff, updateDisplayMode]);

  // Wait for the git request before restoring diff mode so the unresolved
  // placeholder cannot immediately demote it back to source.
  useEffect(() => {
    if (requestedInitialDisplayMode === "diff" && hasGitDiff && !autoDiffAppliedRef.current) {
      autoDiffAppliedRef.current = true;
      updateDisplayMode("diff");
    }
  }, [requestedInitialDisplayMode, hasGitDiff, updateDisplayMode]);

  const markdownPreview = useMemo(
    () => (data?.language === "markdown" ? normalizeDisplayMath(data.content) : ""),
    [data],
  );

  const frontmatter = useMemo(
    () => (data?.language === "markdown" ? parseFrontmatter(data.content) : null),
    [data],
  );

  const viewerContent = data?.content ?? "";
  const sourceLines = useMemo(() => viewerContent.split("\n"), [viewerContent]);
  const language = data?.language ?? "text";
  const isHtml = language === "html";
  const isMarkdown = language === "markdown";
  const htmlHasScripts = isHtml && /<script\b/i.test(viewerContent);
  const htmlPreviewUrl = getFileApiUrl(filePath, "serve", sourceSessionId, { v: htmlPreviewRevision });
  const hasPreview = !data?.truncated && (isHtml || isMarkdown);
  // Only the first chunk of a large file is loaded, so preview is unavailable
  // until the rest arrives; a preview default falls back to source instead of
  // rendering a partial document. The mode returns to preview once the whole
  // file is loaded, and the switch keeps showing source as active meanwhile.
  const effectiveDisplayMode = isDeletedDiff
    ? "diff"
    : displayMode === "preview" && !hasPreview
      ? "source"
      : displayMode;
  const showsSource = effectiveDisplayMode === "source" || (effectiveDisplayMode === "diff" && !hasGitDiff);
  const syntaxStylesheet = isDark ? vscDarkPlus : vs;
  // Tokenized once per load; the virtualized list renders only the rows on screen.
  const sourceTokens = useMemo(
    () => (showsSource ? highlightCodeLines(viewerContent, language) : null),
    [language, showsSource, viewerContent],
  );
  const renderSourceRow = useCallback((lineIndex: number) => {
    const tokens = sourceTokens?.[lineIndex];
    return (
      <span
        className="file-source-line"
        data-line-number={lineIndex + 1}
        key={lineIndex}
        style={SOURCE_LINE_STYLE}
      >
        <span aria-hidden="true" style={FILE_LINE_NUMBER_STYLE}>
          {lineIndex + 1}
        </span>
        <span
          className="file-source-line-content"
          style={wrapLines ? WRAPPED_SOURCE_LINE_CONTENT_STYLE : SOURCE_LINE_CONTENT_STYLE}
        >
          {tokens ? renderCodeTokens(tokens, syntaxStylesheet) : sourceLines[lineIndex]}
        </span>
      </span>
    );
  }, [sourceLines, sourceTokens, syntaxStylesheet, wrapLines]);

  useEffect(() => {
    const updateSelectedLineRange = () => {
      const root = contentRef.current;
      setSelectedLineRange((current) => {
        const next = onMentionLines && displayMode === "source" && root
          ? getSelectedSourceLineRange(root, window.getSelection())
          : null;
        // Skip no-op updates: selectionchange fires continuously while dragging,
        // and a fresh-but-equal range object would re-render the whole viewer.
        if (current === null && next === null) return current;
        if (current && next && current.startLine === next.startLine && current.endLine === next.endLine) return current;
        return next;
      });
    };

    updateSelectedLineRange();
    if (!onMentionLines || displayMode !== "source") return;

    document.addEventListener("selectionchange", updateSelectedLineRange);
    return () => document.removeEventListener("selectionchange", updateSelectedLineRange);
  }, [data?.content, displayMode, onMentionLines]);

  const mentionLineRange = useCallback((lineRange: SelectedLineRange | null) => {
    if (!onMentionLines || !lineRange) return;
    onMentionLines(
      getRelativeFilePath(filePath, cwd),
      lineRange.startLine,
      lineRange.endLine,
    );
  }, [cwd, filePath, onMentionLines]);

  useEffect(() => {
    if (!onMentionLines || displayMode !== "source") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.key.toLowerCase() !== "i" || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;

      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;

      const root = contentRef.current;
      const lineRange = root ? getSelectedSourceLineRange(root, window.getSelection()) : null;
      if (!lineRange) return;

      event.preventDefault();
      mentionLineRange(lineRange);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [displayMode, mentionLineRange, onMentionLines]);

  // Ctrl/Cmd+F searches the rendered file while the right panel is showing it.
  // The embedded HTML preview is a separate document the highlights cannot reach,
  // so it keeps the platform's own behaviour. `watchEnabled` is the panel-open flag.
  const findAvailable = watchEnabled
    && !loading
    && !(error && !isDeletedDiff)
    && !(isHtml && effectiveDisplayMode === "preview")
    && supportsDomFind();
  const find = useFindShortcut("file", contentRef, findAvailable);

  useEffect(() => {
    if (!scrollRestorePendingRef.current || loading) return;
    if (error && !isDeletedDiff) return;
    if (requestedInitialDisplayMode === "diff" && !gitDiffResolved) return;
    if (requestedInitialDisplayMode === "diff" && hasGitDiff && displayMode !== "diff") return;

    const content = contentRef.current;
    if (!content) return;

    content.scrollTop = viewerStateRef.current.scrollTop;
    content.scrollLeft = viewerStateRef.current.scrollLeft;
    scrollRestorePendingRef.current = false;
  }, [
    data?.content,
    displayMode,
    error,
    gitDiffResolved,
    hasGitDiff,
    isDeletedDiff,
    loading,
    requestedInitialDisplayMode,
  ]);

  if (loading || (requestedInitialDisplayMode === "diff" && gitDiffLoading && !data)) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("i18n.loading")}
      </div>
    );
  }

  if (error && !isDeletedDiff) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
        {error}
      </div>
    );
  }

  if (!data && !isDeletedDiff) return null;

  const content = viewerContent;
  const markdownDirectory = getFileDirectory(filePath);
  const lines = sourceLines;
  const displayModes: DisplayMode[] = isDeletedDiff
    ? ["diff"]
    : [
        "source",
        ...(hasPreview ? ["preview" as const] : []),
        ...(hasGitDiff ? ["diff" as const] : []),
      ];
  const metadata = isDeletedDiff
    ? t("files.deleted")
    : `${language} · ${lines.length} lines · ${formatSize(data!.size)}`;

  return (
    <div className="file-viewer-shell" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", position: "relative" }}>
      <div
        className="file-viewer-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          borderBottom: "var(--hairline) solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span className="file-viewer-path" style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>

        <span className="file-viewer-meta" title={metadata}>{metadata}</span>
        {!isDeletedDiff && (
          <span
            title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
            aria-label={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
            className="file-viewer-live-indicator"
            style={{
              background: watching ? "#4ade80" : "var(--border)",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
        )}

        <div className="file-viewer-controls">
          {displayModes.length > 1 && (
            <div className="file-viewer-mode-switch" aria-label={t("i18n.fileViewMode")}>
              {displayModes.map((mode) => {
                const active = effectiveDisplayMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => updateDisplayMode(mode)}
                    title={mode === "diff" ? t("i18n.compareHead") : undefined}
                    aria-pressed={active}
                    className="file-viewer-mode-button"
                  >
                    {DISPLAY_MODE_LABELS[mode]}
                  </button>
                );
              })}
            </div>
          )}

          <div className="file-viewer-actions">
            {isHtml && effectiveDisplayMode === "preview" && htmlHasScripts && (
              <button
                type="button"
                onClick={() => setHtmlScriptsEnabled((enabled) => !enabled)}
                title={t(htmlScriptsEnabled ? "files.htmlScriptsOnTitle" : "files.htmlScriptsOffTitle")}
                aria-pressed={htmlScriptsEnabled}
                className="file-viewer-mode-button"
                style={{
                  background: htmlScriptsEnabled ? "var(--bg-selected)" : "transparent",
                  color: htmlScriptsEnabled ? "var(--text)" : "var(--text-muted)",
                }}
              >
                {t("files.htmlRunScripts")}
              </button>
            )}
            {(onAtMention || onMentionLines) && (
              <button
                type="button"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  // Mention selected lines when a range is active (and line
                  // mention is wired up); otherwise fall back to a whole-file
                  // @mention. Same button, behavior follows the selection.
                  if (selectedLineRange && onMentionLines) {
                    mentionLineRange(selectedLineRange);
                  } else {
                    onAtMention?.(getRelativeFilePath(filePath, cwd), false);
                  }
                }}
                title={
                  selectedLineRange && onMentionLines
                    ? `${t("i18n.mentionSelectedLines")} (L${selectedLineRange.startLine}${selectedLineRange.startLine !== selectedLineRange.endLine ? `-L${selectedLineRange.endLine}` : ""})`
                    : t("files.insertPath")
                }
                aria-label={t("files.mention")}
                disabled={!onAtMention && !onMentionLines}
                className="file-viewer-icon-button"
              >
                <MentionIcon />
              </button>
            )}
            {effectiveDisplayMode === "source" && (
              <>
                <button
                  type="button"
                  onClick={toggleWrapLines}
                  title={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                  aria-label={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                  aria-pressed={wrapLines}
                  className="file-viewer-icon-button"
                  style={{
                    background: wrapLines ? "var(--bg-selected)" : "transparent",
                    color: wrapLines ? "var(--text)" : "var(--text-muted)",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h18" />
                    <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
                    <path d="m16 16-2 2 2 2" />
                    <path d="M3 18h7" />
                  </svg>
                </button>
              </>
            )}
          </div>

          {!isDeletedDiff && <DesktopPathActions filePath={filePath} />}
          {!isDeletedDiff && <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />}
        </div>
      </div>

      {data?.truncated && (
        <div
          className="file-viewer-load-more"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: "5px 8px",
            border: "var(--hairline) solid var(--border)",
            borderRadius: 6,
            color: "var(--text-dim)",
            fontSize: 11,
          }}
        >
          <span>{formatSize(data.nextOffset)} / {formatSize(data.size)}</span>
          <button
            type="button"
            className="file-viewer-mode-button"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void fetchContent(filePath, data.nextOffset).finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore ? t("i18n.loading") : t("i18n.loadMore")}
          </button>
        </div>
      )}

      <FindBar
        rootRef={contentRef}
        open={find.open}
        focusToken={find.focusToken}
        seed={find.seed}
        onClose={find.close}
      />

      {/* Content area */}
      <div
        ref={contentRef}
        className="file-viewer-content"
        tabIndex={-1}
        onScroll={(event) => {
          viewerStateRef.current.scrollTop = event.currentTarget.scrollTop;
          viewerStateRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        onCopy={(event) => {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);
          const text = (effectiveDisplayMode === "source" && contentRef.current
            ? copiedSourceText(contentRef.current, range, sourceLines)
            : null) ?? copiedCodeText(range.cloneContents());
          if (text === null) return;
          event.preventDefault();
          event.clipboardData.setData("text/plain", text);
        }}
        style={{ flex: 1, overflow: "auto", outline: "none", background: "var(--bg)", paddingBottom: data?.truncated ? 48 : undefined }}
      >
        {effectiveDisplayMode === "diff" && hasGitDiff ? (
          <DiffView
            patch={diffPatch!}
            language={language}
            stylesheet={syntaxStylesheet}
            scrollRef={contentRef}
            renderAll={find.open}
          />
        ) : isHtml && effectiveDisplayMode === "preview" ? (
          htmlScriptsEnabled && htmlHasScripts ? (
            <iframe
              key="html-preview-scripts"
              srcDoc={content}
              sandbox="allow-scripts"
              style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
              title={t("i18n.htmlPreview")}
            />
          ) : (
            <iframe
              key={htmlPreviewUrl}
              src={htmlPreviewUrl}
              sandbox="allow-same-origin"
              style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
              title={t("i18n.htmlPreview")}
            />
          )
        ) : isMarkdown && effectiveDisplayMode === "preview" ? (
          <div
            className="markdown-body markdown-file-preview"
            style={{ padding: "24px 32px" }}
          >
            {frontmatter?.data && <FrontmatterCard data={frontmatter.data} />}
            <ReactMarkdown
              remarkPlugins={markdownPreviewRemarkPlugins}
              rehypePlugins={markdownPreviewRehypePlugins}
              urlTransform={onOpenFile ? markdownUrlTransform : undefined}
              components={{
                code({ className, children, ...props }) {
                  const lang = className?.replace("language-", "").toLowerCase() ?? "";
                  const raw = String(children);
                  const isBlock = className?.includes("language-") || raw.includes("\n");
                  if (isBlock) {
                    if (lang === "mermaid") {
                      return <MermaidBlock code={raw.replace(/\n$/, "")} defaultPreview />;
                    }
                    return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                pre({ children }) {
                  // Render the code block directly — CodeBlock provides its own wrapping.
                  // For non-mermaid blocks, pass through to default pre rendering.
                  return <>{children}</>;
                },
                a({ href, children, ...props }) {
                  delete props.node;
                  const linkedFile = onOpenFile
                    ? resolveLocalFileHref(href, markdownDirectory, cwd ?? markdownDirectory)
                    : null;
                  if (!linkedFile || !onOpenFile) {
                    return <a href={href} {...props}>{children}</a>;
                  }

                  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
                    if (!shouldOpenLocalFileInApp(event)) return;
                    event.preventDefault();
                    onOpenFile(linkedFile, parsePdfPageFragment(href) ?? undefined);
                  };

                  return <a href={href} {...props} onClick={handleClick}>{children}</a>;
                },
                img({ src, alt, ...props }) {
                  delete props.node;
                  const imagePath = typeof src === "string"
                    ? resolveLocalFileHref(src, markdownDirectory, cwd ?? markdownDirectory)
                    : null;
                  const imageSrc = imagePath
                    ? getFileApiUrl(imagePath, "read", sourceSessionId)
                    : src;
                  // Dynamic local paths are served directly by the file API.
                  // eslint-disable-next-line @next/next/no-img-element
                  return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
                },
              }}
            >
              {markdownPreview}
            </ReactMarkdown>
          </div>
        ) : (
          <VirtualCodeList
            scrollRef={contentRef}
            rowCount={sourceLines.length}
            renderRow={renderSourceRow}
            renderAll={find.open}
            className={wrapLines ? "file-source-view is-wrapped" : "file-source-view"}
            style={{
              width: wrapLines ? "100%" : "max-content",
              minWidth: "100%",
              minHeight: "100%",
              background: "var(--bg)",
              color: (sourceTokens && codeBaseColor(syntaxStylesheet)) || "var(--text)",
              tabSize: 4,
              ...FILE_CODE_STYLE,
            }}
          />
        )}
      </div>
    </div>
  );
}
