import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
const names = ["markOldestNoticeExiting", "fillPendingNotices", "noticeReducer"];
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map((node) => node.getText(ast)).join("\n");
const js = ts.transpileModule(`const MAX_NOTICES = 5; ${functions}; return noticeReducer;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const reduce = new Function(js)();

test("same notice id is coalesced while visible, pending and exiting", () => {
  const notice = { id: "edit-draft-not-empty", type: "warning", durationMs: 3000, message: "Draft kept" };
  for (const state of [
    { visible: [notice], pending: [] },
    { visible: [{ ...notice, exiting: true }], pending: [] },
    { visible: [], pending: [notice] },
  ]) assert.equal(reduce(state, { type: "add", notice }), state);
  let state = { visible: [{ ...notice, exiting: true }], pending: [] };
  state = reduce(state, { type: "remove", id: notice.id });
  state = reduce(state, { type: "add", notice });
  assert.deepEqual(state, { visible: [notice], pending: [] });
});

test("ordinary notices retain the five-second default", () => {
  assert.match(source, /const NOTICE_VISIBLE_MS = 5000;/);
  assert.match(source, /noticeRemainingMsRef\.current = oldest\.durationMs \?\? NOTICE_VISIBLE_MS/);
});
