import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const view = await read("./MainSessionView.tsx");
const row = await read("./MainSessionRow.tsx");
const sidebar = await read("./MainSessionSidebar.tsx");
const entries = await read("./SessionEntries.tsx");
const shell = await read("../AppShell.tsx");
const sessionSidebar = await read("../SessionSidebar.tsx");
const messageView = await read("../MessageView.tsx");
const chatWindow = await read("../ChatWindow.tsx");
const css = await read("../../app/native-theme.css");
const store = await read("../../hooks/useMainSession.ts");
const { englishMessages } = await createJiti(import.meta.url).import("../../lib/i18n/locale-plugins.ts");

test("clicking the active segment folds and unfolds the list; there is no separate collapse button", () => {
  assert.match(view, /if \(next === segment\) \{\s*setCollapsed\(\(value\) => !value\);/);
  assert.match(view, /\{!collapsed && \(\s*<div className="ms-list"/);
  assert.match(view, /aria-expanded=\{on \? !collapsed : undefined\}/);
  assert.doesNotMatch(view, /collapse-button|ms-collapse/);
});

test("the drag handle between list and conversation persists its height through app-prefs", () => {
  assert.match(view, /role="separator"/);
  assert.match(view, /clampListHeight\(startHeight \+ e\.clientY - startY, columnHeight\)/);
  assert.match(view, /setPref\(APP_PREF_KEYS\.mainSessionListHeight/);
  assert.match(view, /getPref\(APP_PREF_KEYS\.mainSessionListHeight\)/);
});

test("the row menu is on the shared app-menu surface with menuitems", () => {
  assert.match(row, /className="native-popover app-menu main-session-row-menu"/);
  assert.match(row, /role="menuitem"/);
  assert.match(row, /useMenuPlacement\(anchor, menuRef\)/);
  for (const action of ["reply", "archive", "details"]) assert.match(row, new RegExp(`action: "${action}"`));
});

test("rows are two lines with answer chips primary and a small open-session button", () => {
  assert.match(row, /className="ms-row-line1"/);
  assert.match(row, /className="ms-row-line2"/);
  assert.match(row, /className="ms-chip ms-chip--primary"/);
  assert.match(row, /className="ms-small-button" title=\{t\("mainSession\.openSessionKey"\)\}/);
});

test("need and watch rows are cards: full text, the session's state, a reply that goes to the session", () => {
  assert.match(row, /segment === "done" \? "" : "ms-card"/);
  assert.match(row, /<div className=\{`ms-card-text\$\{expanded \? " is-open" : ""\}`\}>/);
  for (const kind of ["running", "approval", "ended"]) assert.match(row, new RegExp(`activity\\.kind === "${kind}"`));
  assert.match(row, /onDialog\(activity\.sessionId, activity\.id!, true\)/);
  assert.match(row, /onStop\(activity\.sessionId\)/);
  // An answer that starts a run keeps its card in the list instead of sliding it out.
  assert.match(view, /if \(row\?\.canContinue && goesToSession\(word\)\) \{/);
  assert.match(view, /held\.has\(row\.id\) \|\| cardStateOf\(row, activity\)\.kind === "approval"/);
  assert.match(css, /\.ms-card-text \{[^}]*-webkit-line-clamp: 4;/);
});

test("opening a task shows its existing session with the arrival card; a new one only on request", () => {
  assert.match(store, /for \(const id of task\?\.sessions \?\? \[\]\) \{\s*if \(await sessionExists\(id\)\) \{/);
  assert.match(store, /setTaskArrival\(arrivalOf\(/);
  assert.match(view, /else if \(action === "newSession"\) void handleOpenTaskSession\(id, true\);/);
  assert.match(chatWindow, /<ArrivalCard\s+sessionId=\{session\?\.id\}/);
  assert.match(chatWindow, /clearTaskArrival\(session\?\.id\);\s*return handleSend\(message, images\);/);
});

test("keyboard triage covers j/k 1/2/3 o e Enter Esc and leaves inputs alone", () => {
  for (const key of ['key === "j" \\|\\| key === "k"', "\\^\\[123\\]\\$", 'key === "o"', 'key === "e"', 'key === "Enter"', 'key === "Escape"']) {
    assert.match(view, new RegExp(key));
  }
  assert.match(view, /if \(tag === "INPUT" \|\| tag === "TEXTAREA" \|\| target\?\.isContentEditable\) return;/);
  // Escape only claims the key when there is something to clear, so the global stop-run still works.
  assert.match(view, /if \(!s\.menuId && !s\.focusId && !s\.replyId && s\.expanded\.size === 0\) return;\s*event\.preventDefault\(\);/);
});

test("answered rows slide out, then a 5 second in-flow undo bar appears", () => {
  assert.match(store, /export const UNDO_MS = 5000;/);
  assert.match(view, /setLeaving\(\(value\) => new Set\(value\)\.add\(id\)\);\s*setTimeout\(finish, LEAVE_MS\);/);
  assert.match(view, /<div className="ms-undo" role="status">/);
  const undoRule = css.match(/\.ms-undo \{[^}]*\}/)[0];
  assert.doesNotMatch(undoRule, /position:\s*(fixed|absolute)/);
  assert.match(css, /\.ms-row\.is-leaving \{ transform: translateX\(48px\); opacity: 0; \}/);
});

test("the conversation shows every message and scrolls; replies cite their basis", () => {
  assert.match(view, /state\.chat\.map\(\(message, index\) => \{/);
  // Day separators, and no digest restated as a message.
  assert.match(view, /<div className="ms-day" role="separator">\{dayLabel\(message\.at, now, t, locale\)\}<\/div>/);
  assert.doesNotMatch(view, /sinceLabel|digestLabel|ms-narrative/);
  assert.doesNotMatch(store, /applyDigest|label: "since"/);
  assert.match(css, /\.ms-conversation \{ flex: 1 1 150px; min-height: 130px; overflow: auto; \}/);
  assert.match(view, /t\("mainSession\.basis"\)/);
  assert.equal(englishMessages["mainSession.basis"], "Based on: ");
});

test("the sidebar shows the pinned row with an unread dot and the needs-you section with row actions", () => {
  assert.match(sessionSidebar, /<MainSessionSidebarRow active=\{mainSessionOpen\}/);
  assert.match(sessionSidebar, /<NeedsYouSection\s+mainSessionOpen=\{mainSessionOpen\}/);
  assert.match(sidebar, /sidebar-main-session-dot/);
  assert.match(sidebar, /const expanded = mainSessionOpen \? openOnPage : openElsewhere;/);
  for (const key of ["mainSession.openSession", "mainSession.sidebar.reply", "mainSession.sidebar.archive"]) assert.match(sidebar, new RegExp(key.replace(".", "\\.")));
});

test("the page mounts from ?view=main (with &task=) like the other pages", () => {
  assert.match(shell, /value === "scheduled" \|\| value === "artifacts" \|\| value === "main"/);
  assert.match(shell, /const target = `\?view=main\$\{taskId \? `&task=\$\{encodeURIComponent\(taskId\)\}` : ""\}`;/);
  assert.match(shell, /\{mainSessionOpen && \(\s*<MainSessionView/);
  assert.match(shell, /if \(sessionId === MAIN_SESSION_NOTIFICATION_ID\) \{\s*handleOpenMainSession\(\);/);
  assert.match(shell, /window\.addEventListener\(MAIN_SESSION_OPEN_EVENT, onOpen\)/);
});

test("MessageView renders the close-out card and the main-session note", () => {
  assert.match(messageView, /customType === "closeout"\) \{\s*return <CloseoutCard/);
  assert.match(messageView, /customType === "main-session-note"\) \{\s*return <MainSessionNote/);
  assert.match(entries, /await postCloseoutCard\(closeoutPayload\(entry, applyCloseoutEdits\(closeout, edits\)\)\)/);
  // An idle close-out is recorded but draws no card.
  assert.match(entries, /if \(!entry \|\| !closeout \|\| entry\.trigger === "idle"\) return null;/);
  assert.match(entries, /aria-expanded=\{open\}/);
  assert.match(entries, /openMainSessionPage\(note\.task\)/);
});

test("main-session styles stay in native-theme.css", async () => {
  const globals = await read("../../app/globals.css");
  assert.doesNotMatch(globals, /main-session|\.ms-/);
  assert.match(css, /\.main-session-view \{/);
  assert.match(css, /\.main-session-row-menu \{ min-width: 168px; \}/);
});
