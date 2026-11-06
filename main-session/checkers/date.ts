// Date checker: waits whose `until` has come and next steps whose condition names a date.

import { shortHash } from "../actions.ts";
import { parseDateCondition } from "../dates.ts";
import type { Task } from "../types.ts";

export interface DueItem {
  key: string;
  what: string;
  due: string;
}

/** Items of a task that are due on or before `today` ('YYYY-MM-DD'). */
export function dueItems(task: Task, today: string): DueItem[] {
  const out: DueItem[] = [];
  for (const wait of task.waits) {
    if (wait.closed || !wait.until) continue;
    const due = wait.until.slice(0, 10);
    if (due <= today) out.push({ key: `date:${task.id}:${shortHash(wait.what)}`, what: wait.what, due });
  }
  for (const item of task.next) {
    if (item.done) continue;
    const due = parseDateCondition(item.on);
    if (due && due <= today) out.push({ key: `date:${task.id}:${shortHash(item.text)}`, what: item.text, due });
  }
  return out;
}
