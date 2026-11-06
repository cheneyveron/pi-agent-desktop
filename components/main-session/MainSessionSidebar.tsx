"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { answerTask, archiveTask, startTaskSession, useMainSession } from "@/hooks/useMainSession";
import { ageLabel, newCount, rowOf, sortRows, type RowView } from "./main-session-helpers";

/** The pinned 主会话 entry under New Session; the dot means new items need the user since the last visit. */
export function MainSessionSidebarRow({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  const state = useMainSession();
  const unread = useMemo(
    () => newCount(state.tasks.need.map((task) => rowOf(task, "need", state.seen))),
    [state.seen, state.tasks.need],
  );
  return (
    <button
      type="button"
      className={`sidebar-header-row sidebar-main-session-row${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      title={t("mainSession.title")}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
      </svg>
      <span className="sidebar-main-session-label">{t("mainSession.title")}</span>
      {unread > 0 && <span className="sidebar-main-session-dot" role="img" aria-label={t("mainSession.unread")} />}
      <span className="sidebar-main-session-pin">{t("mainSession.pinned")}</span>
    </button>
  );
}

interface SectionProps {
  /** The main-session page is shown: the section folds to its header by default. */
  mainSessionOpen: boolean;
  onOpenTask: (taskId: string) => void;
  onSessionStarted?: (sessionId: string) => void;
  fallbackCwd: string | null;
}

/** Up/Down move through the sidebar tree rows, like the tree's own rows. */
function moveInTree(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = Array.from(event.currentTarget.closest(".sidebar-project-tree")?.querySelectorAll<HTMLElement>("[data-sidebar-tree-row]") ?? []);
  const index = rows.indexOf(event.currentTarget);
  if (index < 0) return;
  event.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
}

/** "需要你 (N)": the open questions, with open-session / reply / archive on each row. */
export function NeedsYouSection({ mainSessionOpen, onOpenTask, onSessionStarted, fallbackCwd }: SectionProps) {
  const { t } = useI18n();
  const state = useMainSession();
  const [openOnPage, setOpenOnPage] = useState(false);
  const [openElsewhere, setOpenElsewhere] = useState(true);
  const [replyId, setReplyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const rows = useMemo(
    () => sortRows(state.tasks.need.map((task) => rowOf(task, "need", state.seen))),
    [state.seen, state.tasks.need],
  );
  // Switching back to a session unfolds the section again.
  useEffect(() => {
    if (!mainSessionOpen) setOpenOnPage(false);
  }, [mainSessionOpen]);

  if (state.status !== "ready" || (rows.length === 0 && !state.lastAnswer)) return null;
  const expanded = mainSessionOpen ? openOnPage : openElsewhere;
  const toggle = () => (mainSessionOpen ? setOpenOnPage(!openOnPage) : setOpenElsewhere(!openElsewhere));
  const last = state.lastAnswer;

  const start = async (row: RowView) => {
    setError(null);
    try {
      const sessionId = await startTaskSession(row.id, fallbackCwd);
      onSessionStarted?.(sessionId);
    } catch (err) {
      setError(t("mainSession.openFailed", { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <div className="ms-sidebar-section">
      <div className="sidebar-project-tree-header ms-sidebar-header">
        <button
          type="button"
          className="sidebar-chats-title"
          data-sidebar-tree-row
          aria-expanded={expanded}
          title={t(expanded ? "mainSession.sidebar.collapse" : "mainSession.sidebar.expand")}
          onClick={toggle}
          onKeyDown={moveInTree}
        >
          <span className="ms-sidebar-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span className="sidebar-project-tree-title">{t("mainSession.needsYou")}</span>
          <span className="ms-sidebar-count" aria-label={t("mainSession.needsYouCount", { count: rows.length })}>{rows.length}</span>
        </button>
        {expanded && <span className="ms-sidebar-hint">{t("mainSession.needsYouHint")}</span>}
      </div>
      {last && (
        <div className="ms-sidebar-last">
          {t("mainSession.sidebar.last", { task: last.label, word: last.word, dest: t(`mainSession.segment.${last.segment}`) })}
        </div>
      )}
      {error && <div className="ms-sidebar-error" role="alert">{error}</div>}
      {expanded && (
        <div className="ms-sidebar-rows">
          {rows.map((row) => (
            <div key={row.id} className={`ms-sidebar-item${replyId === row.id ? " is-open" : ""}`}>
              <button
                type="button"
                className="ms-sidebar-row"
                data-sidebar-tree-row
                onClick={() => onOpenTask(row.id)}
                onKeyDown={moveInTree}
                title={row.text}
              >
                <span className="ms-sidebar-id">{row.label}</span>
                <span className="ms-sidebar-title">{row.line1}</span>
                {row.immediate
                  ? <span className="ms-immediate-tag">{t("mainSession.immediate")}</span>
                  : <span className="ms-sidebar-age">{ageLabel(row.at, now, t)}</span>}
              </button>
              <div className="ms-sidebar-actions">
                <button type="button" onClick={() => void start(row)}>{t("mainSession.openSession")}</button>
                <button type="button" aria-expanded={replyId === row.id} onClick={() => setReplyId(replyId === row.id ? null : row.id)}>{t("mainSession.sidebar.reply")}</button>
                <button type="button" onClick={() => void archiveTask(row.id, row.label)}>{t("mainSession.sidebar.archive")}</button>
              </div>
              {replyId === row.id && (
                <SidebarReply
                  row={row}
                  onDone={() => setReplyId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarReply({ row, onDone }: { row: RowView; onDone: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const send = (word: string) => {
    if (!word.trim()) return;
    onDone();
    void answerTask(row.id, word.trim(), row.label);
  };
  return (
    <div className="ms-sidebar-reply">
      <div className="ms-sidebar-reply-hint">{t("mainSession.sidebar.oneWord")}</div>
      {row.chips.length > 0 && (
        <div className="ms-chips">
          {row.chips.map((word) => (
            <button key={word} type="button" className="ms-chip ms-chip--primary" onClick={() => send(word)}>{word}</button>
          ))}
        </div>
      )}
      <div className="ms-reply">
        <input
          ref={inputRef}
          className="ms-input"
          value={text}
          placeholder={t("mainSession.sidebar.orWrite")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              send(text);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onDone();
            }
          }}
        />
        <button type="button" className="ms-button ms-button--primary" disabled={!text.trim()} onClick={() => send(text)}>{t("mainSession.replySend")}</button>
      </div>
    </div>
  );
}
