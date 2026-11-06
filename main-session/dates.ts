// Calendar helpers. The live service counts days in local time; /replay counts them in UTC so
// its result does not depend on the machine's timezone. Both go through a DayClock.

export interface DayClock {
  /** Calendar day ('YYYY-MM-DD') an instant falls on. */
  day(iso: string | Date): string;
  /** The instant of `hour:minute` on a calendar day. */
  at(day: string, hour: number, minute?: number): Date;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export const localClock: DayClock = {
  day(value) {
    const d = typeof value === "string" ? new Date(value) : value;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
  at(day, hour, minute = 0) {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d, hour, minute);
  },
};

export const utcClock: DayClock = {
  day(value) {
    const d = typeof value === "string" ? new Date(value) : value;
    return d.toISOString().slice(0, 10);
  },
  at(day, hour, minute = 0) {
    return new Date(`${day}T${pad(hour)}:${pad(minute)}:00.000Z`);
  },
};

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/** Whole calendar days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

export function addDays(day: string, n: number): string {
  return new Date((dayNumber(day) + n) * 86_400_000).toISOString().slice(0, 10);
}

function isWeekend(day: string): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Working days (Mon–Fri) after `a` up to and including `b`. */
export function workdaysBetween(a: string, b: string): number {
  let n = 0;
  for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (!isWeekend(d)) n++;
  return n;
}

const ISO_DAY = /\b(20\d{2})-(\d{2})-(\d{2})\b/;

/** A date a condition names: 'date 2026-11-01', 'on/after 2026-10-29', '2026-10-29'. */
export function parseDateCondition(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = ISO_DAY.exec(text);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}
