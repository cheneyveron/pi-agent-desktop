"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  answerTask,
  archiveTask,
  beginVisit,
  dismissUndo,
  endVisit,
  refreshMainSession,
  sendMainChat,
  openTaskSession,
  undoLast,
  useMainSession,
  type MainChatMessage,
} from "@/hooks/useMainSession";
import { answerSessionDialog, stopSessionRun, useSessionActivity } from "@/hooks/useSessionActivity";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import { SEGMENTS, type Segment, type Task } from "@/lib/main-session-client";
import {
  cardStateOf,
  clampListHeight,
  goesToSession,
  type CardState,
  focusAfterRemoval,
  modelNotice,
  moveFocus,
  newCount,
  resolveTask,
  rowOf,
  segmentOf,
  clockTime,
  dayKey,
  dayLabel,
  shortTime,
  sortRows,
  suggestions,
  type RowView,
} from "./main-session-helpers";
import { MainSessionModelPicker, MainSessionThinkingPicker } from "./MainSessionModelPicker";
import { MainSessionRow, type RowMenuAction } from "./MainSessionRow";
import { TaskText } from "./TaskText";

interface Props {
  /** Task to locate when the page opens (`?view=main&task=`). */
  focusTask?: string | null;
  /** Open an existing session; resolves false when it cannot be found. */
  onOpenSession: (sessionId: string) => Promise<boolean> | void;
  /** A work session was created for a task. */
  onSessionStarted: (sessionId: string) => void;
  /** Folder for a task session when the task names no absolute repo path. */
  fallbackCwd: string | null;
}

const LEAVE_MS = 200;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function readListHeight(): number | null {
  const value = Number(getPref(APP_PREF_KEYS.mainSessionListHeight));
  return Number.isFinite(value) && value > 0 ? value : null;
}

const IDLE_CARD: CardState = { kind: "idle" };

export function MainSessionView({ focusTask, onOpenSession, onSessionStarted, fallbackCwd }: Props) {
  const { t, locale } = useI18n();
  const state = useMainSession();
  const [segment, setSegment] = useState<Segment>("need");
  const [collapsed, setCollapsed] = useState(false);
  const [onlyNew, setOnlyNew] = useState<Record<Segment, boolean>>({ need: false, watch: false, done: false });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [replyId, setReplyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const [flashId, setFlashId] = useState<string | null>(null);
  const [listHeight, setListHeight] = useState<number | null>(readListHeight);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const visited = useRef(new Set<Segment>(["need"]));
  const wantFocus = useRef(false);

  // "New" is measured against the seen marks from when this visit began.
  // Frozen once the lists have loaded, so marks from before the load never stand in.
  const ready = state.status === "ready";
  useEffect(() => {
    if (ready) beginVisit();
  }, [ready]);
  useEffect(() => {
    const visitedSegments = visited.current;
    return () => { void endVisit(visitedSegments); };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const seen = state.visitSeen ?? state.seen;
  const activity = useSessionActivity(state.status === "ready");
  // Tasks answered on this visit whose answer went on to their work session.
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const rowsBySegment = useMemo(() => {
    const result = {} as Record<Segment, RowView[]>;
    for (const s of SEGMENTS) result[s] = sortRows(state.tasks[s].map((task) => rowOf(task, s, seen)));
    // Cards that are the user's to look at although nothing is asked: one just answered (held to
    // show what the session makes of it), and one whose session waits for an approval.
    const extra = state.tasks.watch
      .map((task) => rowOf(task, "need", seen))
      .filter((row) => held.has(row.id) || cardStateOf(row, activity).kind === "approval");
    // First: these are the ones something is happening on.
    if (extra.length) result.need = [...extra, ...result.need];
    return result;
  }, [state.tasks, seen, held, activity]);
  const allTasks = useMemo<Task[]>(() => SEGMENTS.flatMap((s) => state.tasks[s]), [state.tasks]);
  const rows = rowsBySegment[segment];
  const visibleRows = useMemo(
    () => (onlyNew[segment] ? rows.filter((row) => row.isNew) : rows),
    [onlyNew, rows, segment],
  );
  const visibleIds = useMemo(() => visibleRows.filter((row) => !leaving.has(row.id)).map((row) => row.id), [visibleRows, leaving]);

  const switchSegment = useCallback((next: Segment) => {
    visited.current.add(next);
    if (next === segment) {
      setCollapsed((value) => !value);
      return;
    }
    setSegment(next);
    setCollapsed(false);
    setFocusId(null);
    setMenuId(null);
    setReplyId(null);
  }, [segment]);

  const locate = useCallback((id: string, options: { focus?: boolean } = {}) => {
    const task = resolveTask(allTasks, id);
    if (!task) return false;
    const target = segmentOf(task);
    visited.current.add(target);
    setSegment(target);
    setCollapsed(false);
    setOnlyNew((value) => ({ ...value, [target]: false }));
    setFocusId(task.id);
    setFlashId(task.id);
    wantFocus.current = options.focus !== false;
    return true;
  }, [allTasks]);

  // A task named by the URL (sidebar row, notification, note in a session).
  const located = useRef<string | null>(null);
  useEffect(() => {
    if (!focusTask || located.current === focusTask || state.status !== "ready") return;
    if (locate(focusTask)) located.current = focusTask;
  }, [focusTask, locate, state.status]);

  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(timer);
  }, [flashId]);

  // Keep the focused row on screen inside the list (the only list scroll area).
  useLayoutEffect(() => {
    if (!wantFocus.current || !focusId) return;
    const element = listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(focusId)}"]`);
    if (!element) return;
    wantFocus.current = false;
    element.focus({ preventScroll: true });
    const list = listRef.current!;
    const r = element.getBoundingClientRect();
    const p = list.getBoundingClientRect();
    if (r.top < p.top) list.scrollTop -= p.top - r.top + 6;
    else if (r.bottom > p.bottom) list.scrollTop += r.bottom - p.bottom + 6;
  });

  // New messages scroll the conversation to the bottom.
  const lastMessage = state.chat[state.chat.length - 1];
  useEffect(() => {
    const element = conversationRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.chat.length, lastMessage?.pending]);

  /** Slide the row out, then commit; focus moves to the next row. */
  const commit = useCallback((id: string, run: () => Promise<unknown>) => {
    const next = focusAfterRemoval(visibleIds, id);
    setMenuId(null);
    setReplyId(null);
    const finish = () => {
      void run().finally(() => {
        setLeaving((value) => {
          const copy = new Set(value);
          copy.delete(id);
          return copy;
        });
      });
      setFocusId(next);
      wantFocus.current = true;
    };
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    setLeaving((value) => new Set(value).add(id));
    setTimeout(finish, LEAVE_MS);
  }, [visibleIds]);

  const labelOf = useCallback((id: string) => rows.find((row) => row.id === id)?.label ?? id, [rows]);

  const handleAnswer = useCallback((id: string, word: string) => {
    const row = rows.find((r) => r.id === id);
    if (row?.canContinue && goesToSession(word)) {
      // The answer starts a run in the task's session: the card stays to show it.
      setHeld((value) => new Set(value).add(id));
      setReplyId(null);
      setMenuId(null);
      void answerTask(id, word, labelOf(id));
      return;
    }
    commit(id, () => answerTask(id, word, labelOf(id)));
  }, [commit, labelOf, rows]);

  const handleDismiss = useCallback((id: string) => {
    setHeld((value) => {
      const copy = new Set(value);
      copy.delete(id);
      return copy;
    });
  }, []);

  const handleStop = useCallback((sessionId: string) => {
    setOpenError(null);
    void stopSessionRun(sessionId).catch((error) => setOpenError(t("mainSession.card.actionFailed", { error: error instanceof Error ? error.message : String(error) })));
  }, [t]);

  const handleDialog = useCallback((sessionId: string, dialogId: string, confirmed: boolean) => {
    setOpenError(null);
    void answerSessionDialog(sessionId, dialogId, confirmed).catch((error) => setOpenError(t("mainSession.card.actionFailed", { error: error instanceof Error ? error.message : String(error) })));
  }, [t]);

  const handleArchive = useCallback((id: string) => {
    commit(id, () => archiveTask(id, labelOf(id)));
  }, [commit, labelOf]);

  // The task's existing session when it has one; a new one (with the context pack) only when it
  // has none, or when the user asks for a fresh one from the row menu.
  const handleOpenTaskSession = useCallback(async (id: string, fresh = false) => {
    setOpenError(null);
    try {
      const opened = await openTaskSession(id, fallbackCwd, { fresh });
      if (opened.created) onSessionStarted(opened.sessionId);
      else void onOpenSession(opened.sessionId);
    } catch (error) {
      setOpenError(t("mainSession.openFailed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [fallbackCwd, onOpenSession, onSessionStarted, t]);

  const handleOpenExisting = useCallback((sessionId: string) => {
    void onOpenSession(sessionId);
  }, [onOpenSession]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((value) => {
      const copy = new Set(value);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  }, []);

  const handleMenuAction = useCallback((id: string, action: RowMenuAction) => {
    if (action === "reply") setReplyId(id);
    else if (action === "archive") handleArchive(id);
    else if (action === "details") toggleExpanded(id);
    else if (action === "session") {
      const row = rows.find((r) => r.id === id);
      if (row?.sessionId) handleOpenExisting(row.sessionId);
    } else if (action === "newSession") void handleOpenTaskSession(id, true);
  }, [handleArchive, handleOpenExisting, handleOpenTaskSession, rows, toggleExpanded]);

  const handleTask = useCallback((ref: string) => {
    locate(ref);
  }, [locate]);

  const handleFocusRow = useCallback((id: string) => {
    setFocusId(id);
    setMenuId(null);
  }, []);

  // Keyboard triage: j/k 1/2/3 o e Enter Esc while the page is shown.
  const keyState = useRef({ visibleIds, focusId, rows, segment, menuId, replyId, expanded });
  keyState.current = { visibleIds, focusId, rows, segment, menuId, replyId, expanded };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (target?.closest?.("[role='menu'], [role='dialog'], .session-sidebar")) return;
      if (document.querySelector("[aria-modal='true']")) return;
      const s = keyState.current;
      const key = event.key;
      if (key === "Escape") {
        if (!s.menuId && !s.focusId && !s.replyId && s.expanded.size === 0) return;
        event.preventDefault();
        setMenuId(null);
        setFocusId(null);
        setReplyId(null);
        setExpanded(new Set());
        if (document.activeElement instanceof HTMLElement && rootRef.current?.contains(document.activeElement)) document.activeElement.blur();
        return;
      }
      if (key === "j" || key === "k") {
        const next = moveFocus(s.visibleIds, s.focusId, key === "j" ? 1 : -1);
        if (!next) return;
        event.preventDefault();
        setFocusId(next);
        setMenuId(null);
        wantFocus.current = true;
        return;
      }
      if (!s.focusId) return;
      const row = s.rows.find((r) => r.id === s.focusId);
      if (!row) return;
      if (/^[123]$/.test(key)) {
        const word = row.chips[Number(key) - 1];
        if (!word) return;
        event.preventDefault();
        handleAnswer(row.id, word);
      } else if (key === "o") {
        event.preventDefault();
        if (s.segment === "need") void handleOpenTaskSession(row.id);
        else if (row.sessionId) handleOpenExisting(row.sessionId);
      } else if (key === "e" && s.segment === "need") {
        event.preventDefault();
        handleArchive(row.id);
      } else if (key === "Enter" && target?.dataset?.rowId === row.id) {
        event.preventDefault();
        toggleExpanded(row.id);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleAnswer, handleArchive, handleOpenExisting, handleOpenTaskSession, toggleExpanded]);

  // Drag the handle between list and conversation; the height is a preference.
  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const list = listRef.current;
    const column = rootRef.current;
    if (!list || !column) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = list.getBoundingClientRect().height;
    const columnHeight = column.getBoundingClientRect().height;
    let latest = startHeight;
    setDragging(true);
    const move = (e: PointerEvent) => {
      latest = clampListHeight(startHeight + e.clientY - startY, columnHeight);
      setListHeight(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      setDragging(false);
      setPref(APP_PREF_KEYS.mainSessionListHeight, String(Math.round(latest)));
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onResizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const column = rootRef.current?.getBoundingClientRect().height ?? 600;
    const current = listRef.current?.getBoundingClientRect().height ?? 200;
    const next = clampListHeight(current + (event.key === "ArrowDown" ? 24 : -24), column);
    setListHeight(next);
    setPref(APP_PREF_KEYS.mainSessionListHeight, String(next));
  };

  const jumpToFirstNew = (target: Segment) => {
    visited.current.add(target);
    const first = rowsBySegment[target].find((row) => row.isNew);
    setSegment(target);
    setCollapsed(false);
    if (first) {
      setFocusId(first.id);
      setFlashId(first.id);
      wantFocus.current = true;
    }
  };

  if (state.status === "offline" || state.status === "error") {
    return (
      <div className="main-session-view" ref={rootRef}>
        <div className="ms-offline" role="status">
          <b>{state.status === "offline" ? t("mainSession.offline") : t("mainSession.error", { error: state.error ?? "" })}</b>
          {state.status === "offline" && <p>{t("mainSession.offlineHint")}</p>}
          <button type="button" className="ms-button" onClick={() => void refreshMainSession(true)}>{t("mainSession.retry")}</button>
        </div>
      </div>
    );
  }

  const undo = state.undo;
  const undoTask = undo ? allTasks.find((task) => task.id === undo.taskId) : undefined;
  const undoText = undo
    ? undo.kind === "archive"
      ? t("mainSession.undo.archived", { task: undo.label })
      : t("mainSession.undo.answered", {
        task: undo.label,
        word: undo.word ?? "",
        dest: t(undoTask && segmentOf(undoTask) === "done" ? "mainSession.dest.done" : "mainSession.dest.watch"),
      })
    : "";
  const sug = state.chat.length < 6 ? suggestions(rowsBySegment.need, t) : [];
  // No model chosen (or its last turn failed): a notice with the picker under the band.
  // Otherwise the picker sits in the band, so the choice can be changed from here.
  const notice = modelNotice(state.service);
  const listStyle = listHeight ? { height: listHeight, maxHeight: "none", flex: `0 0 ${listHeight}px` } : undefined;

  return (
    <div className={`main-session-view${dragging ? " is-resizing" : ""}`} ref={rootRef} data-find-zone="chat">
      <div className="ms-band">
        <div className="ms-segments" role="tablist" aria-label={t("mainSession.segments")}>
          {SEGMENTS.map((s) => {
            // The tasks in the segment: a card held in the list after its answer is not counted twice.
            const count = state.tasks[s].length;
            const fresh = newCount(rowsBySegment[s]);
            const on = s === segment;
            return (
              <div key={s} className={`ms-segment ms-segment--${s}${on ? " is-active" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  className="ms-segment-main"
                  aria-selected={on}
                  aria-expanded={on ? !collapsed : undefined}
                  aria-controls="main-session-list"
                  title={on ? t(collapsed ? "mainSession.expandList" : "mainSession.collapseList") : t("mainSession.switchSegment")}
                  onClick={() => switchSegment(s)}
                >
                  <span>{t(`mainSession.segment.${s}`)}</span>
                  <b className="ms-segment-count">{count}</b>
                  {on && <span className="ms-caret" aria-hidden="true">{collapsed ? "▾" : "▴"}</span>}
                </button>
                <button
                  type="button"
                  className={`ms-since${fresh ? "" : " is-zero"}`}
                  title={t("mainSession.sinceTitle", { time: seen[s] ? shortTime(seen[s]) : "—" })}
                  onClick={() => jumpToFirstNew(s)}
                >
                  {fresh ? t("mainSession.since", { count: fresh }) : t("mainSession.sinceNone")}
                </button>
              </div>
            );
          })}
        </div>
        {state.fixture && <span className="ms-fixture-tag">{t("mainSession.fixtureBadge")}</span>}
        {notice === "none" && state.service?.model?.ref && (
          <div className="ms-model">
            <span className="ms-model-label">{t("mainSession.model.label")}</span>
            <MainSessionModelPicker />
            <MainSessionThinkingPicker />
          </div>
        )}
        <span className="ms-key-hints" aria-hidden="true">
          <kbd>j</kbd><kbd>k</kbd><span className="ms-key-label"> {t("mainSession.keys.move")} ·</span>{" "}
          <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><span className="ms-key-label"> {t("mainSession.keys.answer")} ·</span>{" "}
          <kbd>o</kbd><span className="ms-key-label"> {t("mainSession.keys.open")} ·</span>{" "}
          <kbd>e</kbd><span className="ms-key-label"> {t("mainSession.keys.archive")} ·</span>{" "}
          <kbd>Esc</kbd><span className="ms-key-label"> {t("mainSession.keys.clear")}</span>
        </span>
      </div>
      {undo && (
        <div className="ms-undo" role="status">
          <span className="ms-undo-text">{undoText}</span>
          <UndoCountdown until={undo.until} onDone={dismissUndo} />
          <button type="button" className="ms-button ms-undo-button" onClick={() => void undoLast()}>{t("mainSession.undo.button")}</button>
        </div>
      )}
      {notice !== "none" && (
        <div className={`ms-model-bar ms-model-bar--${notice}`} role="status">
          <span className="ms-model-bar-text">
            {notice === "missing" ? t("mainSession.model.needs") : t("mainSession.model.failed", { error: state.service?.lastError ?? "" })}
          </span>
          <MainSessionModelPicker />
        </div>
      )}
      {state.modelError && (
        <div className="ms-error" role="alert">{t("mainSession.model.saveFailed", { error: state.modelError })}</div>
      )}
      {(state.actionError || openError) && (
        <div className="ms-error" role="alert">
          {openError ?? t("mainSession.actionFailed", { error: state.actionError ?? "" })}
        </div>
      )}
      {!collapsed && (
        <div className="ms-list" id="main-session-list" ref={listRef} style={listStyle}>
          <div className="ms-list-inner">
            <div className="ms-list-header">
              <b>{t("mainSession.listHeader", { segment: t(`mainSession.segment.${segment}`), count: state.tasks[segment].length })}</b>
              <span>{t("mainSession.lastSeen", { time: seen[segment] ? shortTime(seen[segment]) : "—", count: newCount(rows) })}</span>
              <button
                type="button"
                role="switch"
                aria-checked={onlyNew[segment]}
                className={`ms-toggle${onlyNew[segment] ? " is-on" : ""}`}
                onClick={() => setOnlyNew((value) => ({ ...value, [segment]: !value[segment] }))}
              >
                <i aria-hidden="true" />{t("mainSession.onlyNew")}
              </button>
            </div>
            {state.status === "loading" || state.status === "idle" ? (
              <div className="ms-empty">{t("mainSession.loading")}</div>
            ) : visibleRows.length === 0 ? (
              <div className="ms-empty">
                {onlyNew[segment] ? t("mainSession.emptyOnlyNew") : segment === "need" ? t("mainSession.emptyNeed") : t("mainSession.emptyOther")}
              </div>
            ) : (
              <div role="list">
                {visibleRows.map((row, index) => {
                  const separator = !onlyNew[segment] && !row.isNew && index > 0 && visibleRows[index - 1].isNew;
                  return (
                    <div key={row.id}>
                      {separator && <div className="ms-separator">{t("mainSession.olderSeparator")}</div>}
                      <MainSessionRow
                        row={row}
                        segment={segment}
                        now={now}
                        focused={focusId === row.id}
                        expanded={expanded.has(row.id)}
                        leaving={leaving.has(row.id)}
                        flash={flashId === row.id}
                        menuOpen={menuId === row.id}
                        replying={replyId === row.id}
                        activity={segment === "done" ? IDLE_CARD : cardStateOf(row, activity)}
                        held={held.has(row.id)}
                        onStop={handleStop}
                        onDialog={handleDialog}
                        onDismiss={handleDismiss}
                        onFocusRow={handleFocusRow}
                        onAnswer={handleAnswer}
                        onOpenSession={(id) => void handleOpenTaskSession(id)}
                        onOpenExisting={handleOpenExisting}
                        onToggleMenu={setMenuId}
                        onMenuAction={handleMenuAction}
                        onReply={handleAnswer}
                        onCancelReply={() => setReplyId(null)}
                        onTask={handleTask}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      {!collapsed && (
        <div
          className={`ms-resizer${dragging ? " is-dragging" : ""}`}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("mainSession.resize")}
          aria-controls="main-session-list"
          title={t("mainSession.resize")}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
        />
      )}
      <div className="ms-conversation" ref={conversationRef}>
        <div className="ms-conversation-inner">
          {state.chat.length === 0 && <div className="ms-conversation-empty">{t("mainSession.chatEmpty")}</div>}
          {state.chat.map((message, index) => {
            const day = dayKey(message.at);
            const newDay = day !== "" && (index === 0 || day !== dayKey(state.chat[index - 1].at));
            return (
              <Fragment key={message.id}>
                {newDay && <div className="ms-day" role="separator">{dayLabel(message.at, now, t, locale)}</div>}
                <ChatMessage message={message} onTask={handleTask} onOpenSession={handleOpenExisting} />
              </Fragment>
            );
          })}
        </div>
      </div>
      <div className="ms-composer">
        <div className="ms-composer-inner">
          {sug.length > 0 && (
            <div className="ms-suggestions">
              {sug.map((text) => (
                <button key={text} type="button" className="ms-chip" disabled={state.chatBusy} onClick={() => void sendMainChat(text)}>{text}</button>
              ))}
            </div>
          )}
          <form
            className="ms-composer-box"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.trim()) return;
              void sendMainChat(draft);
              setDraft("");
            }}
          >
            <input
              className="ms-composer-input"
              value={draft}
              placeholder={t("mainSession.composerPlaceholder")}
              aria-label={t("mainSession.composerPlaceholder")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  event.currentTarget.blur();
                }
              }}
            />
            <button type="submit" className="ms-button ms-button--primary" disabled={!draft.trim() || state.chatBusy}>{t("mainSession.send")}</button>
          </form>
        </div>
      </div>
    </div>
  );
}

function UndoCountdown({ until, onDone }: { until: number; onDone: () => void }) {
  const { t } = useI18n();
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - Date.now()) / 1000)));
  useEffect(() => {
    const tick = () => {
      const next = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(next);
      if (next <= 0) onDone();
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [onDone, until]);
  return <span className="ms-undo-count">{t("mainSession.undo.seconds", { count: left })}</span>;
}

function ChatMessage({ message, onTask, onOpenSession }: {
  message: MainChatMessage;
  onTask: (ref: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  if (message.who === "you") {
    return (
      <div className="ms-message ms-message--you">
        <div className="ms-message-who">{t("mainSession.you")} · {clockTime(message.at)}</div>
        <div className="ms-bubble">{message.text}</div>
      </div>
    );
  }
  const cites = message.cites ?? [];
  return (
    <div className="ms-message ms-message--main">
      <span className="ms-badge">{t("mainSession.badge")}</span>
      <div className="ms-message-body">
        <div className="ms-message-who">
          {clockTime(message.at)}
          {message.actions?.map((action) => <span key={action.id} className="ms-event-action">{action.action}</span>)}
        </div>
        {message.pending && !message.text ? (
          <div className="ms-thinking">{t("mainSession.thinking")}</div>
        ) : message.pending ? (
          <div className="ms-streaming"><TaskText text={message.text} onTask={onTask} /></div>
        ) : message.error ? (
          <div className="ms-error-text">{t("mainSession.chatFailed", { error: message.error })}</div>
        ) : (
          <div><TaskText text={message.text} onTask={onTask} /></div>
        )}
        {cites.length > 0 && (
          <div className="ms-cite">
            {t("mainSession.basis")}
            {cites.map((cite, index) => (
              <span key={index}>
                {index > 0 && " · "}
                {cite.sessionId && (
                  <button type="button" className="ms-task-link" onClick={() => onOpenSession(cite.sessionId!)}>{t("mainSession.cite.session")}</button>
                )}
                {cite.sessionId && cite.task && " · "}
                {cite.task && (
                  <button type="button" className="ms-task-link" onClick={() => onTask(cite.task!)}>{t("mainSession.cite.task", { task: cite.task })}</button>
                )}
                {!cite.task && !cite.sessionId && cite.eventId && <span className="ms-event-action">{cite.eventId}</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
