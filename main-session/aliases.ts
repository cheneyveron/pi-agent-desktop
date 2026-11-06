// Ids a task can be known by, and matching a close-out to a task through them.
//
// Strong ids (ticket, org/group/biz guid, branch) identify a task on their own. A bare PR
// number ('#752') is weak: numbers repeat across repositories, so it only matches a task in
// the same repository (or one whose repository is unknown).

import type { Closeout, Task } from "./types.ts";

const DEFAULT_PREFIXES = ["CAS", "PCT", "EAI", "TM", "VRTS", "CECP", "CEGP", "SEG", "EMS", "BIZ", "OM", "SEC", "OPS"];

function ticketPrefixes(): string[] {
  const extra = process.env.MAIN_SESSION_TICKET_PREFIXES?.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean) ?? [];
  return [...new Set([...DEFAULT_PREFIXES, ...extra])];
}

function ticketRegex(): RegExp {
  return new RegExp(`\\b(?:CVE-\\d{4}-\\d{4,}|(?:${ticketPrefixes().join("|")})-\\d{2,})\\b`, "gi");
}

const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LABELLED_GUID = /\b(org|group|biz|company)[\s:=_-]*(?:id[\s:=]*)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const PR_URL = /https?:\/\/[^\s/]+\/([^\s/]+)\/([^\s/]+)\/pull\/(\d+)/gi;
const PR_HASH = /(?:\bPR\s*#?|(?<![\w/])#)(\d{1,6})\b/gi;
const BRANCH_IN_TEXT = /\b(?:cheney|feat|fix|bug|chore|hotfix|release)\/[\w.\-/]+[\w]/g;

export function normalizeTicket(id: string): string {
  return id.toUpperCase();
}

export function extractTickets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ticketRegex())) {
    const id = normalizeTicket(m[0]);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Labelled guids ('org 773e0cdf-…', 'group: …') as 'org:<guid>' style aliases. */
export function extractLabelledGuids(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LABELLED_GUID)) {
    const kind = m[1].toLowerCase() === "company" ? "org" : m[1].toLowerCase();
    const alias = `${kind}:${m[2].toLowerCase()}`;
    if (!out.includes(alias)) out.push(alias);
  }
  return out;
}

export function extractGuids(text: string): string[] {
  return [...new Set([...text.matchAll(GUID)].map((m) => m[0].toLowerCase()))];
}

export interface PrRef {
  /** 'owner/repo' when known from a URL. */
  repo?: string;
  number: number;
}

export function extractPrRefs(text: string): PrRef[] {
  const out: PrRef[] = [];
  const seen = new Set<string>();
  const add = (ref: PrRef) => {
    const key = `${ref.repo ?? ""}#${ref.number}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  const withoutUrls = text.replace(PR_URL, (_all, owner: string, repo: string, n: string) => {
    add({ repo: `${owner}/${repo}`, number: Number(n) });
    return " ";
  });
  for (const m of withoutUrls.matchAll(PR_HASH)) add({ number: Number(m[1]) });
  return out;
}

export function extractBranches(text: string): string[] {
  return [...new Set([...text.matchAll(BRANCH_IN_TEXT)].map((m) => m[0]))];
}

/** 'branch:<name> (note)' artifacts carry the branch name before any whitespace. */
export function branchFromArtifact(artifact: string): string | undefined {
  const m = /^branch:\s*([^\s(（]+)/.exec(artifact);
  if (!m) return undefined;
  const name = m[1];
  // A path is a local clone, not a branch name.
  if (name.startsWith("/") || name.startsWith("~")) return undefined;
  return name;
}

export function repoName(cwdOrRepo: string | undefined): string | undefined {
  if (!cwdOrRepo) return undefined;
  const trimmed = cwdOrRepo.replace(/[/\\]+$/, "");
  const base = trimmed.split(/[/\\]/).pop();
  return base || undefined;
}

export interface CloseoutIds {
  tickets: string[];
  guids: string[];
  branches: string[];
  prs: PrRef[];
}

function closeoutText(c: Closeout): string {
  return [
    c.thread,
    c.stands,
    ...c.next.map((n) => `${n.text} ${n.on ?? ""}`),
    ...c.open.map((o) => `${o.question} ${o.then ?? ""}`),
    ...c.produced,
  ].join("\n");
}

export function idsOfCloseout(c: Closeout): CloseoutIds {
  const text = closeoutText(c);
  const branches = [
    ...c.produced.map(branchFromArtifact).filter((b): b is string => Boolean(b)),
    ...extractBranches(text),
  ];
  return {
    tickets: extractTickets(text),
    guids: extractLabelledGuids(text),
    branches: [...new Set(branches)],
    prs: extractPrRefs(text),
  };
}

/** Aliases a close-out contributes to its task (excluding the task's own id). */
export function aliasesOfCloseout(c: Closeout): string[] {
  const ids = idsOfCloseout(c);
  return [
    ...ids.tickets,
    ...ids.guids,
    ...ids.branches.map((b) => `branch:${b}`),
    ...ids.prs.map((p) => p.repo ? `pr:${p.repo}#${p.number}` : `#${p.number}`),
  ];
}

function norm(alias: string): string {
  return alias.trim().toLowerCase();
}

export function taskHasAlias(task: Task, alias: string): boolean {
  const target = norm(alias);
  return norm(task.id) === target || task.aliases.some((a) => norm(a) === target);
}

export function addAliases(task: Task, aliases: string[]): boolean {
  let changed = false;
  for (const alias of aliases) {
    if (!alias || taskHasAlias(task, alias)) continue;
    task.aliases.push(alias);
    changed = true;
  }
  return changed;
}

/** Find the task an explicit id names (task id or any alias). */
export function findByAlias(tasks: Iterable<Task>, id: string): Task | undefined {
  for (const task of tasks) if (taskHasAlias(task, id)) return task;
  return undefined;
}

export interface MatchResult {
  task?: Task;
  /** Why it matched, for the assign event. */
  via?: string;
  /** Other tasks that matched as strongly, for the judge to consider merging. */
  ties: string[];
}

function sameRepo(task: Task, cwd: string | undefined, prRepo: string | undefined): boolean {
  if (prRepo) {
    if (task.aliases.some((a) => norm(a).startsWith(`pr:${norm(prRepo)}#`))) return true;
    const name = prRepo.split("/").pop();
    return !task.repo || repoName(task.repo) === name;
  }
  return !task.repo || !cwd || repoName(task.repo) === repoName(cwd);
}

/**
 * Match a close-out to an existing task.
 * Order: a session the task already holds, the declared thread, then shared ids scored
 * ticket/guid 3, branch 2, same-repo PR 1. Ties go to the most recently updated task.
 */
export function matchCloseout(tasks: Task[], c: Closeout): MatchResult {
  const bySession = tasks.find((t) => t.sessions.includes(c.sessionId) && t.status !== "archived")
    ?? tasks.find((t) => t.sessions.includes(c.sessionId));
  if (bySession) return { task: bySession, via: `session ${c.sessionId}`, ties: [] };

  const thread = c.thread?.trim();
  if (thread && thread !== "none" && !thread.startsWith("new:")) {
    const named = findByAlias(tasks, thread) ?? (() => {
      const ticket = extractTickets(thread)[0];
      return ticket ? findByAlias(tasks, ticket) : undefined;
    })();
    if (named) return { task: named, via: `thread ${thread}`, ties: [] };
    // A declared ticket nobody tracks yet is a new task, even if the close-out also
    // mentions a related ticket that is tracked (CAS-4764 citing P1 PCT-121470).
    if (extractTickets(thread).length > 0) return { ties: [] };
  }

  const ids = idsOfCloseout(c);
  const scores = new Map<Task, { score: number; via: string[] }>();
  const bump = (task: Task, points: number, via: string) => {
    const entry = scores.get(task) ?? { score: 0, via: [] };
    entry.score += points;
    entry.via.push(via);
    scores.set(task, entry);
  };
  for (const task of tasks) {
    for (const ticket of ids.tickets) if (taskHasAlias(task, ticket)) bump(task, 3, ticket);
    for (const guid of ids.guids) if (taskHasAlias(task, guid)) bump(task, 3, guid);
    for (const branch of ids.branches) if (taskHasAlias(task, `branch:${branch}`) || task.branch === branch) bump(task, 2, `branch ${branch}`);
    for (const pr of ids.prs) {
      const alias = pr.repo ? `pr:${pr.repo}#${pr.number}` : `#${pr.number}`;
      const hit = taskHasAlias(task, alias) || (pr.repo && taskHasAlias(task, `#${pr.number}`));
      if (hit && sameRepo(task, c.cwd, pr.repo)) bump(task, 1, `PR #${pr.number}`);
    }
  }
  if (scores.size === 0) return { ties: [] };
  const ranked = [...scores.entries()].sort((a, b) =>
    b[1].score - a[1].score || b[0].updatedAt.localeCompare(a[0].updatedAt));
  const [best, bestScore] = ranked[0];
  // A lone weak match (one PR number) is not enough to attach a close-out to a task.
  if (bestScore.score < 2) return { ties: [] };
  const ties = ranked.slice(1).filter(([, s]) => s.score === bestScore.score).map(([t]) => t.id);
  return { task: best, via: bestScore.via.join(", "), ties };
}

/** Id for a task created from a close-out, following the contract's preference order. */
export function newTaskId(c: Closeout, existing: (id: string) => boolean): string {
  const ids = idsOfCloseout(c);
  const slug = c.thread?.startsWith("new:") ? c.thread.slice(4).trim() : "";
  const repo = repoName(c.cwd) ?? "local";
  const candidates = [
    ...ids.tickets,
    ...ids.guids,
    ...ids.branches.map((b) => `repo:${repo}:${b}`),
    ...(slug ? [`repo:${repo}:${slug}`] : []),
    `session:${c.sessionId}`,
  ];
  for (const id of candidates) if (!existing(id)) return id;
  let n = 2;
  while (existing(`${candidates[0]}-${n}`)) n++;
  return `${candidates[0]}-${n}`;
}
