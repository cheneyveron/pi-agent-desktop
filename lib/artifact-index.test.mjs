import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
    ["gone.html", true, 1, true, "writer", "gone.html"],
  ]);
  assert.equal((await listArtifacts([writer, editor], "gone")).artifacts.length, 1);

  const detail = await getFileOutput([writer, editor], kept);
  assert.deepEqual(detail.ops.map((op) => [op.sessionId, op.tool]), [["writer", "write"], ["editor", "edit"]]);
  assert.equal(await getFileOutput([writer], join(dir, "never.md")), null);

  // The transcript, not the index, holds what a write put in the file.
  assert.deepEqual(await getWrittenContent(writer, "c2"), { path: "gone.html", content: "<p>old</p>" });
  assert.equal(await getWrittenContent(writer, "missing"), null);
  flushArtifactIndexForTests();
  assert.doesNotMatch(readFileSync(indexPath, "utf8"), /SECRET-WRITTEN/);
});
