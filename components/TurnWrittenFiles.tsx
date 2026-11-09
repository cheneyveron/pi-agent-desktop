"use client";

import { useEffect, useState } from "react";
import { useFileContextMenu } from "@/hooks/useFileContextMenu";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import { setTurnFilePatch } from "@/lib/turn-file-patches";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

function LineStats({ added, removed }: { added?: number; removed?: number }) {
  if (added === undefined && removed === undefined) return null;
  return (
    <span className="turn-files-stats">
      <span className="turn-files-added">+{added ?? 0}</span>
      <span className="turn-files-removed">−{removed ?? 0}</span>
    </span>
  );
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4.5 2.5 8 6 4.5 9.5" />
    </svg>
  );
}

/**
 * Paths of `filePaths` the files API reports as gone. A turn's written files
 * are history: a later command (a skill's render step cleaning its draft, a
 * `git checkout`) can remove one, and the row should say so before it is
 * clicked. Only a 404 counts; any other answer leaves the row as it was.
 */
function useMissingFiles(filePaths: string[], sessionId?: string): Set<string> {
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const key = filePaths.join("\n");
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    Promise.all(key.split("\n").map(async (filePath) => {
      const params = new URLSearchParams({ type: "meta" });
      if (sessionId) params.set("sessionId", sessionId);
      try {
        const response = await fetch(`/api/files/${encodeFilePathForApi(filePath)}?${params}`, { signal: controller.signal });
        return response.status === 404 ? filePath : null;
      } catch {
        return null;
      }
    })).then((results) => {
      if (controller.signal.aborted) return;
      setMissing(new Set(results.filter((filePath): filePath is string => filePath !== null)));
    });
    return () => controller.abort();
  }, [key, sessionId]);
  return missing;
}

/**
 * Card under a turn's reply listing the files it actually wrote, with the
 * lines each one gained and lost. A row opens the file in the preview pane;
 * right-click offers the native Open / Open With / Reveal menu. Entries come
 * from the turn's successful `write`/`edit`/`apply_patch` tool calls — the
 * reply text is never scanned for paths. Rows whose file has since been
 * removed are marked; clicking one still opens the viewer, which explains it.
 */
export function TurnWrittenFiles({ files, onOpenFile, sessionId }: {
  files: WrittenFile[];
  onOpenFile?: (filePath: string) => void;
  sessionId?: string;
}) {
  const { t } = useI18n();
  // Hand the turn's own edit diff to the viewer before opening, so its Diff
  // mode shows what the tool changed (and clears an older turn's diff).
  const patchByPath = new Map(files.map((file) => [file.filePath, file.patch]));
  const openFile = (filePath: string) => {
    setTurnFilePatch(filePath, patchByPath.get(filePath));
    onOpenFile?.(filePath);
  };
  const showFileMenu = useFileContextMenu(onOpenFile ? openFile : undefined);
  const [expanded, setExpanded] = useState(true);
  const missing = useMissingFiles(files.map((file) => file.filePath), sessionId);
  if (files.length === 0) return null;

  const counted = files.filter((file) => file.added !== undefined || file.removed !== undefined);
  const totalAdded = counted.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const totalRemoved = counted.reduce((sum, file) => sum + (file.removed ?? 0), 0);

  return (
    <div className="turn-files-card" aria-label={t("chat.filesWritten")}>
      <button
        type="button"
        className="turn-files-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <svg className="turn-files-header-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
          <rect x="1.5" y="1.5" width="11" height="11" rx="2" />
          <path d="M7 3.8v4M5 5.8h4M5 10h4" />
        </svg>
        <span className="turn-files-title">
          {files.length === 1 ? t("chat.filesEditedOne") : t("chat.filesEditedMany", { count: files.length })}
        </span>
        {counted.length > 0 && <LineStats added={totalAdded} removed={totalRemoved} />}
        <Chevron className="turn-files-chevron" />
      </button>
      {expanded && files.map(({ filePath, added, removed }) => {
        const name = getFileName(filePath);
        const isMissing = missing.has(filePath);
        return (
          <button
            key={filePath}
            type="button"
            className={`turn-files-row${isMissing ? " is-missing" : ""}`}
            title={isMissing ? `${filePath}\n${t("files.notFound")}` : filePath}
            aria-label={t("chat.openWrittenFile", { name })}
            onClick={() => openFile(filePath)}
            onContextMenu={(event) => showFileMenu(event, { filePath })}
          >
            <span className="turn-files-icon">{getFileIcon(name, 14)}</span>
            <span className="turn-files-name">{name}</span>
            {isMissing && <span className="turn-files-missing">{t("chat.writtenFileMissing")}</span>}
            <LineStats added={added} removed={removed} />
            <Chevron className="turn-files-row-chevron" />
          </button>
        );
      })}
    </div>
  );
}
