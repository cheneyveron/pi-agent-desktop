// Manual checker: schedules (reminders, timed read-only checks, follow-ups after a session).

import type { Schedule } from "../types.ts";

export function dueSchedules(schedules: Schedule[], nowIso: string): Schedule[] {
  return schedules.filter((s) => !s.firedAt && !s.cancelled && s.kind !== "after_session" && s.at <= nowIso);
}

export function afterSessionSchedules(schedules: Schedule[], sessionId: string): Schedule[] {
  return schedules.filter((s) => !s.firedAt && !s.cancelled && s.kind === "after_session" && s.sessionId === sessionId);
}
