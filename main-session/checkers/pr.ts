// PR checker: `gh pr view <ref> --json state,mergedAt,reviewDecision,statusCheckRollup`.

import type { PrCheck, Task } from "../types.ts";
import type { Exec } from "./exec.ts";

interface RollupItem {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

/** Summarise statusCheckRollup: any failure fails, anything unfinished is pending. */
export function summarizeChecks(rollup: RollupItem[] | null | undefined): PrCheck["checks"] {
  if (!rollup || rollup.length === 0) return "none";
  let pending = false;
  for (const item of rollup) {
    const verdict = (item.conclusion || item.state || "").toUpperCase();
    const status = (item.status || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(verdict)) return "fail";
    if ((status && status !== "COMPLETED") || verdict === "PENDING" || verdict === "EXPECTED" || verdict === "") pending = true;
  }
  return pending ? "pending" : "pass";
}

export function parsePrView(json: string, ref: string, now: string): PrCheck {
  const data = JSON.parse(json) as { state?: string; mergedAt?: string | null; reviewDecision?: string | null; statusCheckRollup?: RollupItem[] };
  return {
    ref,
    state: (data.state ?? "UNKNOWN").toUpperCase(),
    mergedAt: data.mergedAt || null,
    reviewDecision: data.reviewDecision || null,
    checks: summarizeChecks(data.statusCheckRollup),
    at: now,
  };
}

export interface PrTarget {
  /** Stable key in task.checks.prs. */
  ref: string;
  /** Arguments after `gh pr view`. */
  args: string[];
}

/** PR references of a task: 'pr:#752', 'pr:owner/repo#752', 'pr:https://…/pull/752', aliases '#752'. */
export function prTargets(task: Task): PrTarget[] {
  const out = new Map<string, PrTarget>();
  const sources = [...task.artifacts.filter((a) => a.startsWith("pr:")).map((a) => a.slice(3).trim()), ...task.aliases.filter((a) => a.startsWith("pr:") || a.startsWith("#")).map((a) => a.replace(/^pr:/, ""))];
  for (const raw of sources) {
    const url = /^(https?:\/\/[^\s/]+)\/([^\s/]+)\/([^\s/]+)\/pull\/(\d+)/.exec(raw);
    if (url) {
      out.set(`${url[2]}/${url[3]}#${url[4]}`, { ref: `${url[2]}/${url[3]}#${url[4]}`, args: [raw.split(/\s/)[0]] });
      continue;
    }
    const repoRef = /^([\w.-]+\/[\w.-]+)#(\d+)/.exec(raw);
    if (repoRef) {
      const ref = `${repoRef[1]}#${repoRef[2]}`;
      if (!out.has(ref)) out.set(ref, { ref, args: [repoRef[2], "--repo", repoRef[1]] });
      continue;
    }
    const bare = /^#?(\d+)\b/.exec(raw);
    if (bare && task.repo) {
      const already = [...out.keys()].some((k) => k.endsWith(`#${bare[1]}`));
      if (!already) out.set(`#${bare[1]}`, { ref: `#${bare[1]}`, args: [bare[1]] });
    }
  }
  return [...out.values()];
}

const FIELDS = "state,mergedAt,reviewDecision,statusCheckRollup";

export async function checkPr(task: Task, target: PrTarget, exec: Exec, now: string): Promise<PrCheck | undefined> {
  const result = await exec("gh", ["pr", "view", ...target.args, "--json", FIELDS], { ...(task.repo ? { cwd: task.repo } : {}), timeoutMs: 30_000 });
  if (result.code !== 0) return undefined;
  try {
    return parsePrView(result.stdout, target.ref, now);
  } catch {
    return undefined;
  }
}

/** A short description of what changed between two PR states, or undefined when nothing did. */
export function describePrChange(before: PrCheck | undefined, after: PrCheck): string | undefined {
  if (!before) return after.state === "OPEN" ? undefined : `PR ${after.ref} ${after.state.toLowerCase()}`;
  const parts: string[] = [];
  if (before.state !== after.state) parts.push(`${before.state.toLowerCase()} → ${after.state.toLowerCase()}`);
  if (before.checks !== after.checks) parts.push(`CI ${after.checks}`);
  if ((before.reviewDecision ?? "") !== (after.reviewDecision ?? "")) parts.push(`review ${after.reviewDecision ?? "none"}`);
  return parts.length ? `PR ${after.ref}: ${parts.join(", ")}` : undefined;
}
