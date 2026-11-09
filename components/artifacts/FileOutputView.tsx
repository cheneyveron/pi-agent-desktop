"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { ArtifactType } from "@/lib/artifacts";
import type { FileOutputDetail, FileOutputOpInfo, FileOutputSummary } from "@/lib/artifact-index";
import type { FileOutputRole } from "@/lib/file-output-role";
import { ArtifactView } from "../ArtifactView";
import { FileViewer } from "../FileViewer";

interface Props {
  item: FileOutputSummary;
  /** Opens the conversation scrolled to the entry. Resolves false when the session is gone. */
  onOpenInConversation: (sessionId: string, entryId: string) => Promise<boolean>;
  /** The user moved the file into or out of the outputs; the list reloads. */
  onRoleChange: () => void;
}

type Detail =
  | { status: "loading" }
  | { status: "ready"; detail: FileOutputDetail }
  | { status: "missing" | "error"; error?: string };

type Snapshot = { toolCallId: string; content: string } | { toolCallId: string; failed: true } | null;

/** How a written file shows when it is gone from disk: as the artifact type it resembles. */
function snapshotType(path: string): { type: ArtifactType; lang: string } {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "html" || ext === "htm") return { type: "html", lang: "html" };
  if (ext === "svg") return { type: "svg", lang: "svg" };
  if (ext === "md" || ext === "markdown") return { type: "markdown", lang: "markdown" };
  if (ext === "mmd" || ext === "mermaid") return { type: "mermaid", lang: "mermaid" };
  return { type: "code", lang: ext };
}

/**
 * A file the model wrote or edited (or one a reply handed over): the file as
 * it is on disk now, read through /api/files with the latest writing session
 * as the reference that authorizes the path, plus every recorded write and
 * edit. When the file is gone, the last `write` call's content comes back
 * from the transcript. The user can move it into or out of the outputs.
 */
export function FileOutputView({ item, onOpenInConversation, onRoleChange }: Props) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<Detail>({ status: "loading" });
  const [snapshot, setSnapshot] = useState<Snapshot>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [roleBusy, setRoleBusy] = useState(false);
  const revision = `${item.versionCount}:${item.updated}:${item.missing}`;

  useEffect(() => {
    const controller = new AbortController();
    setActionError(null);
    fetch(`/api/artifacts/file?${new URLSearchParams({ path: item.path })}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as FileOutputDetail & { error?: string };
        if (response.status === 404) {
          setState({ status: "missing" });
          return;
        }
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        setState({ status: "ready", detail: data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [item.path, revision]);

  const detail = state.status === "ready" ? state.detail : null;
  const ops = useMemo(() => (detail ? [...detail.ops].reverse() : []), [detail]);
  const lastWrite = ops.find((op) => op.tool === "write");
  const gone = detail ? detail.missing : item.missing;

  useEffect(() => {
    if (!gone || !lastWrite) {
      setSnapshot(null);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ session: lastWrite.sessionId, toolCallId: lastWrite.toolCallId });
    fetch(`/api/artifacts/file?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { content?: string };
        if (!response.ok || typeof data.content !== "string") throw new Error(`HTTP ${response.status}`);
        setSnapshot({ toolCallId: lastWrite.toolCallId, content: data.content });
      })
      .catch(() => {
        if (!controller.signal.aborted) setSnapshot({ toolCallId: lastWrite.toolCallId, failed: true });
      });
    return () => controller.abort();
  }, [gone, lastWrite]);

  async function setRole(role: FileOutputRole | null) {
    setActionError(null);
    setRoleBusy(true);
    try {
      const response = await fetch("/api/artifacts/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: item.path, role }),
      });
      const data = await response.json() as FileOutputDetail & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setState({ status: "ready", detail: data });
      onRoleChange();
    } catch (error) {
      setActionError(t("artifacts.page.roleFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setRoleBusy(false);
    }
  }

  async function openOp(op: FileOutputOpInfo) {
    setActionError(null);
    if (!(await onOpenInConversation(op.sessionId, op.entryId))) setActionError(t("artifacts.page.sessionMissing"));
  }

  const root = item.projectRoot ?? item.cwd;
  const snapshotVersions = useMemo(() => {
    if (!snapshot || !("content" in snapshot) || !lastWrite) return undefined;
    return [{ title: item.title, ...snapshotType(item.path), content: snapshot.content, complete: true }];
  }, [snapshot, lastWrite, item.title, item.path]);

  let body;
  if (!gone) {
    body = <FileViewer key={`${item.path}:${revision}`} filePath={item.path} cwd={root} sourceSessionId={item.sessionId} watchEnabled={false} />;
  } else if (snapshotVersions) {
    body = (
      <>
        <p className="scheduled-hint artifacts-file-note">{t("artifacts.page.fileGoneSnapshot")}</p>
        <div className="artifacts-detail-body">
          <ArtifactView identifier={item.path} title={item.title} versions={snapshotVersions} holdActiveContent emptyMessage="" />
        </div>
      </>
    );
  } else {
    const loadingSnapshot = state.status === "loading" || (lastWrite && !snapshot);
    body = (
      <div className="artifacts-detail-empty">
        <p>{loadingSnapshot ? t("artifacts.page.loadingItem") : t("artifacts.page.fileGone")}</p>
      </div>
    );
  }

  const role = detail?.role ?? item.role;
  const override = detail ? detail.override : item.override;

  return (
    <>
      <div className="artifacts-file-header">
        <span className="artifacts-file-path" title={item.path}>{item.displayPath}</span>
        <div className="artifacts-file-role">
          <button
            type="button"
            className="scheduled-button scheduled-button--small"
            disabled={roleBusy}
            onClick={() => void setRole(role === "output" ? "process" : "output")}
          >
            {role === "output" ? t("artifacts.page.markProcess") : t("artifacts.page.markOutput")}
          </button>
          {override && (
            <button type="button" className="scheduled-button scheduled-button--small" disabled={roleBusy} onClick={() => void setRole(null)}>
              {t("artifacts.page.resetRole")}
            </button>
          )}
        </div>
        {state.status === "missing" && <p className="scheduled-hint">{t("artifacts.page.fileUnavailable")}</p>}
        {state.status === "error" && <p className="scheduled-error">{t("artifacts.page.loadFailed", { error: state.error ?? "" })}</p>}
        {ops.length > 0 && (
          <details className="artifacts-file-history">
            <summary>{t("artifacts.page.fileHistory", { count: ops.length })}</summary>
            <ol>
              {ops.map((op) => {
                const label = op.onActiveBranch ? t("artifacts.page.openInConversation") : t("artifacts.page.otherBranchHint");
                return (
                  <li key={op.toolCallId}>
                    <span className="artifacts-file-op">
                      {op.tool === "write" ? t("artifacts.page.opWrite") : op.tool === "edit" ? t("artifacts.page.opEdit") : t("artifacts.page.opMention")}
                    </span>
                    <span className="artifacts-file-op-session" title={op.sessionTitle}>{op.sessionTitle}</span>
                    <span className="artifacts-file-op-time">{formatRelativeTime(op.timestamp, locale)}</span>
                    <button
                      type="button"
                      className="scheduled-button scheduled-button--small"
                      disabled={!op.onActiveBranch}
                      title={label}
                      onClick={() => void openOp(op)}
                    >
                      {t("artifacts.page.openShort")}
                    </button>
                  </li>
                );
              })}
            </ol>
          </details>
        )}
        {actionError && <p className="scheduled-error" role="alert">{actionError}</p>}
      </div>
      <div className="artifacts-detail-body">{body}</div>
    </>
  );
}
