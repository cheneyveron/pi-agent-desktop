"use client";

import { useEffect } from "react";
import { useI18n } from "@/hooks/useI18n";
import { answerTask } from "@/hooks/useMainSession";
import { clearTaskArrival, sessionShown, useTaskArrival } from "@/lib/main-session-arrival";
import { openMainSessionPage } from "@/lib/main-session-client";

interface Props {
  sessionId: string | undefined;
  /** Send a message into this session (the composer's own send). */
  onSend: (text: string) => void;
  /** Put text into the composer without sending it. */
  onInsert: (text: string) => void;
}

/**
 * Shown above the composer when the main-session page opened this session for a task:
 * what the user came to settle, and the answers. Temporary: it is never part of the
 * session, and goes away on send, on close, and when the user opens another session.
 */
export function ArrivalCard({ sessionId, onSend, onInsert }: Props) {
  const { t } = useI18n();
  const arrival = useTaskArrival(sessionId);

  // The chat is mounted once per session, so this runs when a session comes on screen.
  useEffect(() => sessionShown(sessionId), [sessionId]);

  if (!arrival) return null;
  const close = () => clearTaskArrival(arrival.sessionId);
  const answer = (word: string) => {
    // The work session gets the decision as a message; the main session records it.
    onSend(word);
    void answerTask(arrival.taskId, word, arrival.label);
    close();
  };

  return (
    <div className="ms-arrival" role="note" aria-label={t("mainSession.arrival.title")} data-arrival-task={arrival.taskId}>
      <div className="ms-arrival-head">
        <b>{t("mainSession.arrival.title")}</b>
        <button type="button" className="ms-task-link" onClick={() => openMainSessionPage(arrival.taskId)}>{arrival.label}</button>
        {arrival.title && arrival.title !== arrival.label && <span className="ms-arrival-title">{arrival.title}</span>}
        <span className="ms-arrival-hint">{t("mainSession.arrival.hint")}</span>
        <button type="button" className="ms-arrival-close" aria-label={t("i18n.close")} title={t("i18n.close")} onClick={close}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <dl className="ms-arrival-fields">
        {arrival.question && (<><dt>{t("mainSession.arrival.question")}</dt><dd>{arrival.question}</dd></>)}
        {arrival.stands && (<><dt>{t("mainSession.arrival.stands")}</dt><dd>{arrival.stands}</dd></>)}
        {arrival.next.length > 0 && (<><dt>{t("mainSession.arrival.next")}</dt><dd>{arrival.next.join("；")}</dd></>)}
      </dl>
      <div className="ms-arrival-actions">
        {arrival.chips.map((word) => (
          <button key={word} type="button" className="ms-chip ms-chip--primary" onClick={() => answer(word)}>{word}</button>
        ))}
        <button type="button" className="ms-small-button" onClick={() => onInsert(arrival.context)}>{t("mainSession.arrival.insert")}</button>
        <button type="button" className="ms-link ms-arrival-back" onClick={() => openMainSessionPage(arrival.taskId)}>{t("mainSession.arrival.back")}</button>
      </div>
    </div>
  );
}
