import assert from "node:assert/strict";
import test from "node:test";
import {
  aliasesOfCloseout, branchFromArtifact, extractLabelledGuids, extractPrRefs, extractTickets, matchCloseout, newTaskId,
} from "./aliases.ts";
import { closeout, task } from "./test-helpers.mjs";

test("tickets are found case-insensitively, CVE ids whole, and unrelated words ignored", () => {
  assert.deepEqual(
    extractTickets("fix cas-4764 for PCT-121470; CVE-2026-111497 and UTF-8, SHA-256, EAI-370 again cas-4764"),
    ["CAS-4764", "PCT-121470", "CVE-2026-111497", "EAI-370"],
  );
});

test("labelled guids become org/group aliases", () => {
  assert.deepEqual(
    extractLabelledGuids("org 773E0CDF-1111-2222-3333-444455556666 and group: ceb0f252-aaaa-bbbb-cccc-ddddeeeeffff"),
    ["org:773e0cdf-1111-2222-3333-444455556666", "group:ceb0f252-aaaa-bbbb-cccc-ddddeeeeffff"],
  );
});

test("PR refs keep the repository when a URL names it", () => {
  assert.deepEqual(
    extractPrRefs("PR #752 is open: https://adc.example.com/Foundation-CAS/cas-admin/pull/752 and #12"),
    [{ repo: "Foundation-CAS/cas-admin", number: 752 }, { number: 752 }, { number: 12 }],
  );
});

test("branch artifacts give the branch name; local clone paths do not", () => {
  assert.equal(branchFromArtifact("branch:cheney/bug/CAS-4764-x (not pushed)"), "cheney/bug/CAS-4764-x");
  assert.equal(branchFromArtifact("branch:/tmp/pi-pg-fork (main)"), undefined);
});

test("a close-out matches the task already holding its session first", () => {
  const a = task("CAS-1", { sessions: ["s-1"] });
  const b = task("CAS-2");
  const m = matchCloseout([a, b], closeout({ thread: "CAS-2" }));
  assert.equal(m.task.id, "CAS-1");
});

test("the declared thread wins over shared ids, by id or alias", () => {
  const a = task("PCT-121470");
  const b = task("CAS-4764", { aliases: ["TM-77"] });
  assert.equal(matchCloseout([a, b], closeout({ thread: "tm-77", stands: "about PCT-121470" })).task.id, "CAS-4764");
});

test("an unknown declared ticket is a new task even when a related tracked ticket is mentioned", () => {
  const p1 = task("PCT-121470");
  const m = matchCloseout([p1], closeout({ thread: "CAS-4764", stands: "root fix for P1 PCT-121470" }));
  assert.equal(m.task, undefined);
});

test("shared tickets and branches score; ties go to the most recently updated task", () => {
  const older = task("EAI-370", { updatedAt: "2026-10-01T00:00:00Z" });
  const newer = task("repo:x:feat", { aliases: ["EAI-370"], updatedAt: "2026-10-05T00:00:00Z" });
  const m = matchCloseout([older, newer], closeout({ stands: "continuing EAI-370" }));
  assert.equal(m.task.id, "repo:x:feat");
  assert.deepEqual(m.ties, ["EAI-370"]);
  const byBranch = matchCloseout([task("CAS-9", { branch: "cheney/fix/thing" })], closeout({ produced: ["branch:cheney/fix/thing"] }));
  assert.equal(byBranch.task.id, "CAS-9");
});

test("a bare PR number alone never attaches a close-out, and only counts in the same repo", () => {
  const t = task("CAS-4685", { aliases: ["#752"], repo: "/work/cas-admin" });
  assert.equal(matchCloseout([t], closeout({ cwd: "/work/cas-admin", stands: "PR #752 merged" })).task, undefined);
  const withBranch = task("CAS-4685", { aliases: ["#752", "branch:cheney/fix/a"], repo: "/work/cas-admin" });
  const same = matchCloseout([withBranch], closeout({ cwd: "/work/cas-admin", stands: "PR #752", produced: ["branch:cheney/fix/a"] }));
  assert.equal(same.task.id, "CAS-4685");
  assert.match(same.via, /PR #752/);
  const other = matchCloseout([withBranch], closeout({ cwd: "/work/cas-bff", stands: "PR #752", produced: ["branch:cheney/fix/a"] }));
  assert.doesNotMatch(other.via, /PR #752/);
});

test("new task ids follow ticket > guid > repo:branch > repo:slug > session", () => {
  const none = () => false;
  assert.equal(newTaskId(closeout({ thread: "new:x", stands: "org 773e0cdf-1111-2222-3333-444455556666 CAS-12" }), none), "CAS-12");
  assert.equal(newTaskId(closeout({ stands: "org 773e0cdf-1111-2222-3333-444455556666" }), none), "org:773e0cdf-1111-2222-3333-444455556666");
  assert.equal(newTaskId(closeout({ produced: ["branch:feat/x"] }), none), "repo:cas-account:feat/x");
  assert.equal(newTaskId(closeout({ thread: "new:perm-gate" }), none), "repo:cas-account:perm-gate");
  assert.equal(newTaskId(closeout({}), none), "session:s-1");
  assert.equal(newTaskId(closeout({ thread: "CAS-12" }), (id) => id === "CAS-12"), "session:s-1");
});

test("a close-out contributes ticket, branch and PR aliases", () => {
  assert.deepEqual(
    aliasesOfCloseout(closeout({ thread: "CAS-4685", stands: "https://h/o/cas-admin/pull/752", produced: ["branch:cheney/fix/a"] })),
    ["CAS-4685", "branch:cheney/fix/a", "pr:o/cas-admin#752"],
  );
});
