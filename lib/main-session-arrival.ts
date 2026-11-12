// Why the main-session page sent the user into a work session: a card shown above that
// session's composer until the user sends a message, closes it, or opens another session.
// Client memory only: nothing here is written to the session file or sent to the model.

import { useSyncExternalStore } from "react";
import { buildContextMessage, type Task } from "./main-session-client";

export interface TaskArrival {
  sessionId: string;
  taskId: string;
  /** What the list calls the task (its id, or its title for generated ids). */
  label: string;
  title: string;
  /** The open question the user was sent here to settle, in full. */
  question?: string;
  /** Where the task stands, when there is no question to show. */
  stands?: string;
  /** Up to three pending steps. */
  next: string[];
  chips: string[];
  /** The ask event the chips answer. */
  eventId?: string;
  /** The context pack, for "put the background into the composer". */
  context: string;
}

let current: TaskArrival | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function arrivalOf(task: Task, sessionId: string, label: string, contextPack?: string): TaskArrival {
  return {
    sessionId,
    taskId: task.id,
    label,
    title: task.title,
    ...(task.ask?.text ? { question: task.ask.text } : {}),
    ...(!task.ask?.text && task.stands ? { stands: task.stands } : {}),
    next: task.next.filter((step) => !step.done).slice(0, 3).map((step) => step.text),
    chips: task.ask?.chips ?? [],
    ...(task.ask?.eventId ? { eventId: task.ask.eventId } : {}),
    context: buildContextMessage(task, contextPack),
  };
}

export function setTaskArrival(arrival: TaskArrival): void {
  current = arrival;
  shownInItsSession = false;
  emit();
}

/** Drop the card; with a session id, only when the card belongs to that session. */
export function clearTaskArrival(sessionId?: string): void {
  if (!current || (sessionId && current.sessionId !== sessionId)) return;
  current = null;
  emit();
}

let shownInItsSession = false;

/**
 * A session's chat was mounted. The card's own session marks it as shown; any other session
 * shown after that means the user has left, and the card goes.
 */
export function sessionShown(sessionId: string | undefined): void {
  if (!current || !sessionId) return;
  if (current.sessionId === sessionId) shownInItsSession = true;
  else if (shownInItsSession) clearTaskArrival();
}

export function getTaskArrival(): TaskArrival | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const none = () => null;

/** The card for this session, if the main-session page just sent the user here. */
export function useTaskArrival(sessionId: string | undefined): TaskArrival | null {
  const arrival = useSyncExternalStore(subscribe, getTaskArrival, none);
  return arrival && sessionId && arrival.sessionId === sessionId ? arrival : null;
}
