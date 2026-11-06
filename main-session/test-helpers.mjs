// Shared test setup: an in-memory store and an action context with a settable clock.

import { utcClock } from "./dates.ts";
import { createArraySink } from "./memory.ts";
import { Store } from "./store.ts";

export function makeCtx(start = "2026-11-02T13:00:00.000Z") {
  let now = new Date(start);
  const emitted = [];
  const memory = createArraySink();
  const ctx = {
    store: new Store(null),
    now: () => now,
    clock: utcClock,
    emit: (type, data) => emitted.push({ type, data }),
    memory,
  };
  return {
    ctx,
    emitted,
    memory,
    setNow(iso) { now = new Date(iso); },
    advance(ms) { now = new Date(now.getTime() + ms); },
  };
}

export function closeout(extra = {}) {
  return {
    sessionId: "s-1", cwd: "/work/cas-account", t: "2026-11-02T10:00:00.000Z", thread: "none",
    stands: "", next: [], produced: [], learned: [], user_said: [], open: [], ...extra,
  };
}

export function task(id, extra = {}) {
  return {
    id, aliases: [], title: id, status: "watch", stands: "", next: [], waits: [], artifacts: [],
    sessions: [], open: [], log: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...extra,
  };
}

export const HOUR = 3_600_000;
