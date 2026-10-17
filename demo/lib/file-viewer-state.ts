import { getFileExt } from "./file-types.ts";

export type FileViewerDisplayMode = "source" | "preview" | "diff";

export interface FileViewerState {
  displayMode: FileViewerDisplayMode;
  wrapLines: boolean;
  scrollTop: number;
  scrollLeft: number;
}

// The extensions the read endpoint reports as `markdown`/`html` and the viewer
// can render. Keep in step with EXT_TO_LANGUAGE in app/api/files/[...path].
const PREVIEW_FIRST_EXTENSIONS = new Set(["md", "mdx", "html", "htm"]);

/**
 * Rendered-first default for a file that has no restored mode and no open hint.
 * Files without a renderable form stay on source.
 */
export function defaultFileDisplayModeForPath(filePath?: string): FileViewerDisplayMode {
  return filePath && PREVIEW_FIRST_EXTENSIONS.has(getFileExt(filePath)) ? "preview" : "source";
}

export function resolveInitialFileDisplayMode(
  initialState?: FileViewerState,
  initialDisplayMode?: FileViewerDisplayMode,
  filePath?: string,
): FileViewerDisplayMode {
  return initialState?.displayMode ?? initialDisplayMode ?? defaultFileDisplayModeForPath(filePath);
}
