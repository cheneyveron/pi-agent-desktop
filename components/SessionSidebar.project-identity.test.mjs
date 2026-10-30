import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The fork moved custom-path validation into components/ProjectPicker.tsx
// (the extraction boundary guarded by fork-extractions.test.mjs). The
// validated-identity assertions therefore target the extraction, not this file.
test("custom cwd selection validates the path through ProjectPicker", async () => {
  const picker = await readFile(new URL("./ProjectPicker.tsx", import.meta.url), "utf8");
  assert.match(picker, /\/api\/cwd\/validate/);
});

test("default cwd is selected through the same validation as a custom path", async () => {
  const picker = await readFile(new URL("./ProjectPicker.tsx", import.meta.url), "utf8");
  const defaultStart = picker.indexOf("const handleDefaultCwd = useCallback");
  const defaultEnd = picker.indexOf("const handleCreateWorktree", defaultStart);
  const defaultSource = picker.slice(defaultStart, defaultEnd);
  assert.notEqual(defaultStart, -1);
  // The created folder is not a path the user typed, so it flows through the
  // same validation as a custom pick without being remembered as one.
  assert.match(defaultSource, /await commitCustomPath\(data\.cwd\)/);
});

// A repo subfolder opened as a project gets the parent repo in its worktree
// list; reverse-looking that list up must not pull the parent into the
// subfolder's project, or clicking the parent's group can never switch back.
test("worktree-list project lookup only applies to a top-level checkout", async () => {
  const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  const lookups = sidebar.match(/worktreeState\??\.[^\n]*worktrees\.some\(\(w\) => w\.path === cwd\)/g) ?? [];
  assert.equal(lookups.length, 2);
  for (const line of lookups) assert.match(line, /isTopLevel/);
});
