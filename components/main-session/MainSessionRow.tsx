"use client";

import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useMenuPlacement } from "@/hooks/useMenuPlacement";
import type { MenuAnchor } from "@/lib/menu-placement";
import { getMainSessionApi, type MainEvent, type Segment } from "@/lib/main-session-client";
import { ACTION_TAG, ageLabel, elapsedLabel, shortTime, type CardState, type RowView } from "./main-session-helpers";
import { TaskText } from "./TaskText";

export type RowMenuAction = "reply" | "archive" | "details" | "session" | "newSession";

interface Props {
  row: RowView;
  segment: Segment;
  now: number;
  focused: boolean;
  expanded: boolean;
  leaving: boolean;
  flash: boolean;
  menuOpen: boolean;
  replying: boolean;
  /** What the task's work session is doing right now. */
  activity: CardState;
  /** Kept in this list after an answer, to show what the session makes of it. */
  held: boolean;
  onStop: (sessionId: string) => void;
  onDialog: (sessionId: string, dialogId: string, confirmed: boolean) => void;
  onDismiss: (id: string) => void;
  onFocusRow: (id: string) => void;
  onAnswer: (id: string, word: string) => void;
  onOpenSession: (id: string) => void;
  onOpenExisting: (sessionId: string) => void;
  onToggleMenu: (id: string | null) => void;
  onMenuAction: (id: string, action: RowMenuAction) => void;
  onReply: (id: string, text: string) => void;
  onCancelReply: () => void;
  onTask: (ref: string) => void;
}

export const MainSessionRow = memo(function MainSessionRow({
  row, segment, now, focused, expanded, leaving, flash, menuOpen, replying, activity, held,
  onStop, onDialog, onDismiss, onFocusRow, onAnswer, onOpenSession, onOpenExisting, onToggleMenu, onMenuAction, onReply, onCancelReply, onTask,
}: Props) {
  const { t } = useI18n();
  const moreRef = useRef<HTMLButtonElement>(null);
  const actTag = ACTION_TAG[row.act] ?? "k-update";
  // What the card says about itself: a session state when there is one, else whose move it is.
  const stateKind = activity.kind === "idle" ? (segment === "need" && !held ? "need" : "watching")
    : activity.kind === "ended" ? `ended-${activity.outcome}` : activity.kind;
  const moreButton = (
    <button
      ref={moreRef}
      type="button"
      className={`ms-small-button ms-more${menuOpen ? " is-open" : ""}`}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label={t("mainSession.more")}
      title={t("mainSession.more")}
      onClick={() => onToggleMenu(menuOpen ? null : row.id)}
    >
      …
    </button>
  );
  const className = [
    "ms-row",
    segment === "done" ? "" : "ms-card",
    row.isNew ? "is-new" : "",
    expanded ? "is-expanded" : "",
    focused ? "is-focused" : "",
    leaving ? "is-leaving" : "",
    flash ? "is-flash" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={className}
      data-row-id={row.id}
      tabIndex={-1}
      role="listitem"
      aria-label={`${row.label} ${row.line1}`}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("button, input, textarea, a")) return;
        onFocusRow(row.id);
      }}
    >
      {segment === "done" ? (
        <>
          <div className="ms-row-main">
            <div className="ms-row-line1">
              <span className="ms-row-title"><TaskText text={row.line1} onTask={onTask} /></span>
            </div>
            <div className="ms-row-line2"><TaskText text={row.line2} onTask={onTask} /></div>
          </div>
          <div className="ms-row-side">
            <div className="ms-row-meta">
              <span className="ms-row-age">
                {row.isNew && <span className="ms-new-tag">{t("mainSession.new")}</span>}
                {shortTime(row.at).slice(0, 5)}
              </span>
              <span className={`ms-act-tag ${actTag}`}>{t(`mainSession.act.${row.act}`)}</span>
            </div>
            <div className="ms-row-controls">
              {row.sessionId && (
                <button type="button" className="ms-small-button" title={t("mainSession.openSessionKey")} onClick={() => onOpenExisting(row.sessionId!)}>{t("mainSession.session")}</button>
              )}
              {moreButton}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="ms-card-head">
            <button type="button" className="ms-task-link ms-row-id" onClick={() => onTask(row.id)}>{row.label}</button>
            {row.title && <span className="ms-card-title">{row.title}</span>}
            <span className={`ms-card-state is-${stateKind}`}>{t(`mainSession.card.state.${stateKind}`)}</span>
            {row.immediate && <span className="ms-immediate-tag">{t("mainSession.immediate")}</span>}
            {row.isNew && <span className="ms-new-tag">{t("mainSession.new")}</span>}
            <span className="ms-row-age">{ageLabel(row.at, now, t)}</span>
            {moreButton}
          </div>
          <div className={`ms-card-text${expanded ? " is-open" : ""}`}><TaskText text={row.text || row.line1} onTask={onTask} /></div>
          {row.answered && activity.kind === "idle" && (
            <div className="ms-answered">{t(held ? "mainSession.card.sent" : "mainSession.answered", { word: row.answered })}</div>
          )}
          {activity.kind === "running" && (
            <div className="ms-card-activity" role="status">
              <span className="ms-card-pulse" aria-hidden="true" />
              <span className="ms-card-step">{t("mainSession.card.step", { step: stepLabel(activity.step, t) })}</span>
              <Elapsed since={activity.since} />
              <button type="button" className="ms-small-button" onClick={() => onStop(activity.sessionId)}>{t("mainSession.card.stop")}</button>
            </div>
          )}
          {activity.kind === "approval" && (
            <div className="ms-card-approval" role="alert">
              <div className="ms-card-approval-title">{activity.title}</div>
              {activity.detail && <pre className="ms-card-approval-detail">{activity.detail}</pre>}
              {activity.confirmable ? (
                <div className="ms-card-approval-actions">
                  <button type="button" className="ms-chip ms-chip--primary" onClick={() => onDialog(activity.sessionId, activity.id!, true)}>{t("mainSession.card.allow")}</button>
                  <button type="button" className="ms-chip" onClick={() => onDialog(activity.sessionId, activity.id!, false)}>{t("mainSession.card.deny")}</button>
                </div>
              ) : (
                <button type="button" className="ms-link" onClick={() => onOpenExisting(activity.sessionId)}>{t("mainSession.card.answerInSession")}</button>
              )}
            </div>
          )}
          {activity.kind === "ended" && (
            <div className={`ms-card-result is-${activity.outcome}`}>
              <div className="ms-card-result-head">{t(`mainSession.card.ended.${activity.outcome}`)}</div>
              {(activity.error || activity.summary) && <div className="ms-card-result-text">{activity.error || activity.summary}</div>}
            </div>
          )}
          <div className="ms-card-foot">
            {activity.kind !== "approval" && row.chips.map((word, index) => (
              <button
                key={word}
                type="button"
                className="ms-chip ms-chip--primary"
                title={index < 3 ? t("mainSession.answerKey", { key: index + 1 }) : undefined}
                onClick={() => onAnswer(row.id, word)}
              >
                {word}
              </button>
            ))}
            <ReplyBox
              focus={replying}
              placeholder={t(!row.canContinue ? "mainSession.card.replyNote"
                : !row.sessionId ? "mainSession.card.replyNew"
                  : activity.kind === "running" ? "mainSession.card.replyQueued" : "mainSession.card.reply")}
              onSend={(text) => onReply(row.id, text)}
              onCancel={onCancelReply}
            />
            {held && <button type="button" className="ms-small-button" onClick={() => onDismiss(row.id)}>{t("mainSession.card.dismiss")}</button>}
            <button type="button" className="ms-link ms-card-open" title={t("mainSession.openSessionKey")} onClick={() => onOpenSession(row.id)}>
              {t(row.sessionId ? "mainSession.card.openSession" : "mainSession.openSession")}
            </button>
          </div>
        </>
      )}
      {menuOpen && (
        <RowMenu
          anchorRef={moreRef}
          segment={segment}
          expanded={expanded}
          hasSession={Boolean(row.sessionId)}
          onClose={() => onToggleMenu(null)}
          onAction={(action) => onMenuAction(row.id, action)}
        />
      )}
      {replying && segment === "done" && <ReplyBox focus placeholder={t("mainSession.replyPlaceholder")} onSend={(text) => onReply(row.id, text)} onCancel={onCancelReply} />}
      {expanded && <RowDetails row={row} segment={segment} onTask={onTask} onOpenExisting={onOpenExisting} />}
    </div>
  );
});

function RowMenu({ anchorRef, segment, expanded, hasSession, onClose, onAction }: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  segment: Segment;
  expanded: boolean;
  hasSession: boolean;
  onClose: () => void;
  onAction: (action: RowMenuAction) => void;
}) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const position = useMenuPlacement(anchor, menuRef);

  useEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.top, bottom: rect.bottom, right: rect.right });
  }, [anchorRef]);

  useEffect(() => {
    if (position) menuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']")?.focus();
  }, [position]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("resize", onScroll);
    };
  }, [anchorRef, onClose]);

  const items: Array<{ action: RowMenuAction; label: string; hint?: string }> = [];
  if (segment === "need") {
    items.push({ action: "reply", label: t("mainSession.menu.reply"), hint: t("mainSession.menu.replyHint") });
    items.push({ action: "archive", label: t("mainSession.menu.archive"), hint: "e" });
  }
  items.push({ action: "details", label: t(expanded ? "mainSession.menu.hideDetails" : "mainSession.menu.details"), hint: "Enter" });
  if (segment !== "need" && hasSession) items.push({ action: "session", label: t("mainSession.menu.openSession"), hint: "o" });
  // "Open session" shows the task's existing session; a second one is a deliberate choice.
  if (segment === "need" && hasSession) items.push({ action: "newSession", label: t("mainSession.menu.newSession") });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "Tab") {
      onClose();
    }
    event.nativeEvent.stopImmediatePropagation();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="native-popover app-menu main-session-row-menu"
      role="menu"
      aria-label={t("mainSession.more")}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        zIndex: 700,
        top: position?.top ?? anchor?.bottom ?? 0,
        left: position?.left ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className="main-session-menu-item"
          onClick={() => {
            onClose();
            onAction(item.action);
          }}
        >
          <span>{item.label}</span>
          {item.hint && <span className="main-session-menu-hint">{item.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

function ReplyBox({ onSend, onCancel, placeholder, focus }: { onSend: (text: string) => void; onCancel: () => void; placeholder: string; focus: boolean }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focus) inputRef.current?.focus(); }, [focus]);
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <div className="ms-reply">
      <input
        ref={inputRef}
        className="ms-input"
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            send();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.blur();
            onCancel();
          }
        }}
      />
      {text.trim() && <button type="button" className="ms-button ms-button--primary" onClick={send}>{t("mainSession.replySend")}</button>}
    </div>
  );
}

/** Time since a run started, ticking by the second. */
function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="ms-card-elapsed">{elapsedLabel(since, now)}</span>;
}

/** The step a run is on, in words: a tool by name, or what the agent is doing between tools. */
function stepLabel(step: string, t: (key: string) => string): string {
  return step === "thinking" || step === "compacting" || step === "retrying" ? t(`mainSession.card.activity.${step}`) : step;
}

function RowDetails({ row, segment, onTask, onOpenExisting }: {
  row: RowView;
  segment: Segment;
  onTask: (ref: string) => void;
  onOpenExisting: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const [events, setEvents] = useState<MainEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getMainSessionApi()
      .then((api) => api.getTask(row.id))
      .then((detail) => { if (!cancelled) setEvents(detail.events.filter((e) => e.auto).slice(0, 4)); })
      .catch(() => { if (!cancelled) setEvents([]); });
    return () => { cancelled = true; };
  }, [row.id]);

  return (
    <div className="ms-details">
      <div><b>{t(segment === "done" ? "mainSession.detail.did" : "mainSession.detail.text")}</b> <TaskText text={row.text} onTask={onTask} /></div>
      {row.why && (segment === "done" || row.answered) && <div><b>{t("mainSession.detail.why")}</b> <TaskText text={row.why} onTask={onTask} /></div>}
      {row.ifNot && <div><b>{t("mainSession.detail.ifNot")}</b> <TaskText text={row.ifNot} onTask={onTask} /></div>}
      {segment !== "done" && (
        <div><b>{t("mainSession.detail.task")}</b> <button type="button" className="ms-task-link" onClick={() => onTask(row.id)}>{row.label} ›</button></div>
      )}
      {row.sessions.length > 0 && (
        <div>
          <b>{t("mainSession.detail.sessions")}</b>{" "}
          {row.sessions.map((sessionId, index) => (
            <span key={sessionId}>
              {index > 0 && " · "}
              <button type="button" className="ms-task-link" onClick={() => onOpenExisting(sessionId)}>{sessionId.slice(0, 8)}</button>
            </span>
          ))}
        </div>
      )}
      <div>
        <b>{t("mainSession.detail.source")}</b> {row.source ? `${row.source} ` : ""}
        <span className="ms-event-action">{row.act}</span>
      </div>
      <div className="ms-details-log">
        <b>{t("mainSession.detail.log")}</b>
        {events === null ? (
          <div className="ms-empty">{t("mainSession.detail.loading")}</div>
        ) : events.length === 0 ? (
          <div className="ms-empty">{t("mainSession.detail.logEmpty")}</div>
        ) : (
          events.map((event) => (
            <div key={event.id} className="ms-log-row">
              <span className="ms-log-time">{shortTime(event.t)}</span>
              <span><span className={`ms-act-tag ${ACTION_TAG[event.action] ?? "k-update"}`}>{t(`mainSession.act.${event.action}`)}</span> <TaskText text={event.why} onTask={onTask} /></span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
