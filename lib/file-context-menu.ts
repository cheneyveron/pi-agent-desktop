import { getFileName } from "./file-paths";
import { resolveLocalFileHref } from "./file-links";
import type { NativeMenuEntry } from "./desktop-menu-model";
import type { DesktopPlatform } from "./desktop-window";
import type { FileOpenApp } from "./desktop-native";

/**
 * Right-click menu for a file the chat mentions: Open (in the preview pane),
 * Open With ▸ (macOS), Reveal in the file manager, Copy Path. Pure helpers
 * only; the hook in `hooks/useFileContextMenu.ts` owns the native calls.
 */

const MAX_INLINE_PATH_LENGTH = 260;

/**
 * Absolute path a piece of inline code might name, or null when the text
 * cannot be a file path. This is only the cheap pre-filter run synchronously
 * on right-click; whether the file exists is decided by the server afterwards.
 */
export function inlineCodeFilePath(text: string, cwd: string | undefined): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_INLINE_PATH_LENGTH) return null;
  if (/[\r\n\t]/.test(trimmed)) return null;
  if (trimmed.startsWith("~") || trimmed.includes("://")) return null;
  return resolveLocalFileHref(trimmed, cwd);
}

const FENCE_LINE = /^[ \t>]*(`{3,}|~{3,})/;
const INLINE_CODE_SPAN = /`([^`\n]+)`/g;

/**
 * Fenced blocks introduced by a path: "Saved: `/a/b.md`. Full content:" followed
 * by the fence. Maps the 1-based line a fence opens on to the file the prose
 * right before it names (the last inline-code path with an extension in the
 * paragraph above, blank lines skipped), so the block can offer an Open
 * button. Only a guess; the caller confirms the file exists.
 */
export function fenceFilePaths(markdown: string, cwd: string | undefined): Map<number, string> {
  const result = new Map<number, string>();
  if (!markdown.includes("`")) return result;
  const lines = markdown.split(/\r?\n/);
  let fence: { marker: string; size: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const match = FENCE_LINE.exec(lines[index]);
    if (!match) continue;
    const marker = match[1][0];
    const size = match[1].length;
    if (fence) {
      if (marker === fence.marker && size >= fence.size) fence = null;
      continue;
    }
    fence = { marker, size };
    let above = index - 1;
    while (above >= 0 && lines[above].trim() === "") above--;
    let path: string | null = null;
    for (; above >= 0 && lines[above].trim() !== "" && !FENCE_LINE.test(lines[above]); above--) {
      const spans = [...lines[above].matchAll(INLINE_CODE_SPAN)];
      for (let i = spans.length - 1; i >= 0 && !path; i--) {
        const text = spans[i][1].trim();
        if (/\s/.test(text) || !/\.[A-Za-z0-9]{1,8}$/.test(text)) continue;
        path = inlineCodeFilePath(text, cwd);
      }
      if (path) break;
    }
    if (path) result.set(index + 1, path);
  }
  return result;
}

/** Apps are listed per file type: Launch Services answers by extension, and one lookup costs ~150ms. */
export function appListCacheKey(filePath: string): string {
  const name = getFileName(filePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export type FileMenuLabels = {
  open: string;
  openWith: string;
  otherApp: string;
  reveal: string;
  copyPath: string;
  defaultApp: (name: string) => string;
};

export interface FileMenuActions {
  open: () => void;
  openWith: (appPath: string) => void;
  chooseOtherApp: () => void;
  reveal: () => void;
  copyPath: () => void;
}

/**
 * `apps` is null where the platform has no Open With (everything but macOS), so
 * the submenu is omitted; an empty list still offers "Other…".
 */
export function buildFileMenuEntries(
  labels: FileMenuLabels,
  actions: FileMenuActions,
  apps: FileOpenApp[] | null,
): NativeMenuEntry[] {
  const entries: NativeMenuEntry[] = [{ label: labels.open, onSelect: actions.open }];
  if (apps) {
    entries.push({
      kind: "submenu",
      label: labels.openWith,
      items: [
        ...apps.map((app): NativeMenuEntry => ({
          label: app.isDefault ? labels.defaultApp(app.name) : app.name,
          onSelect: () => actions.openWith(app.path),
        })),
        ...(apps.length > 0 ? [{ kind: "separator" as const }] : []),
        { label: labels.otherApp, onSelect: actions.chooseOtherApp },
      ],
    });
  }
  entries.push(
    { kind: "separator" },
    { label: labels.reveal, onSelect: actions.reveal },
    { label: labels.copyPath, onSelect: actions.copyPath },
  );
  return entries;
}

/** Message key for "reveal in the file manager", named after the platform's own. */
export function revealLabelKey(platform: DesktopPlatform): string {
  if (platform === "macos") return "fileMenu.revealInFinder";
  if (platform === "windows") return "fileMenu.revealInExplorer";
  return "fileMenu.revealInFileManager";
}
