"use client";

import { useState } from "react";
import { useFileContextMenu } from "@/hooks/useFileContextMenu";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
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
 * Card under a turn's reply listing the files it actually wrote, with the
 * lines each one gained and lost. A row opens the file in the preview pane;
 * right-click offers the native Open / Open With / Reveal menu. Entries come
 * from the turn's successful `write`/`edit`/`apply_patch` tool calls — the
 * reply text is never scanned for paths.
 */
export function TurnWrittenFiles({ files, onOpenFile }: {
  files: WrittenFile[];
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const showFileMenu = useFileContextMenu(onOpenFile);
  const [expanded, setExpanded] = useState(true);
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
        return (
          <button
            key={filePath}
            type="button"
            className="turn-files-row"
            title={filePath}
            aria-label={t("chat.openWrittenFile", { name })}
            onClick={() => onOpenFile?.(filePath)}
            onContextMenu={(event) => showFileMenu(event, { filePath })}
          >
            <span className="turn-files-icon">{getFileIcon(name, 14)}</span>
            <span className="turn-files-name">{name}</span>
            <LineStats added={added} removed={removed} />
            <Chevron className="turn-files-row-chevron" />
          </button>
        );
      })}
    </div>
  );
}
