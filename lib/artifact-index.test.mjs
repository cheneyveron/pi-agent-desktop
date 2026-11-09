import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  flushArtifactIndexForTests,
  getArtifact,
  getFileOutput,
  getWrittenContent,
  listArtifacts,
  parseSession,
  parseSessionArtifacts,
  resetArtifactIndexForTests,
} from "./artifact-index.ts";

function artifact(identifier, title, body, type = "html") {
  return `Here it is.\n\n:::artifact{identifier="${identifier}" type="${type}" title="${title}"}\n\`\`\`${type}\n${body}\n\`\`\`\n:::\n`;
}

function assistant(id, parentId, text, timestamp = "2026-10-01T00:00:00.000Z") {
  return { type: "message", id, parentId, timestamp, message: { role: "assistant", content: [{ type: "text", text }] } };
}

function user(id, parentId, text) {
  return { type: "message", id, parentId, timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: text } };
}

function lines(entries) {
  return [{ type: "session", id: "header", cwd: "/tmp" }, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function fixture(t, entries, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-artifact-index-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines(entries));
  return { id: "session", path, cwd: "/project", projectKey: "/project", created: "2026-10-01", modified: "2026-10-01", firstMessage: "first", messageCount: entries.length, ...overrides };
}

test.beforeEach(() => resetArtifactIndexForTests());

test("collects versions in file order and marks the branch the file ends on", () => {
  const parsed = parseSessionArtifacts(lines([
    user("u1", null, "make a page"),
    assistant("a1", "u1", artifact("page", "Page v1", "<p>one</p>")),
    user("u2", "a1", "change it"),
    assistant("a2", "u2", artifact("page", "Page v2", "<p>two</p>")),
    // Re-edited u2: a sibling branch, which the file now ends on.
    user("u3", "a1", "change it differently"),
    assistant("a3", "u3", artifact("page", "Page v3", "<p>three</p>")),
  ]));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].versions.map((version) => [version.title, version.entryId, version.onActiveBranch]), [
    ["Page v1", "a1", true],
    ["Page v2", "a2", false],
    ["Page v3", "a3", true],
  ]);
});

test("follows the branch through entries whose keys come in another order", () => {
  const parsed = parseSessionArtifacts(lines([
    assistant("a1", null, artifact("page", "Page", "<p>one</p>")),
    { type: "custom", customType: "note", data: { id: "not-the-entry" }, id: "c1", parentId: "a1" },
    user("u2", "c1", "thanks"),
  ]));
  assert.equal(parsed[0].versions[0].onActiveBranch, true);
});

test("streams a file too large to read whole", async (t) => {
  const session = fixture(t, [
    assistant("a1", null, artifact("page", "Big session page", "<p>one</p>")),
    { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(17 * 1024 * 1024) }] } },
  ]);
  const found = await getArtifact(session, "page");
  assert.equal(found.versions[0].title, "Big session page");
  assert.equal(found.versions[0].onActiveBranch, true);
});

test("ignores artifact syntax outside assistant text", () => {
  const parsed = parseSessionArtifacts(lines([
    user("u1", null, artifact("quoted", "Quoted", "<p>x</p>")),
    { type: "message", id: "t1", parentId: "u1", message: { role: "toolResult", content: [{ type: "text", text: artifact("tool", "Tool", "x") }] } },
    { type: "message", id: "a1", parentId: "t1", message: { role: "assistant", content: [{ type: "thinking", thinking: artifact("think", "Think", "x") }] } },
  ]));
  assert.deepEqual(parsed, []);
});

test("lists newest first and searches identifier, title, then content", async (t) => {
  const one = fixture(t, [
    assistant("a1", null, artifact("chart", "Sales chart", "<svg><text>revenue</text></svg>", "svg"), "2026-10-02T00:00:00.000Z"),
  ], { id: "one" });
  const two = fixture(t, [
    assistant("b1", null, artifact("notes", "Meeting notes", "# Agenda\nquarterly revenue review", "markdown"), "2026-10-03T00:00:00.000Z"),
  ], { id: "two", cwd: "/other", projectKey: "/other", workspaceKind: "chat" });

  const all = await listArtifacts([one, two]);
  assert.deepEqual(all.artifacts.map((item) => item.identifier), ["notes", "chart"]);
  assert.equal(all.artifacts[0].workspaceKind, "chat");
  assert.equal(all.truncated, false);

  const byTitle = await listArtifacts([one, two], "SALES");
  assert.deepEqual(byTitle.artifacts.map((item) => item.identifier), ["chart"]);
  assert.equal(byTitle.artifacts[0].snippet, undefined);

  const byContent = await listArtifacts([one, two], "quarterly");
  assert.deepEqual(byContent.artifacts.map((item) => item.identifier), ["notes"]);
  assert.deepEqual(byContent.artifacts[0].snippet, { before: "# Agenda ", match: "quarterly", after: " revenue review" });

  assert.deepEqual((await listArtifacts([one, two], "(a+)+$")).artifacts, []);
});

test("hides a fork's copies of its source's artifacts but keeps new versions", async (t) => {
  const sourceEntries = [assistant("a1", null, artifact("page", "Page", "<p>one</p>"))];
  const source = fixture(t, sourceEntries, { id: "source" });
  const copy = fixture(t, sourceEntries, { id: "copy", relation: { kind: "fork" }, parentSessionId: "source" });
  const grown = fixture(t, [
    ...sourceEntries,
    assistant("a2", "a1", artifact("page", "Page", "<p>two</p>"), "2026-10-05T00:00:00.000Z"),
  ], { id: "grown", relation: { kind: "fork" }, parentSessionId: "source" });

  const listed = await listArtifacts([source, copy, grown]);
  assert.deepEqual(listed.artifacts.map((item) => [item.sessionId, item.versionCount]), [["grown", 2], ["source", 1]]);
});

test("skips subagent sessions and flags scheduled runs and active content", async (t) => {
  const subagent = fixture(t, [assistant("a1", null, artifact("sub", "Sub", "<p>x</p>"))], {
    id: "sub",
    relation: { kind: "subagent", parentSessionId: "p", profile: "x", description: "", status: "done" },
  });
  const scheduled = fixture(t, [assistant("a1", null, artifact("daily", "Daily", "<script>run()</script>"))], {
    id: "run",
    relation: { kind: "scheduled", taskId: "t", runId: "r" },
  });
  const listed = await listArtifacts([subagent, scheduled]);
  assert.deepEqual(listed.artifacts.map((item) => [item.identifier, item.scheduled, item.activeContent]), [["daily", true, true]]);
});

test("re-reads a file only when its fingerprint changes", async (t) => {
  const session = fixture(t, [assistant("a1", null, artifact("page", "Old", "<p>x</p>"))]);
  assert.equal((await getArtifact(session, "page")).versions[0].title, "Old");

  writeFileSync(session.path, lines([assistant("a1", null, artifact("page", "New title", "<p>x</p>"))]));
  utimesSync(session.path, new Date(), new Date(Date.now() + 5000));
  assert.equal((await getArtifact(session, "page")).versions[0].title, "New title");
  assert.equal(await getArtifact(session, "missing"), null);
  assert.equal(await getArtifact({ ...session, transient: true }, "page"), null);
});

test("keeps the index on disk so a restart does not re-read unchanged files", async (t) => {
  const session = fixture(t, [assistant("a1", null, artifact("page", "Saved", "<p>x</p>"))]);
  // Whole seconds, so setting the same time again reproduces the fingerprint exactly.
  const stamp = new Date("2026-10-01T00:00:00.000Z");
  utimesSync(session.path, stamp, stamp);
  const indexPath = join(mkdtempSync(join(tmpdir(), "pi-web-artifact-store-")), "artifact-index.json");
  t.after(() => rmSync(indexPath, { force: true }));
  resetArtifactIndexForTests(indexPath);
  assert.equal((await listArtifacts([session])).artifacts[0].title, "Saved");
  flushArtifactIndexForTests();
  assert.ok(existsSync(indexPath));
  assert.equal(typeof JSON.parse(readFileSync(indexPath, "utf8")).version, "number");

  // A new process: the file's bytes say something else, but its fingerprint
  // still matches the stored one, so the stored index is used without reading it.
  const { size } = statSync(session.path);
  writeFileSync(session.path, lines([assistant("a1", null, artifact("page", "Other", "<p>x</p>"))]).padEnd(size, " ").slice(0, size));
  utimesSync(session.path, stamp, stamp);
  resetArtifactIndexForTests(indexPath);
  assert.equal((await listArtifacts([session])).artifacts[0].title, "Saved");

  // A moved fingerprint is read again; a corrupt store is ignored.
  utimesSync(session.path, stamp, new Date(stamp.getTime() + 5000));
  writeFileSync(indexPath, "{not json");
  resetArtifactIndexForTests(indexPath);
  assert.equal((await listArtifacts([session])).artifacts[0].title, "Other");
});

// --- Files the model wrote or edited ----------------------------------------

function toolCall(id, parentId, calls, timestamp = "2026-10-02T00:00:00.000Z") {
  return {
    type: "message", id, parentId, timestamp,
    message: { role: "assistant", content: calls.map(([callId, name, args]) => ({ type: "toolCall", id: callId, name, arguments: args })) },
  };
}

function toolResult(id, parentId, callId, toolName, isError = false) {
  return { type: "message", id, parentId, timestamp: "2026-10-02T00:00:01.000Z", message: { role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text: "ok" }], isError } };
}

test("records write and edit calls that succeeded, and nothing else", () => {
  const parsed = parseSession(lines([
    toolCall("a1", null, [
      ["c1", "write", { path: "out/page.html", content: "<p>hi</p>" }],
      ["c2", "edit", { path: "/abs/notes.md", edits: [{ oldText: "a", newText: "b" }] }],
      ["c3", "edit", { path: "/abs/failed.md", edits: [] }],
      ["c4", "write", { path: "/abs/interrupted.md", content: "x" }],
      ["c5", "read", { path: "/abs/read-only.md" }],
    ]),
    toolResult("r1", "a1", "c1", "write"),
    toolResult("r2", "r1", "c2", "edit"),
    toolResult("r3", "r2", "c3", "edit", true),
    toolResult("r5", "r3", "c5", "read"),
  ]));
  assert.deepEqual(parsed.files.map((op) => [op.path, op.tool, op.entryId, op.onActiveBranch]), [
    ["out/page.html", "write", "a1", true],
    ["/abs/notes.md", "edit", "a1", true],
  ]);
  assert.deepEqual(parsed.artifacts, []);
});

test("lists files by absolute path, merged across sessions, without their contents", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-file-outputs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kept = join(dir, "kept.md");
  writeFileSync(kept, "# now");
  const writer = fixture(t, [
    toolCall("a1", null, [["c1", "write", { path: "kept.md", content: "SECRET-WRITTEN" }], ["c2", "write", { path: "gone.html", content: "<p>old</p>" }]]),
    toolResult("r1", "a1", "c1", "write"),
    toolResult("r2", "r1", "c2", "write"),
  ], { id: "writer", cwd: dir, projectKey: dir });
  const editor = fixture(t, [
    toolCall("b1", null, [["d1", "edit", { path: kept, edits: [] }]], "2026-10-03T00:00:00.000Z"),
    toolResult("s1", "b1", "d1", "edit"),
  ], { id: "editor", cwd: "/elsewhere", projectKey: "/elsewhere" });
  // A fork repeats its source's calls under the same ids: counted once.
  const fork = fixture(t, [
    toolCall("a1", null, [["c1", "write", { path: "kept.md", content: "SECRET-WRITTEN" }]]),
    toolResult("r1", "a1", "c1", "write"),
  ], { id: "fork", cwd: dir, projectKey: dir, relation: { kind: "fork" }, parentSessionId: "writer" });

  const indexPath = join(dir, "artifact-index.json");
  resetArtifactIndexForTests(indexPath);
  const { artifacts } = await listArtifacts([writer, editor, fork]);
  const files = artifacts.filter((item) => item.kind === "file");
  assert.deepEqual(files.map((item) => [item.title, item.created, item.versionCount, item.missing, item.sessionId, item.displayPath]), [
    ["kept.md", true, 2, false, "editor", join(dir, "kept.md")],
  ]);
  // Gone from disk: it cannot be opened, so it is not listed.
  assert.equal((await listArtifacts([writer, editor], "gone")).artifacts.length, 0);
  assert.equal((await listArtifacts([writer, editor], "kept")).artifacts.length, 1);

  const detail = await getFileOutput([writer, editor], kept);
  assert.deepEqual(detail.ops.map((op) => [op.sessionId, op.tool]), [["writer", "write"], ["editor", "edit"]]);
  assert.equal(await getFileOutput([writer], join(dir, "never.md")), null);

  // The transcript, not the index, holds what a write put in the file.
  assert.deepEqual(await getWrittenContent(writer, "c2"), { path: "gone.html", content: "<p>old</p>" });
  assert.equal(await getWrittenContent(writer, "missing"), null);
  flushArtifactIndexForTests();
  assert.doesNotMatch(readFileSync(indexPath, "utf8"), /SECRET-WRITTEN/);
});

// --- Outputs and process files ----------------------------------------------

test("records deliverable paths named in user and assistant text, not in tool output", () => {
  const parsed = parseSession(lines([
    user("u1", null, "Make me `report.html` please"),
    assistant("a1", "u1", "Done: open `out/report.html`. The data is in data.json."),
    { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolCallId: "x", toolName: "bash", content: [{ type: "text", text: "wrote /abs/noise.html" }] } },
    { type: "message", id: "a2", parentId: "t1", message: { role: "assistant", content: [{ type: "thinking", thinking: "maybe /abs/idea.html" }] } },
  ]));
  assert.deepEqual(parsed.mentions.map((m) => [m.by, m.path, m.entryId, m.onActiveBranch]), [
    ["user", "report.html", "u1", true],
    ["assistant", "out/report.html", "a1", true],
  ]);
});

test("a run that swallowed the words before a file name still yields the name", async () => {
  const { extractFileMentions } = await import("./file-output-role.ts");
  assert.deepEqual(extractFileMentions("已生成 `产研协同平台-交互demo.html`，见 [报告](docs/周报.md)。"), ["产研协同平台-交互demo.html", "docs/周报.md"]);
  assert.deepEqual(extractFileMentions("See /tmp/a.html:12 and https://example.com/page.html"), ["/tmp/a.html"]);
  assert.deepEqual(extractFileMentions("edited lib/foo.ts and package.json"), []);
});

test("classifies outputs by what the conversation pointed at", async () => {
  const { classifyFileOutput, isHiddenOutputPath, isInAppOrTempFolder, isInDotFolder } = await import("./file-output-role.ts");
  const base = { path: "/w/report.html", created: true, userMentioned: false, assistantMentioned: false, inRepo: false, inDotFolder: false, inAppOrTempFolder: false };
  const role = (facts) => classifyFileOutput({ ...base, ...facts });
  assert.deepEqual(role({}), { role: "output", reasons: ["created"] });
  assert.deepEqual(role({ assistantMentioned: true, userMentioned: true }), { role: "output", reasons: ["requested", "mentioned", "created"] });
  assert.equal(role({ path: "/w/build.py" }).role, "process");
  assert.equal(role({ inRepo: true }).role, "process");
  assert.deepEqual(role({ inRepo: true, assistantMentioned: true }), { role: "output", reasons: ["mentioned"] });
  assert.equal(role({ inRepo: true, created: false, assistantMentioned: true }).role, "process");
  assert.deepEqual(role({ inRepo: true, created: false, userMentioned: true }), { role: "output", reasons: ["requested"] });
  assert.equal(role({ path: "/h/.pi/agent/notes.md", inDotFolder: true, assistantMentioned: true }).role, "process");
  // A page a tool renders into its dot folder is still something to look at.
  assert.deepEqual(role({ path: "/h/.answers/pages/a.html", inDotFolder: true }), { role: "output", reasons: ["created"] });
  assert.equal(role({ path: "/w/SOUL.md", assistantMentioned: true }).role, "process");
  assert.deepEqual(role({ path: "/w/SKILL.md", userMentioned: true }), { role: "output", reasons: ["requested"] });
  // Scratch pieces and temp files need a reply that hands them over.
  assert.equal(role({ path: "/w/_body.html" }).role, "process");
  assert.equal(role({ path: "/tmp/part.html", inAppOrTempFolder: true }).role, "process");
  assert.deepEqual(role({ path: "/tmp/part.html", inAppOrTempFolder: true, assistantMentioned: true }), { role: "output", reasons: ["mentioned"] });
  assert.deepEqual(role({ path: "/w/build.py", override: "output" }), { role: "output", reasons: ["pinned"] });
  assert.equal(role({ override: "process" }).role, "process");
  assert.equal(isHiddenOutputPath("/home/u/.pi/agent/auth.json"), true);
  assert.equal(isHiddenOutputPath("/w/.env.local"), true);
  assert.equal(isHiddenOutputPath("/w/node_modules/x/README.md"), true);
  assert.equal(isHiddenOutputPath("/w/author.json"), false);
  assert.equal(isInDotFolder("/h/.pi/agent/notes.md", "/w", "/h"), true);
  assert.equal(isInDotFolder("/h/.claude/worktrees/x/demo.html", "/h/.claude/worktrees/x", "/h"), false);
  assert.equal(isInAppOrTempFolder("/tmp/a.html", "/h"), true);
  assert.equal(isInAppOrTempFolder("/h/Library/Containers/app/x.md", "/h"), true);
  assert.equal(isInAppOrTempFolder("/h/Documents/x.md", "/h"), false);
});

test("lists outputs, process files and files a command made, and hides secrets", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-file-roles-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "guide.md"), "# old");
  writeFileSync(join(dir, "made-by-bash.html"), "<p>chart</p>");
  writeFileSync(join(dir, "report.html"), "<p>r</p>");
  writeFileSync(join(dir, "build.py"), "print()");
  writeFileSync(join(repo, "docs", "plan.md"), "# plan");
  writeFileSync(join(dir, "old.html"), "<p>old</p>");
  const now = new Date().toISOString();
  const work = fixture(t, [
    user("u1", null, "build a report"),
    toolCall("a1", "u1", [
      ["c1", "write", { path: "report.html", content: "<p>r</p>" }],
      ["c2", "write", { path: "build.py", content: "print()" }],
      ["c3", "write", { path: join(dir, "auth.json"), content: "{}" }],
    ], now),
    toolResult("r1", "a1", "c1", "write"),
    toolResult("r2", "r1", "c2", "write"),
    toolResult("r3", "r2", "c3", "write"),
    assistant("a2", "r3", "Open `made-by-bash.html` and `report.html`.", now),
  ], { id: "work", cwd: dir, projectKey: dir, created: new Date(Date.now() - 60_000).toISOString(), modified: now });
  const dev = fixture(t, [
    toolCall("b1", null, [["d1", "edit", { path: "docs/guide.md", edits: [] }], ["d2", "write", { path: "docs/plan.md", content: "# plan" }]], now),
    toolResult("s1", "b1", "d1", "edit"),
    toolResult("s2", "s1", "d2", "write"),
    assistant("b2", "s2", "Updated `docs/guide.md`; the plan is in `docs/plan.md`.", now),
  ], { id: "dev", cwd: repo, projectKey: repo, modified: now });
  // Named long after the file was made: explaining an old document is not producing it.
  const later = fixture(t, [
    assistant("e1", null, "That page is `old.html`.", "2030-01-01T00:00:00.000Z"),
  ], { id: "later", cwd: dir, projectKey: dir, created: "2030-01-01T00:00:00.000Z", modified: "2030-01-01T00:00:00.000Z" });

  const files = (await listArtifacts([work, dev, later])).artifacts.filter((item) => item.kind === "file");
  const byName = Object.fromEntries(files.map((item) => [item.title, [item.role, item.reasons, item.versionCount]]));
  // The fixtures sit in the system temp folder, where only a reply naming a file makes it an output.
  assert.deepEqual(byName, {
    "report.html": ["output", ["mentioned"], 1],
    "build.py": ["process", [], 1],
    "made-by-bash.html": ["output", ["mentioned"], 0],
    "guide.md": ["process", [], 1],
    "plan.md": ["output", ["mentioned"], 1],
  });

  const madeByBash = await getFileOutput([work], join(dir, "made-by-bash.html"));
  assert.deepEqual(madeByBash.ops.map((op) => [op.tool, op.entryId]), [["mention", "a2"]]);
  assert.equal(await getFileOutput([work], join(dir, "auth.json")), null);
  assert.equal(await getFileOutput([later], join(dir, "old.html")), null);

  // The user's own corrections win, by absolute path.
  const rolesPath = join(dir, "roles.json");
  const { writeFileRoleOverride } = await import("./artifact-file-roles.ts");
  writeFileRoleOverride(join(dir, "build.py"), "output", rolesPath);
  writeFileRoleOverride(join(dir, "report.html"), "process", rolesPath);
  resetArtifactIndexForTests(null, rolesPath);
  const moved = (await listArtifacts([work])).artifacts.filter((item) => item.kind === "file");
  assert.deepEqual(Object.fromEntries(moved.map((item) => [item.title, [item.role, item.override ?? null]])), {
    "report.html": ["process", "process"],
    "build.py": ["output", "output"],
    "made-by-bash.html": ["output", null],
  });
});

test("marks starred artifacts and files from the favorites file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-favorites-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "report.html"), "<p>r</p>");
  const session = fixture(t, [
    assistant("a1", null, artifact("page", "Page", "<p>one</p>") + artifact("other", "Other", "<p>two</p>")),
    toolCall("a2", "a1", [["c1", "write", { path: "report.html", content: "<p>r</p>" }]]),
    toolResult("r1", "a2", "c1", "write"),
  ], { id: "fav", cwd: dir, projectKey: dir });
  const favoritesPath = join(dir, "favorites.json");
  const { writeFavorite } = await import("./artifact-favorites.ts");
  writeFavorite({ kind: "artifact", sessionId: "fav", identifier: "page" }, true, favoritesPath);
  writeFavorite({ kind: "file", path: join(dir, "report.html") }, true, favoritesPath);
  writeFavorite({ kind: "artifact", sessionId: "fav", identifier: "other" }, true, favoritesPath);
  writeFavorite({ kind: "artifact", sessionId: "fav", identifier: "other" }, false, favoritesPath);
  resetArtifactIndexForTests(null, null, favoritesPath);
  const { artifacts } = await listArtifacts([session]);
  assert.deepEqual(Object.fromEntries(artifacts.map((item) => [item.title, item.favorite])), { Page: true, Other: false, "report.html": true });
  // Each row knows which entry "open the conversation" scrolls to.
  assert.deepEqual(Object.fromEntries(artifacts.map((item) => [item.title, item.conversation])), {
    Page: { sessionId: "fav", entryId: "a1" },
    Other: { sessionId: "fav", entryId: "a1" },
    "report.html": { sessionId: "fav", entryId: "a2" },
  });
});
