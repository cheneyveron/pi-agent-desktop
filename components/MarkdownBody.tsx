"use client";

import { createContext, memo, useContext, useEffect, useMemo, useState, type ComponentProps, type MouseEvent } from "react";
import { type Components, type ExtraProps } from "react-markdown";
import { useStreamingMarkdownText } from "@/hooks/useStreamingMarkdown";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { useFileContextMenu } from "@/hooks/useFileContextMenu";
import { useI18n } from "@/hooks/useI18n";
import { fenceFilePaths, inlineCodeFilePath } from "@/lib/file-context-menu";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRehypePlugins, markdownRemarkPlugins, markdownUrlTransform, markdownUserRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { ImagePreview } from "./ImagePreview";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { HtmlPreviewBlock } from "./HtmlPreviewBlock";
import { htmlPreviewKind } from "@/lib/html-preview";
import { ArtifactCard } from "./ArtifactCard";
import { ARTIFACT_FENCE_LANG, decodeArtifactFence, encodeArtifactsForMarkdown } from "@/lib/artifacts";
import { handleExternalLinkClick, openPathNative } from "@/lib/desktop-native";
import { isTauriDesktop } from "@/lib/desktop-updater";

const MarkdownLinkContext = createContext(false);

// One shared empty map: a fresh Map per streamed delta would rebuild `components` and re-parse every completed block.
const NO_FENCE_FILES: Map<number, string> = new Map();

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  sessionId?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Render every line ending as a line break, for text the user typed. */
  keepLineBreaks?: boolean;
  /** Render `:::artifact{...}` blocks as artifact cards (assistant text only). */
  artifacts?: boolean;
}

function MarkdownImage({
  src,
  alt,
  cwd,
  sessionId,
  ...props
}: ComponentProps<"img"> & ExtraProps & { cwd?: string; sessionId?: string }) {
  const insideLink = useContext(MarkdownLinkContext);
  delete props.node;
  const href = typeof src === "string" ? src : undefined;
  const filePath = href ? resolveLocalFileHref(href, cwd) : null;
  const imageSrc = filePath
    ? `/api/files/${encodeFilePathForApi(filePath)}?type=read${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`
    : href;
  // Dynamic local paths are served directly by the file API.
  // eslint-disable-next-line @next/next/no-img-element
  const image = <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
  if (!imageSrc || insideLink) return image;
  return (
    <ImagePreview src={imageSrc} alt={alt ?? ""} className="markdown-image">
      {image}
    </ImagePreview>
  );
}

/** Inline code that may name a file: right-click offers the file menu once the server confirms it exists. */
function MarkdownInlineCode({
  cwd,
  onOpenFile,
  children,
  ...props
}: ComponentProps<"code"> & ExtraProps & {
  cwd: string | undefined;
  onOpenFile: ((filePath: string, page?: number) => void) | undefined;
}) {
  delete props.node;
  const showFileMenu = useFileContextMenu(onOpenFile);
  return (
    <code
      className="markdown-inline-code"
      {...props}
      onContextMenu={onOpenFile ? (event) => {
        const filePath = inlineCodeFilePath(String(children), cwd);
        if (filePath) showFileMenu(event, { filePath, verify: true });
      } : undefined}
    >
      {children}
    </code>
  );
}

/** "Open" beside Copy on a code block the prose above attributes to a saved file; shown once the server confirms the file exists. */
function CodeBlockOpenFile({ filePath, onOpenFile }: { filePath: string; onOpenFile: (filePath: string) => void }) {
  const { t } = useI18n();
  const [exists, setExists] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setExists(false);
    fetch(`/api/files/${encodeFilePathForApi(filePath)}?type=meta`)
      .then((res) => { if (!cancelled) setExists(res.ok); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [filePath]);
  if (!exists) return null;
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  return (
    <>
      <button
        type="button"
        className="markdown-code-action"
        title={t("chat.openWrittenFile", { name })}
        onClick={() => onOpenFile(filePath)}
      >
        {t("sidebar.open")}
      </button>
      {isTauriDesktop() && (
        <button
          type="button"
          className="markdown-code-action"
          title={t("chat.openDefaultAppTitle", { name })}
          onClick={() => { openPathNative(filePath).catch((error) => console.error("Open with default app failed", error)); }}
        >
          {t("chat.openDefaultApp")}
        </button>
      )}
    </>
  );
}

/** A markdown link to a local file; right-click offers the file menu. */
function MarkdownLocalFileLink({
  filePath,
  page,
  onOpenFile,
  children,
  ...props
}: ComponentProps<"a"> & ExtraProps & {
  filePath: string;
  page: number | undefined;
  onOpenFile: (filePath: string, page?: number) => void;
}) {
  delete props.node;
  const showFileMenu = useFileContextMenu(onOpenFile);
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldOpenLocalFileInApp(event)) return;
    const target = event.currentTarget.getAttribute("target");
    if (target && target !== "_self") return;
    event.preventDefault();
    onOpenFile(filePath, page);
  };
  return (
    <MarkdownLinkContext.Provider value={true}>
      <a
        {...props}
        onClick={handleClick}
        onContextMenu={(event) => showFileMenu(event, { filePath, page })}
      >
        {children}
      </a>
    </MarkdownLinkContext.Provider>
  );
}

function buildComponents(
  isStreaming: boolean | undefined,
  cwd: string | undefined,
  sessionId: string | undefined,
  onOpenFile: ((filePath: string, page?: number) => void) | undefined,
  fenceFiles: Map<number, string>,
): Components {
  return {
    code({ className, children, node, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === ARTIFACT_FENCE_LANG) {
          const artifact = decodeArtifactFence(raw);
          if (artifact) return <ArtifactCard block={artifact} isStreaming={isStreaming} />;
        }
        if (lang === "mermaid") {
          return (
            <MermaidBlock
              code={raw.replace(/\n$/, "")}
              isStreaming={isStreaming}
              defaultPreview
            />
          );
        }
        const previewKind = htmlPreviewKind(lang, raw);
        if (previewKind) {
          return (
            <HtmlPreviewBlock
              code={raw.replace(/\n$/, "")}
              lang={lang}
              kind={previewKind}
              isStreaming={isStreaming}
              defaultPreview={previewKind !== "react"}
            />
          );
        }
        const savedPath = !isStreaming && onOpenFile ? fenceFiles.get(node?.position?.start.line ?? 0) : undefined;
        return (
          <CodeBlock
            code={raw.replace(/\n$/, "")}
            lang={lang}
            isStreaming={isStreaming}
            headerAction={savedPath && onOpenFile ? <CodeBlockOpenFile filePath={savedPath} onOpenFile={onOpenFile} /> : undefined}
          />
        );
      }
      return (
        <MarkdownInlineCode cwd={cwd} onOpenFile={onOpenFile} {...props}>
          {children}
        </MarkdownInlineCode>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a
              href={href}
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => handleExternalLinkClick(event, href)}
            >
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }

      return (
        <MarkdownLocalFileLink
          href={href}
          {...props}
          filePath={filePath}
          page={parsePdfPageFragment(href) ?? undefined}
          onOpenFile={openFile}
        >
          {children}
        </MarkdownLocalFileLink>
      );
    },
    img(props) {
      return <MarkdownImage cwd={cwd} sessionId={sessionId} {...props} />;
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  };
}

// Memoized: markdown parsing + highlighting is the most expensive render work
// in the app, so parent re-renders with identical props must be free.
export const MarkdownBody = memo(function MarkdownBody({ children, className, isStreaming, cwd, sessionId, onOpenFile, keepLineBreaks, artifacts }: MarkdownBodyProps) {
  const markdown = useStreamingMarkdownText(children, Boolean(isStreaming));
  const normalizedMarkdown = useMemo(
    () => normalizeDisplayMath(artifacts && markdown.includes(":::artifact") ? encodeArtifactsForMarkdown(markdown) : markdown),
    [markdown, artifacts],
  );
  const trackFences = !isStreaming && !!onOpenFile;
  const fenceFiles = useMemo(
    () => (trackFences ? fenceFilePaths(normalizedMarkdown, cwd) : NO_FENCE_FILES),
    [normalizedMarkdown, cwd, trackFences],
  );
  const components = useMemo(
    () => buildComponents(isStreaming, cwd, sessionId, onOpenFile, fenceFiles),
    [isStreaming, cwd, sessionId, onOpenFile, fenceFiles],
  );
  // Reuse the element when a new network delta has not published a snapshot.
  const body = useMemo(() => (
    <StreamingMarkdown
      isStreaming={isStreaming}
      remarkPlugins={keepLineBreaks ? markdownUserRemarkPlugins : markdownRemarkPlugins}
      rehypePlugins={markdownRehypePlugins}
      urlTransform={onOpenFile ? markdownUrlTransform : undefined}
      components={components}
    >
      {normalizedMarkdown}
    </StreamingMarkdown>
  ), [normalizedMarkdown, components, onOpenFile, keepLineBreaks, isStreaming]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {body}
    </div>
  );
});
