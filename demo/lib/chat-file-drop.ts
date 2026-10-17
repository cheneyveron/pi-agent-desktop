import { buildFileAtMentionsText } from "./file-fuzzy";
import {
  PROJECT_UPLOAD_MAX_FILE_BYTES,
  PROJECT_UPLOAD_MAX_TOTAL_BYTES,
  uploadProjectFiles,
  type ProjectUploadResponse,
} from "./project-file-upload-client";

export interface ChatDroppedFilePartition {
  images: File[];
  projectFiles: File[];
}

export function isChatDropImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** Split a OS file drop into vision attachments vs project-file imports. */
export function partitionChatDroppedFiles(files: File[]): ChatDroppedFilePartition {
  const images: File[] = [];
  const projectFiles: File[] = [];
  for (const file of files) {
    if (!file.name || file.name === "." || file.name === "..") continue;
    if (file.name.includes("/") || file.name.includes("\\") || file.name.includes("\0")) continue;
    if (isChatDropImageFile(file)) images.push(file);
    else projectFiles.push(file);
  }
  return { images, projectFiles };
}

export function mentionPathsForUploadResult(data: ProjectUploadResponse): string[] {
  return [...(data.uploaded ?? []), ...(data.skipped ?? [])];
}

export interface ImportDroppedProjectFilesResult {
  mentionText: string;
  uploaded: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * Copy dropped non-image files into the session cwd and return @mention text.
 * Existing same-named files are skipped (kept) and still mentioned.
 */
export async function importDroppedProjectFiles(
  cwd: string,
  files: File[],
): Promise<ImportDroppedProjectFilesResult> {
  const rejected: Array<{ name: string; reason: string }> = [];
  const accepted: File[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (file.size > PROJECT_UPLOAD_MAX_FILE_BYTES) {
      rejected.push({ name: file.name, reason: `larger than ${PROJECT_UPLOAD_MAX_FILE_BYTES / (1024 * 1024)}MB` });
      continue;
    }
    if (totalBytes + file.size > PROJECT_UPLOAD_MAX_TOTAL_BYTES) {
      rejected.push({ name: file.name, reason: "upload total would exceed 100MB" });
      continue;
    }
    accepted.push(file);
    totalBytes += file.size;
  }

  if (accepted.length === 0) {
    return { mentionText: "", uploaded: [], skipped: [], errors: [], rejected };
  }

  // Deduplicate by name — keep the last occurrence (matches OS multi-select quirks).
  const byName = new Map<string, File>();
  for (const file of accepted) byName.set(file.name, file);
  const uniqueFiles = Array.from(byName.values());

  const { status, data } = await uploadProjectFiles(cwd, uniqueFiles, "skip");
  if (status < 200 || status >= 300 && status !== 207) {
    throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
  }

  const uploaded = data.uploaded ?? [];
  const skipped = data.skipped ?? [];
  const errors = data.errors ?? [];
  const mentionPaths = mentionPathsForUploadResult(data);

  return {
    mentionText: buildFileAtMentionsText(mentionPaths),
    uploaded,
    skipped,
    errors,
    rejected,
  };
}
