import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const start = source.indexOf("  const handleEditContent = useCallback(");
const end = source.indexOf("\n\n", start);
assert.ok(start >= 0 && end > start);
const callback = source.slice(start, end);
const js = ts.transpileModule(`${callback}; return handleEditContent;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("edit mode requires successful composer restoration; blocked drafts produce a notice", () => {
  for (const accepted of [true, false, null]) {
    const calls = [];
    const input = accepted === null ? null : { replaceMessage(message) { calls.push(["restore", message]); return accepted; } };
    const run = new Function("useCallback", "session", "opts", "addNotice", "t", "setEdit", js)(
      (fn) => fn, { id: "session-a" }, { chatInputRef: { current: input } },
      (notice) => calls.push(["notice", notice]), (key) => key, (id) => calls.push(["edit", id]),
    );
    const message = { role: "user", content: "historical text" };
    run(message, "entry-a");
    if (accepted === true) assert.deepEqual(calls, [["restore", message], ["edit", "entry-a"]]);
    else if (accepted === false) assert.deepEqual(calls, [["restore", message], ["notice", { id: "edit-draft-not-empty", type: "warning", durationMs: 3000, message: "chat.editDraftNotEmpty" }]]);
    else assert.deepEqual(calls, []);
  }
});
