import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("压缩后的会话仍可根据持久化消息数生成标题", () => {
  assert.match(
    source,
    /\(sessionStats\?\.userMessages \?\? 0\) > 0 \|\| selectedSession\.messageCount > 0/,
  );
});

test("尚未落盘的会话不会触发依赖 JSONL 的自动命名", () => {
  assert.match(
    source,
    /const nameDisabled = !selectedSession \|\| selectedSession\.transient \|\| !hasMessages/,
  );
});

test("会话落盘后会用服务端记录清除临时状态", () => {
  assert.match(source, /\{ \.\.\.prev, \.\.\.full, transient: full\.transient \?\? false \}/);
  assert.match(source, /void hydrateSelectedSession\(sessionId\)\.then\(\(full\) => \{/);
});

test("新会话的第一轮结束后自动生成标题，且只针对本窗口新建且未命名的会话", () => {
  // Tracked at creation, only when the session has no name yet.
  assert.match(source, /if \(!session\.name\) freshSessionIdsRef\.current\.add\(session\.id\)/);
  // Decided from the server record after the turn: a session without a file
  // waits for the next turn; a name given meanwhile (any window) wins.
  assert.match(source, /if \(!full \|\| full\.transient \|\| !freshSessionIdsRef\.current\.has\(sessionId\)\) return;/);
  assert.match(source, /freshSessionIdsRef\.current\.delete\(sessionId\);\s*if \(full\.name \|\| activeSessionIdRef\.current !== sessionId\) return;\s*void handleAutoNameRef\.current\(\);/);
});

test("侧栏行菜单共用同一个标题生成器与完整历史入口", () => {
  assert.match(source, /onGenerateTitle=\{generateSessionTitleFor\}/);
  assert.match(source, /onOpenFullHistory=\{openFullHistory\}/);
  const sidebar = fs.readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  for (const key of ["title.generate", "sidebar.copySessionId", "history.full"]) {
    assert.ok(sidebar.includes(`t("${key}")`), `${key} is missing from the session row menu`);
  }
  // Both the native popup and the DOM fallback carry the three new actions.
  const nativeMenu = sidebar.slice(sidebar.indexOf("const showNativeSessionMenu"), sidebar.indexOf("const openSessionMenu"));
  const domMenu = sidebar.slice(sidebar.indexOf('session-item-menu"'), sidebar.indexOf("{actionError && createPortal("));
  for (const action of ["generateTitle()", "copySessionId", "openFullHistory"]) {
    assert.ok(nativeMenu.includes(action), `${action} is missing from the native session row menu`);
    assert.ok(domMenu.includes(action), `${action} is missing from the DOM session row menu`);
  }
});
