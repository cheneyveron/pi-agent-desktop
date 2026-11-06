"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { postCloseoutCard } from "@/hooks/useMainSession";
import { MainSessionError, openMainSessionPage } from "@/lib/main-session-client";
import type { CustomMessage } from "@/lib/types";
import {
  applyCloseoutEdits,
  CLOSEOUT_FIELDS,
  closeoutFieldText,
  parseCloseoutMessage,
  parseMainSessionNote,
  shortTime,
  type CloseoutField,
} from "./main-session-helpers";
import { TaskText } from "./TaskText";

/** A textarea that grows with its content, drawn like the prototype's editable field. */
function FieldEditor({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="ms-closeout-field"
      value={value}
      rows={1}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

type SendState = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

/** The close-out card the extension records at the end of a session: every field editable, 交接 re-posts it. */
export function CloseoutCard({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const closeout = parseCloseoutMessage(message);
  const [edits, setEdits] = useState<Partial<Record<CloseoutField, string>>>({});
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  if (!closeout) return null;
  const edited = Object.keys(edits).length > 0;
  const time = closeout.t ? shortTime(closeout.t) : message.timestamp ? shortTime(new Date(message.timestamp).toISOString()) : "";

  const handoff = async () => {
    setSend({ kind: "sending" });
    try {
      await postCloseoutCard(applyCloseoutEdits(closeout, edits));
      setSend({ kind: "sent" });
    } catch (error) {
      const offline = error instanceof TypeError || (error instanceof MainSessionError && (error.status === 404 || error.status >= 502));
      setSend({ kind: "error", message: offline ? t("mainSession.closeout.offline") : t("mainSession.closeout.failed", { error: error instanceof Error ? error.message : String(error) }) });
    }
  };

  return (
    <div className="ms-closeout" data-closeout-session={closeout.sessionId}>
      <div className="ms-closeout-head">
        <b>{t("mainSession.closeout.title")}</b>
        {closeout.thread && closeout.thread !== "none" && (
          <button type="button" className="ms-task-link" onClick={() => openMainSessionPage(closeout.thread.replace(/^new:/, ""))}>{closeout.thread}</button>
        )}
        <span className="ms-closeout-hint">{time ? `${time} · ` : ""}{t("mainSession.closeout.hint")}</span>
      </div>
      <dl className="ms-closeout-fields">
        {CLOSEOUT_FIELDS.map((field) => {
          const original = closeoutFieldText(closeout, field);
          if (field === "next_time" && !original && edits.next_time === undefined) return null;
          return (
            <div key={field} className="ms-closeout-row">
              <dt>{field}</dt>
              <dd>
                <FieldEditor
                  label={field}
                  value={edits[field] ?? original}
                  onChange={(value) => {
                    setEdits((current) => ({ ...current, [field]: value }));
                    if (send.kind === "sent") setSend({ kind: "idle" });
                  }}
                />
              </dd>
            </div>
          );
        })}
      </dl>
      <div className="ms-closeout-actions">
        <button type="button" className="ms-button ms-button--primary" disabled={send.kind === "sending"} onClick={() => void handoff()}>
          {send.kind === "sending" ? t("mainSession.closeout.sending") : t("mainSession.closeout.handoff")}
        </button>
        {send.kind === "sent" ? (
          <span className="ms-answered">{t("mainSession.closeout.sent")}</span>
        ) : send.kind === "error" ? (
          <span className="ms-error-text" role="alert">{send.message}</span>
        ) : (
          <span className="ms-closeout-hint">{edited ? t("mainSession.closeout.edited") : t("mainSession.closeout.handoffHint")}</span>
        )}
      </div>
    </div>
  );
}

/** A note the main session inserted into this session: collapsible, its task opens the main-session page. */
export function MainSessionNote({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const note = parseMainSessionNote(message);
  const [open, setOpen] = useState(true);
  const time = message.timestamp ? shortTime(new Date(message.timestamp).toISOString()) : "";
  return (
    <div className={`ms-note${open ? " is-open" : ""}`}>
      <button type="button" className="ms-note-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ms-badge">{t("mainSession.badge")}</span>
        <span className="ms-event-action">insert</span>
        <span className="ms-note-summary">{open ? `${t("mainSession.note.label")}${time ? ` · ${time}` : ""}` : note.text.split("\n")[0]}</span>
        <span className="ms-note-toggle">{open ? t("mainSession.note.collapse") : t("mainSession.note.expand")}</span>
      </button>
      {open && (
        <div className="ms-note-body">
          <p><TaskText text={note.text} onTask={(ref) => openMainSessionPage(ref)} /></p>
          {note.task && (
            <button type="button" className="ms-link" onClick={() => openMainSessionPage(note.task)}>
              {t("mainSession.note.task", { task: note.task })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
