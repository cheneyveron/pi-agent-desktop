import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("chat workspace classification comes from the server, never a derived path", async () => {
  assert.match(source, /fetch\("\/api\/chat-workspace", \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.match(source, /return selectedSession\.workspaceKind\s*\?\?\s*\(chatWorkspaceCwd && selectedSession\.cwd === chatWorkspaceCwd \? "chat" : "project"\)/);
  assert.match(source, /if \(cwd && chatWorkspaceCwd && cwd === chatWorkspaceCwd\) return "chat"/);
  assert.match(source, /if \(data\.workspaceKind === "chat"\) \{\s*setChatWorkspaceCwd\(data\.cwd\);/);
  assert.match(source, /onChatWorkspaceCwdChange=\{setChatWorkspaceCwd\}/);
});

test("project-only chrome never receives the hidden chat cwd", () => {
  assert.match(source, /const visibleProjectCwd = isChatWorkspaceActive \? null : activeCwd/);
  assert.match(source, /const projectTrustCwd = isChatWorkspaceActive\s*\? null\s*:\s*selectedSession\?\.cwd \?\? effectiveNewSessionCwd;/);
  assert.match(source, /cwd: isChatWorkspaceActive \? null : selectedSession\?\.cwd \?\? newSessionCwd \?\? activeCwd/);
  assert.match(source, /defaultCwd=\{isChatWorkspaceActive \? null : selectedSession\?\.cwd \?\? newSessionCwd \?\? activeCwd\}/);
  assert.match(source, /const windowTitle = isChatWorkspaceActive\s*\?\s*`\$\{topBarTitle\} - \$\{PRODUCT_NAME\}`/);
  assert.match(source, /const showFilePanelToggle = !isChatWorkspaceActive &&/);
  // A chat is titled by its first message; the title guard must compare what document.title reads back.
  assert.match(source, /useEffect\(\(\) => keepDocumentTitle\(document, windowTitle\), \[windowTitle\]\)/);
  assert.doesNotMatch(source, /document\.title !== windowTitle/);
  assert.match(source, /<ChatWindow[\s\S]*?workspaceKind=\{activeWorkspaceKind\}/);
});

test("an unresolved initial cwd cannot leak the hidden chat path in an error", () => {
  assert.match(
    source,
    /const showInitialRequestedCwd = Boolean\(\s*chatWorkspaceCwd\s*&& initialNavigation\.requestedCwd\s*&& initialNavigation\.requestedCwd !== chatWorkspaceCwd,/,
  );
  assert.match(source, /\{showInitialRequestedCwd && \(/);
});

test("opening a chat closes and guards every project workbench entry point", () => {
  assert.match(
    source,
    /if \(!isChatWorkspaceActive\) return;\s*setRightPanelOpen\(false\);\s*setRightPanelExpanded\(false\);\s*setFileTreeOpen\(false\);\s*setFileTabs\(\[\]\);\s*setActiveFileTabId\(null\);/,
  );
  assert.match(source, /const handleOpenFile = useCallback\([\s\S]*?if \(isChatWorkspaceActive\) return;/);
  assert.match(source, /const handleOpenTerminal = useCallback\(\(cwd: string\) => \{\s*if \(isChatWorkspaceActive\) return;/);
  assert.match(source, /setArtifactOpener\(\(request\) => \{\s*if \(isChatWorkspaceActive\) return;/);
  assert.match(source, /onNewTerminal=\{visibleProjectCwd \? \(\) => handleOpenTerminal\(visibleProjectCwd\) : undefined\}/);
});

test("chat composer and project picker cannot switch back into a project", () => {
  assert.match(source, /const handleProjectChangeFromComposer = useCallback\(\(projectRoot: string\) => \{\s*if \(selectedSession \|\| isChatWorkspaceActive\) return;/);
  assert.match(source, /const handleSelectProjectFromComposer = useCallback\(async \(\) => \{\s*if \(isChatWorkspaceActive\) return;/);
  assert.match(source, /onSelectProject=\{isChatWorkspaceActive \? undefined :/);
  assert.match(source, /projectOptions=\{selectedSession \|\| isChatWorkspaceActive \? \[\] : availableProjectRoots\}/);
  assert.match(source, /onProjectChange=\{selectedSession \|\| isChatWorkspaceActive \? undefined : handleProjectChangeFromComposer\}/);
});
