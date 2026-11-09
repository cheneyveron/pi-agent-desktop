import type { ArtifactSummary, OutputSummary } from "@/lib/artifact-index";
import { isImagePath } from "@/lib/file-types";
import { getFileName } from "@/lib/file-paths";

/** Chats are one scope; each project (by its stable key) is another. */
export const CHATS_SCOPE = "chats";

export function artifactScope(item: Pick<ArtifactSummary, "workspaceKind" | "projectKey" | "projectRoot" | "cwd">): string {
  return item.workspaceKind === "chat" ? CHATS_SCOPE : `project:${item.projectKey ?? item.projectRoot ?? item.cwd}`;
}

/** A file is one row however many conversations touched it, so it is keyed by path alone. */
export function artifactKey(item: OutputSummary): string {
  return item.kind === "file" ? `file\u0000${item.path}` : `${item.sessionId}\u0000${item.identifier}`;
}

export interface ScopeOption {
  value: string;
  label: string;
}

/** Projects in the list by name, then Chats when any are present. */
export function scopeOptions(items: readonly OutputSummary[], chatsLabel: string): ScopeOption[] {
  const projects = new Map<string, string>();
  let chats = false;
  for (const item of items) {
    const scope = artifactScope(item);
    if (scope === CHATS_SCOPE) {
      chats = true;
      continue;
    }
    if (!projects.has(scope)) {
      const root = item.projectRoot ?? item.cwd;
      projects.set(scope, getFileName(root) || root);
    }
  }
  const options = [...projects].map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  return chats ? [...options, { value: CHATS_SCOPE, label: chatsLabel }] : options;
}

/**
 * Type filter values beyond the artifact types. The default (empty) view is
 * the outputs: every artifact and the files classed as outputs. Process files
 * show only under their own value or "everything".
 */
export const TYPE_EVERYTHING = "all";
export const TYPE_ALL_ARTIFACTS = "artifacts";
export const TYPE_OUTPUT_FILES = "files";
export const TYPE_PROCESS_FILES = "files:process";

function isProcessFile(item: OutputSummary): boolean {
  return item.kind === "file" && item.role === "process";
}

function matchesType(item: OutputSummary, type: string): boolean {
  if (type === TYPE_EVERYTHING) return true;
  if (type === TYPE_PROCESS_FILES) return isProcessFile(item);
  if (isProcessFile(item)) return false;
  if (!type) return true;
  if (item.kind === "file") return type === TYPE_OUTPUT_FILES;
  return type === TYPE_ALL_ARTIFACTS || item.type === type;
}

/**
 * Empty `type` means the outputs, empty `scope` everywhere. With
 * `favoritesOnly`, only starred rows; the outputs default then also keeps
 * starred process files, since the user picked them.
 */
export function filterArtifacts(items: readonly OutputSummary[], type: string, scope: string, favoritesOnly = false): OutputSummary[] {
  return items.filter((item) => (
    (favoritesOnly ? item.favorite && (!type || matchesType(item, type)) : matchesType(item, type))
    && (!scope || artifactScope(item) === scope)
  ));
}

/** Process files in `scope` that the outputs view leaves out, for its "N more" line. */
export function countProcessFiles(items: readonly OutputSummary[], scope: string): number {
  return items.reduce((count, item) => count + (isProcessFile(item) && (!scope || artifactScope(item) === scope) ? 1 : 0), 0);
}

export type FileThumbnailKind = "file-image" | "frame" | "mermaid" | "text" | "code" | "icon";

/** How a file row previews: images (SVG too, which /api/files serves as one) and the text formats artifacts already preview. */
export function fileThumbnailKind(path: string): FileThumbnailKind {
  const lower = path.toLowerCase();
  if (isImagePath(lower)) return "file-image";
  if (/\.html?$/.test(lower)) return "frame";
  if (/\.(mmd|mermaid)$/.test(lower)) return "mermaid";
  if (/\.(md|markdown|txt)$/.test(lower)) return "text";
  if (/\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|zsh|ps1|sql|css|scss|json|ya?ml|toml|xml|ini)$/.test(lower)) return "code";
  return "icon";
}

/**
 * How a list row previews an artifact without running its code: SVG and
 * Mermaid as images, HTML as a static image of the page, text as an excerpt.
 * React needs its runtime and scripts, so it keeps the type icon.
 */
export type ThumbnailKind = "image" | "mermaid" | "frame" | "text" | "icon";

export function thumbnailKind(type: ArtifactSummary["type"]): ThumbnailKind {
  if (type === "svg") return "image";
  if (type === "mermaid") return "mermaid";
  if (type === "html") return "frame";
  if (type === "markdown" || type === "code") return "text";
  return "icon";
}

/** Larger documents keep the icon: a thumbnail is not worth parsing them. */
export const THUMBNAIL_MAX_CHARS = 300_000;

/** The first lines of a document, without Markdown's block markers. */
export function textExcerpt(content: string, type: ArtifactSummary["type"], maxLines = 8): string {
  const lines = content.split("\n");
  if (type === "code") return lines.slice(0, maxLines).join("\n");
  const out: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const text = fenced ? line : line.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "").replace(/[*_`]/g, "");
    if (!text.trim() || /^\s*([-*_]\s*){3,}$/.test(line) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)) continue;
    out.push(text.trim());
    if (out.length >= maxLines) break;
  }
  return out.join("\n");
}

/** An `<img>` needs the SVG namespace that inline SVG in HTML may leave out. */
export function svgImageSource(svg: string): string {
  const withNamespace = /<svg\b[^>]*\bxmlns\s*=/.test(svg) ? svg : svg.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNamespace)}`;
}

/** HTML thumbnails lay the page out at this size, then scale it down. */
export const PAGE_THUMBNAIL_WIDTH = 800;
export const PAGE_THUMBNAIL_HEIGHT = 600;

/**
 * Wraps a serialized XHTML document in an SVG image. Used as an `<img>`, the
 * page cannot run scripts or load anything, so the thumbnail is inert.
 */
export function pageImageSvg(xhtml: string): string {
  const width = PAGE_THUMBNAIL_WIDTH;
  const height = PAGE_THUMBNAIL_HEIGHT;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="100%" height="100%" fill="#fff"/>`
    + `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
}
