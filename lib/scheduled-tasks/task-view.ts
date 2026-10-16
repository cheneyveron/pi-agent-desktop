import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { nextCronRun } from "./cron";
import { listRuns } from "./store";
import type { ScheduledTask, ScheduledTaskView } from "./types";

export function toTaskView(task: ScheduledTask, now = new Date(), agentDir = getAgentDir()): ScheduledTaskView {
  const runs = listRuns(task.id, agentDir);
  let nextRunAt: string | null = null;
  if (task.enabled) {
    if (task.schedule.kind === "cron") {
      try {
        nextRunAt = nextCronRun(task.schedule.expr, task.schedule.timezone, now)?.toISOString() ?? null;
      } catch {
        nextRunAt = null;
      }
    } else if (task.schedule.kind === "once") {
      nextRunAt = task.schedule.at;
    }
  }
  const finished = runs.filter((run) => run.status !== "running" && run.status !== "skipped");
  return {
    ...task,
    nextRunAt,
    lastRun: runs.length ? runs[runs.length - 1] : null,
    unreadRuns: finished.filter((run) => run.sessionId && !run.seenAt).length,
  };
}
