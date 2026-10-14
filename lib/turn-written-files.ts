import type { AssistantContentBlock, ToolResultMessage } from "./types";
import { resolveLocalFilePath } from "./file-links";
import { isApplyPatchToolName, isEditToolName, isWriteToolName } from "./tool-names";
import {
  applyPatchPreviewToFiles,
  applyPatchResultHasFailures,
  getApplyPatchAppliedFiles,
  getApplyPatchInputText,
  parseApplyPatchInput,
} from "./apply-patch";
import { parseUnifiedPatch, type SplitDiffFile } from "./patch";

export interface WrittenFile {
  /** Resolved absolute path of a file this turn wrote. */
  filePath: string;
  /** Lines added across the turn's calls on this file, when any call reported them. */
  added?: number;
  /** Lines removed across the turn's calls on this file, when any call reported them. */
  removed?: number;
}

interface LineStats {
  added: number;
  removed: number;
}

function countTextLines(text: string): number {
  return splitLines(text).length;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Lines one replacement changed. Models quote surrounding context in oldText
 * and newText, so counting both whole would report a one-line fix as +10 −10;
 * lines the two share at the start and end are not changes.
 */
export function changedLineCounts(before: string, after: string): LineStats {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { removed: a.length - start - end, added: b.length - start - end };
}

function statsFromRows(file: SplitDiffFile): LineStats {
  const stats = { added: 0, removed: 0 };
  for (const row of file.rows) {
    if (row.type !== "line") continue;
    if (row.left.type === "removed") stats.removed++;
    if (row.right.type === "added") stats.added++;
  }
  return stats;
}

/**
 * Line counts for one write/edit call. `write` reports its whole content as
 * added — the tool does not say what it replaced. `edit` reads pi's numbered
 * diff (`+12 text` / `-12 text`) or a unified patch from `details`, and falls
 * back to the old/new text in its input.
 */
function readWriteEditStats(toolName: string, input: Record<string, unknown> | undefined, result: ToolResultMessage): LineStats | null {
  if (isWriteToolName(toolName)) {
    const content = input?.content;
    return typeof content === "string" ? { added: countTextLines(content), removed: 0 } : null;
  }

  const details = result.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const record = details as Record<string, unknown>;
    if (typeof record.diff === "string" && record.diff.length > 0) {
      const stats = { added: 0, removed: 0 };
      for (const line of record.diff.split(/\r?\n/)) {
        if (/^\+\s*\d+ /.test(line)) stats.added++;
        else if (/^-\s*\d+ /.test(line)) stats.removed++;
      }
      if (stats.added > 0 || stats.removed > 0) return stats;
    }
    if (typeof record.patch === "string") {
      const files = parseUnifiedPatch(record.patch);
      if (files) {
        return files.map(statsFromRows).reduce((sum, s) => ({ added: sum.added + s.added, removed: sum.removed + s.removed }), { added: 0, removed: 0 });
      }
    }
  }

  const edits = Array.isArray(input?.edits) ? input.edits : input ? [input] : [];
  let found = false;
  const stats = { added: 0, removed: 0 };
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const { oldText, newText, old_string, new_string } = edit as Record<string, unknown>;
    const before = oldText ?? old_string;
    const after = newText ?? new_string;
    if (typeof before !== "string" || typeof after !== "string") continue;
    found = true;
    const changed = changedLineCounts(before, after);
    stats.removed += changed.removed;
    stats.added += changed.added;
  }
  return found ? stats : null;
}

/** Per-path line counts of one apply_patch call, keyed by the path each file landed at. */
function readApplyPatchStats(input: Record<string, unknown> | undefined, result: ToolResultMessage): Map<string, LineStats> {
  const details = result.details;
  const files = (details && typeof details === "object" && !Array.isArray(details)
    ? applyPatchPreviewToFiles((details as Record<string, unknown>).preview)
    : null) ?? parseApplyPatchInput(getApplyPatchInputText(input));
  const stats = new Map<string, LineStats>();
  for (const file of files ?? []) {
    if (!file.newPath) continue;
    const prev = stats.get(file.newPath) ?? { added: 0, removed: 0 };
    const next = statsFromRows(file);
    stats.set(file.newPath, { added: prev.added + next.added, removed: prev.removed + next.removed });
  }
  return stats;
}

function isFileWritingToolName(toolName: string): boolean {
  return isWriteToolName(toolName) || isEditToolName(toolName);
}

function readToolPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const value = input.file_path ?? input.path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function writtenPathsFromFiles(files: SplitDiffFile[] | null): string[] {
  if (!files) return [];
  // Deletes have no newPath — they are not files this turn wrote.
  return files
    .map((file) => file.newPath)
    .filter((filePath): filePath is string => typeof filePath === "string" && filePath.length > 0);
}

function collectApplyPatchDeletePaths(input: Record<string, unknown> | undefined, details: unknown): Set<string> {
  const deleted = new Set<string>();
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const preview = (details as Record<string, unknown>).preview;
    if (preview && typeof preview === "object" && !Array.isArray(preview)) {
      const files = (preview as Record<string, unknown>).files;
      if (Array.isArray(files)) {
        for (const raw of files) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const entry = raw as { operation?: unknown; filePath?: unknown };
          if (entry.operation === "delete" && typeof entry.filePath === "string" && entry.filePath.length > 0) {
            deleted.add(entry.filePath);
          }
        }
      }
    }
  }
  for (const match of getApplyPatchInputText(input).matchAll(/^\*\*\* Delete File: (.+)$/gm)) {
    const filePath = (match[1] ?? "").trim();
    if (filePath) deleted.add(filePath);
  }
  return deleted;
}

/**
 * Collect the paths one apply_patch call actually wrote.
 *
 * Prefers `details.result.appliedFiles` (what landed, including rename
 * targets). Falls back to the applied-result preview, then the patch
 * document. Deletes are omitted — they are not files this turn wrote.
 * A returned failure with no `appliedFiles` writes nothing.
 */
function readApplyPatchPaths(input: Record<string, unknown> | undefined, result: ToolResultMessage | undefined): string[] {
  const details = result?.details;
  const deleted = collectApplyPatchDeletePaths(input, details);
  const applied = getApplyPatchAppliedFiles(details);
  if (applied) return applied.filter((filePath) => !deleted.has(filePath));
  if (applyPatchResultHasFailures(details)) return [];

  if (details && typeof details === "object" && !Array.isArray(details)) {
    const fromPreview = writtenPathsFromFiles(applyPatchPreviewToFiles((details as Record<string, unknown>).preview));
    if (fromPreview.length > 0) return fromPreview;
  }
  return writtenPathsFromFiles(parseApplyPatchInput(getApplyPatchInputText(input)));
}

/**
 * Collect the distinct files a single assistant turn actually wrote.
 *
 * Every entry is derived from a `write`/`edit`/`apply_patch` tool call whose
 * result arrived and did not error — never from the reply text. A path the
 * assistant merely mentions in prose is not evidence that any file was
 * touched, so it is not a source here; the tool call is the record of what
 * happened.
 *
 * Paths are resolved against `cwd`, deduped, and kept in first-seen order;
 * line counts of repeated calls on one file are summed.
 */
export function extractTurnWrittenFiles(
  content: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
  cwd?: string,
): WrittenFile[] {
  const byPath = new Map<string, WrittenFile>();

  for (const block of content) {
    if (block.type !== "toolCall") continue;
    if (!isFileWritingToolName(block.toolName) && !isApplyPatchToolName(block.toolName)) continue;

    const result = toolResults?.get(block.toolCallId);
    if (!result || result.isError) continue;

    const isPatch = isApplyPatchToolName(block.toolName);
    const rawPaths = isPatch
      ? readApplyPatchPaths(block.input, result)
      : [readToolPath(block.input)];
    const patchStats = isPatch ? readApplyPatchStats(block.input, result) : null;

    for (const rawPath of rawPaths) {
      if (!rawPath) continue;

      // Tool arguments are filesystem paths, not hrefs: preserve characters such
      // as #, ?, and :digits that have special meaning in links and source refs.
      const filePath = resolveLocalFilePath(rawPath, cwd);
      if (!filePath) continue;

      let entry = byPath.get(filePath);
      if (!entry) {
        entry = { filePath };
        byPath.set(filePath, entry);
      }
      const stats = patchStats ? patchStats.get(rawPath) : readWriteEditStats(block.toolName, block.input, result);
      if (stats) {
        entry.added = (entry.added ?? 0) + stats.added;
        entry.removed = (entry.removed ?? 0) + stats.removed;
      }
    }
  }

  return [...byPath.values()];
}
