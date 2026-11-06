"use client";

import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useMenuPlacement } from "@/hooks/useMenuPlacement";
import type { MenuAnchor } from "@/lib/menu-placement";
import { getMainSessionApi, type MainEvent, type Segment } from "@/lib/main-session-client";
import { ACTION_TAG, ageLabel, shortTime, type RowView } from "./main-session-helpers";
import { TaskText } from "./TaskText";

export type RowMenuAction = "reply" | "archive" | "details" | "session";

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
  row, segment, now, focused, expanded, leaving, flash, menuOpen, replying,
  onFocusRow, onAnswer, onOpenSession, onOpenExisting, onToggleMenu, onMenuAction, onReply, onCancelReply, onTask,
}: Props) {
  const { t } = useI18n();
  const moreRef = useRef<HTMLButtonElement>(null);
  const actTag = ACTION_TAG[row.act] ?? "k-update";
  const className = [
    "ms-row",
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
      <div className="ms-row-main">
        <div className="ms-row-line1">
          {segment !== "done" && (
            <button type="button" className="ms-task-link ms-row-id" onClick={() => onTask(row.id)}>{row.label}</button>
          )}
          <span className="ms-row-title"><TaskText text={row.line1} onTask={onTask} /></span>
        </div>
        <div className="ms-row-line2">
          {row.answered && segment !== "done"
            ? <span className="ms-answered">{t("mainSession.answered", { word: row.answered })}{row.line2 ? ` · ${row.line2}` : ""}</span>
            : <TaskText text={row.line2} onTask={onTask} />}
        </div>
      </div>
      <div className="ms-row-side">
        <div className="ms-row-meta">
          <span className="ms-row-age">
            {row.isNew && <span className="ms-new-tag">{t("mainSession.new")}</span>}
            {row.immediate && <span className="ms-immediate-tag">{t("mainSession.immediate")}</span>}
            {segment === "need" ? ageLabel(row.at, now, t) : shortTime(row.at).slice(0, 5)}
          </span>
          <span className={`ms-act-tag ${actTag}`}>{t(`mainSession.act.${row.act}`)}</span>
        </div>
        <div className="ms-row-controls">
          {row.chips.map((word, index) => (
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
          {row.needsExecution ? (
            <button type="button" className="ms-chip ms-chip--primary" onClick={() => onOpenSession(row.id)}>{t("mainSession.openSessionExec")}</button>
          ) : segment === "need" ? (
            <button type="button" className="ms-small-button" title={t("mainSession.openSessionKey")} onClick={() => onOpenSession(row.id)}>{t("mainSession.openSession")}</button>
          ) : segment === "done" && row.sessionId ? (
            <button type="button" className="ms-small-button" title={t("mainSession.openSessionKey")} onClick={() => onOpenExisting(row.sessionId!)}>{t("mainSession.session")}</button>
          ) : null}
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
        </div>
      </div>
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
      {replying && <ReplyBox onSend={(text) => onReply(row.id, text)} onCancel={onCancelReply} />}
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

function ReplyBox({ onSend, onCancel }: { onSend: (text: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const send = () => {
    if (text.trim()) onSend(text.trim());
  };
  return (
    <div className="ms-reply">
      <input
        ref={inputRef}
        className="ms-input"
        value={text}
        placeholder={t("mainSession.replyPlaceholder")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            send();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <button type="button" className="ms-button ms-button--primary" disabled={!text.trim()} onClick={send}>{t("mainSession.replySend")}</button>
    </div>
  );
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
