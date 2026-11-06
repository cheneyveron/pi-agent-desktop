// Branch checker: has the task's branch reached its remote? `git ls-remote --heads origin <b>`
// in the task's repository. A failing command (offline, no VPN) reports nothing.

import type { BranchCheck, Task } from "../types.ts";
import type { Exec } from "./exec.ts";

/** Parse `git ls-remote --heads` output: the sha of refs/heads/<branch>, if listed. */
export function parseLsRemote(output: string, branch: string): string | undefined {
  for (const line of output.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref === `refs/heads/${branch}`) return sha;
  }
  return undefined;
}

export async function checkBranch(task: Task, exec: Exec, now: string): Promise<BranchCheck | undefined> {
  if (!task.branch || !task.repo) return undefined;
  const result = await exec("git", ["ls-remote", "--heads", "origin", task.branch], { cwd: task.repo, timeoutMs: 20_000 });
  if (result.code !== 0) return undefined;
  const sha = parseLsRemote(result.stdout, task.branch);
  return { state: sha ? "pushed" : "local-only", ...(sha ? { sha } : {}), at: now };
}
