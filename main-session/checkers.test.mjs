import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseLsRemote } from "./checkers/branch.ts";
import { dueItems } from "./checkers/date.ts";
import { runCheckers } from "./checkers/index.ts";
import { describePrChange, parsePrView, prTargets, summarizeChecks } from "./checkers/pr.ts";
import { schedule } from "./actions.ts";
import { makeCtx, task } from "./test-helpers.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const NOW = "2026-11-02T13:00:00.000Z";

test("ls-remote: the exact branch ref, not a prefix match", () => {
  const out = fixture("git-ls-remote.txt");
  assert.equal(parseLsRemote(out, "cheney/bug/CAS-4764-entitlement-merge-by-group"), "3126136aa1b2c3d4e5f60718293a4b5c6d7e8f90");
  assert.equal(parseLsRemote(out, "cheney/bug/CAS-4764"), undefined);
  assert.equal(parseLsRemote("", "x"), undefined);
});

test("gh pr view: merged with green checks", () => {
  const pr = parsePrView(fixture("gh-pr-view-merged.json"), "o/cas-admin#752", NOW);
  assert.deepEqual(pr, { ref: "o/cas-admin#752", state: "MERGED", mergedAt: "2026-10-16T15:30:13Z", reviewDecision: "APPROVED", checks: "pass", at: NOW });
});

test("gh pr view: a failed check fails the rollup even with others pending", () => {
  const pr = parsePrView(fixture("gh-pr-view-failing.json"), "#260", NOW);
  assert.equal(pr.state, "OPEN");
  assert.equal(pr.checks, "fail");
  assert.equal(pr.reviewDecision, "REVIEW_REQUIRED");
  assert.equal(parsePrView(fixture("gh-pr-view-pending.json"), "#1", NOW).checks, "pending");
  assert.equal(parsePrView(fixture("gh-pr-view-pending.json"), "#1", NOW).reviewDecision, null);
  assert.equal(summarizeChecks([]), "none");
});

test("PR targets from artifacts and aliases, deduplicated by number", () => {
  const t = task("CAS-4685", {
    repo: "/work/cas-admin",
    artifacts: ["pr:https://adc.example.com/Foundation-CAS/cas-admin/pull/752", "pr:#753", "file:x"],
    aliases: ["#752", "pr:Foundation-CAS/cas-bff#940"],
  });
  assert.deepEqual(prTargets(t), [
    { ref: "Foundation-CAS/cas-admin#752", args: ["https://adc.example.com/Foundation-CAS/cas-admin/pull/752"] },
    { ref: "#753", args: ["753"] },
    { ref: "Foundation-CAS/cas-bff#940", args: ["940", "--repo", "Foundation-CAS/cas-bff"] },
  ]);
  assert.deepEqual(prTargets(task("x", { aliases: ["#5"] })), [], "a bare number needs a repository to run in");
});

test("PR changes are described only when state, CI or review changed", () => {
  const open = parsePrView(fixture("gh-pr-view-pending.json"), "#1", NOW);
  assert.equal(describePrChange(undefined, open), undefined, "first sight of an open PR is a baseline");
  assert.equal(describePrChange(open, open), undefined);
  const merged = parsePrView(fixture("gh-pr-view-merged.json"), "#1", NOW);
  assert.equal(describePrChange(open, merged), "PR #1: open → merged, CI pass, review APPROVED");
});

test("date checker: due waits and dated next steps", () => {
  const t = task("PCT-120665", {
    waits: [{ who: "date", what: "recheck Pro line", since: "2026-10-05T00:00:00Z", until: "2026-10-29" }],
    next: [{ text: "page due", run: "me", on: "date 2026-11-01" }, { text: "later", run: "me", on: "date 2026-12-01" }],
  });
  assert.deepEqual(dueItems(t, "2026-11-02").map((d) => d.due), ["2026-10-29", "2026-11-01"]);
  assert.deepEqual(dueItems(t, "2026-10-28"), []);
});

test("runCheckers: a merge closes PR waits and emits one checker event; branch pushes are reported", async () => {
  const h = makeCtx(NOW);
  h.ctx.store.putTask(task("CAS-4685", {
    status: "watch", repo: "/work/cas-admin", branch: "cheney/bug/CAS-4764-entitlement-merge-by-group",
    artifacts: ["pr:#752"], waits: [{ who: "pr", what: "review of #752", since: "2026-10-15T00:00:00Z" }],
    checks: { branch: { state: "local-only", at: "2026-11-01T00:00:00Z" }, prs: { "#752": { ref: "#752", state: "OPEN", checks: "pending", reviewDecision: null, mergedAt: null, at: "x" } } },
  }));
  const calls = [];
  const exec = async (cmd, args, options) => {
    calls.push([cmd, ...args, options.cwd].join(" "));
    if (cmd === "git") return { code: 0, stdout: fixture("git-ls-remote.txt"), stderr: "" };
    return { code: 0, stdout: fixture("gh-pr-view-merged.json"), stderr: "" };
  };
  const { events } = await runCheckers(h.ctx, exec);
  assert.deepEqual(calls, [
    "git ls-remote --heads origin cheney/bug/CAS-4764-entitlement-merge-by-group /work/cas-admin",
    "gh pr view 752 --json state,mergedAt,reviewDecision,statusCheckRollup /work/cas-admin",
  ]);
  assert.deepEqual(events.map((e) => e.data.checker), ["branch", "pr"]);
  const t = h.ctx.store.getTask("CAS-4685");
  assert.equal(t.waits[0].closed, true);
  assert.equal(t.checks.prs["#752"].state, "MERGED");
  assert.equal(t.checks.branch.state, "pushed");
  // A merged PR is final: the next run does not ask gh again.
  calls.length = 0;
  await runCheckers(h.ctx, exec);
  assert.deepEqual(calls, []);
});

test("a failing command reports nothing and changes nothing", async () => {
  const h = makeCtx(NOW);
  h.ctx.store.putTask(task("CAS-1", { repo: "/r", branch: "b", artifacts: ["pr:#1"] }));
  const { events } = await runCheckers(h.ctx, async () => ({ code: 1, stdout: "", stderr: "no VPN" }));
  assert.deepEqual(events, []);
  assert.equal(h.ctx.store.getTask("CAS-1").checks, undefined);
});

test("due reminders fire once: an immediate ask for the user's, a digest ask for the judge's", async () => {
  const h = makeCtx(NOW);
  h.ctx.store.putTask(task("CAS-2"));
  schedule(h.ctx, { at: "2026-11-02T12:00:00Z", text: "look at the PR", task: "CAS-2", why: "user", auto: false, createdBy: "user" });
  schedule(h.ctx, { at: "2026-11-02T12:30:00Z", text: "recheck", task: "CAS-2", why: "judge" });
  schedule(h.ctx, { at: "2026-11-03T12:00:00Z", text: "tomorrow", task: "CAS-2", why: "judge" });
  const exec = async () => ({ code: 1, stdout: "", stderr: "" });
  const { events } = await runCheckers(h.ctx, exec);
  const asks = events.filter((e) => e.action === "ask");
  assert.equal(asks.length, 2);
  assert.equal(asks[0].data.immediate, true);
  assert.equal(asks[1].data.immediate, undefined);
  assert.equal((await runCheckers(h.ctx, exec)).events.length, 0);
});
