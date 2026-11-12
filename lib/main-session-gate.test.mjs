import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { classifyGatedToolCall, createMainSessionGateExtension, isAllowedLocalCommand, MAIN_SESSION_GATE_TITLE } = await jiti.import("./main-session-gate.ts");
const { parseContinueEvent } = await jiti.import("./main-session-insert-client.ts");

const cwd = "/work/repo";

test("reading, and editing inside the session's folder, go ahead", () => {
  for (const tool of ["read", "grep", "find", "ls"]) assert.deepEqual(classifyGatedToolCall(tool, { path: "/etc/hosts" }, cwd), { allow: true });
  assert.deepEqual(classifyGatedToolCall("edit", { path: "src/a.ts" }, cwd), { allow: true });
  assert.deepEqual(classifyGatedToolCall("write", { path: "/work/repo/docs/x.md" }, cwd), { allow: true });
});

test("writing outside the folder asks first", () => {
  // `~` and `@` are expanded by the file tools themselves, so they never count as inside.
  for (const path of ["../other/a.ts", "/etc/hosts", "/work/repo-other/a.ts", "~/.zshrc", "@~/.zshrc", "a\u202fb.txt", "  "]) {
    assert.equal(classifyGatedToolCall("write", { path }, cwd).allow, false, path);
  }
  assert.equal(classifyGatedToolCall("edit", {}, cwd).allow, false);
});

test("a link that leaves the folder is outside it", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-"));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  mkdirSync(repo);
  mkdirSync(outside);
  symlinkSync(outside, join(repo, "link"));
  try {
    assert.equal(classifyGatedToolCall("write", { path: "new/dir/a.txt" }, repo).allow, true);
    assert.equal(classifyGatedToolCall("write", { path: "link/a.txt" }, repo).allow, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local read, test and commit commands run; everything that leaves the machine asks", () => {
  for (const ok of ["git status", "git diff HEAD~1", "git add -A", "git commit -m 'fix x'", "npm test", "npm run lint", "npm run test:unit", "npx tsc --noEmit", "node --test lib/a.test.mjs", "gh pr view 12", "rg -n foo src", "cargo test"]) {
    assert.equal(isAllowedLocalCommand(ok), true, ok);
  }
  for (const no of [
    "git push", "git push origin main", "git reset --hard", "git checkout main", "gh pr merge 12", "gh pr comment 12 -b hi",
    "kubectl rollout restart deploy/x", "kubectl get pods", "npm publish", "npm install left-pad", "npm run deploy",
    "rm -rf build", "curl -X POST https://x", "aws s3 cp a s3://b", "ssh host", "node script.js", "npx some-tool",
    "rg --pre sh foo", "git log --output=/tmp/x", "go test -exec sh ./...",
    "git status && git push", "npm test; git push", "echo $(git push)", "git status | sh", "git commit -m \"$(curl x)\"", "",
  ]) {
    assert.equal(isAllowedLocalCommand(no), false, no);
  }
});

test("bash that is not on the list, and every other tool, is refused with what it would do", () => {
  assert.deepEqual(classifyGatedToolCall("bash", { command: "git push origin main" }, cwd), { allow: false, summary: "git push origin main" });
  assert.equal(classifyGatedToolCall("powershell", { command: "git status" }, cwd).allow, false);
  assert.equal(classifyGatedToolCall("subagent", { task: "x" }, cwd).allow, false);
  assert.equal(classifyGatedToolCall("mcp__jira__add_comment", { body: "x" }, cwd).allow, false);
});

function gate(gated, confirm) {
  let handler;
  createMainSessionGateExtension({ isGated: () => gated.value, cwd }).factory({ on: (_event, h) => { handler = h; } });
  const asked = [];
  const ctx = { hasUI: true, ui: { confirm: async (title, message) => { asked.push([title, message]); return confirm; } } };
  return { call: (toolName, input) => handler({ toolName, input }, ctx), asked, ctx };
}

test("the gate is inert in turns the user started", async () => {
  const g = gate({ value: false }, false);
  assert.equal(await g.call("bash", { command: "git push" }), undefined);
  assert.deepEqual(g.asked, []);
});

test("in a main-session turn a refused call waits for the user and is blocked on no", async () => {
  const denied = gate({ value: true }, false);
  assert.equal(await denied.call("bash", { command: "git status" }), undefined);
  const result = await denied.call("bash", { command: "git push" });
  assert.equal(result.block, true);
  assert.deepEqual(denied.asked, [[MAIN_SESSION_GATE_TITLE, "git push"]]);

  const approved = gate({ value: true }, true);
  assert.equal(await approved.call("bash", { command: "git push" }), undefined);
});

test("without a UI to ask, the call is blocked", async () => {
  const g = gate({ value: true }, true);
  g.ctx.hasUI = false;
  assert.equal((await g.call("bash", { command: "git push" })).block, true);
  assert.deepEqual(g.asked, []);
});

test("a continue frame needs an event, a task, text and somewhere to run; origin defaults to gated", () => {
  assert.deepEqual(parseContinueEvent(JSON.stringify({ eventId: "e1", task: "CAS-1", text: "go", sessionId: "s1", origin: "user" })),
    { eventId: "e1", task: "CAS-1", text: "go", origin: "user", sessionId: "s1" });
  assert.equal(parseContinueEvent(JSON.stringify({ eventId: "e1", task: "CAS-1", text: "go", cwd: "/w" })).origin, "main");
  assert.equal(parseContinueEvent(JSON.stringify({ eventId: "e1", task: "CAS-1", text: "go", sessionId: "s1", origin: "USER" })).origin, "main");
  for (const bad of ["{", "null", JSON.stringify({ task: "CAS-1", text: "go", sessionId: "s1" }), JSON.stringify({ eventId: "e1", task: "CAS-1", text: " ", sessionId: "s1" }), JSON.stringify({ eventId: "e1", task: "CAS-1", text: "go" })]) {
    assert.equal(parseContinueEvent(bad), undefined, bad);
  }
});
