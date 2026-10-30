import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  appListCacheKey,
  buildFileMenuEntries,
  fenceFilePaths,
  inlineCodeFilePath,
  revealLabelKey,
} = await jiti.import("./file-context-menu.ts");

const cwd = "/Users/me/project";

test("inline code naming a file resolves against the cwd", () => {
  assert.equal(inlineCodeFilePath("租车营销Agent方案.md", cwd), "/Users/me/project/租车营销Agent方案.md");
  assert.equal(inlineCodeFilePath("  docs/plan.md  ", cwd), "/Users/me/project/docs/plan.md");
  assert.equal(inlineCodeFilePath("/Users/me/project/a.txt", cwd), "/Users/me/project/a.txt");
  assert.equal(inlineCodeFilePath("src/app.ts:42", cwd), "/Users/me/project/src/app.ts");
});

test("inline code that cannot be a file path is rejected before any request", () => {
  for (const text of [
    "",
    "   ",
    "npm",
    "useState",
    "https://example.com/a.md",
    "~/notes.md",
    "line one\nline two.md",
    "../outside.md",
    `${"a".repeat(300)}.md`,
  ]) {
    assert.equal(inlineCodeFilePath(text, cwd), null, JSON.stringify(text));
  }
  assert.equal(inlineCodeFilePath("notes.md", undefined), null);
});

test("app lists are cached per lowercase extension", () => {
  assert.equal(appListCacheKey("/a/b/README.MD"), "md");
  assert.equal(appListCacheKey("/a/b/archive.tar.gz"), "gz");
  assert.equal(appListCacheKey("/a/b/Makefile"), "");
  assert.equal(appListCacheKey("/a/b/.env"), "");
});

const labels = {
  open: "Open",
  openWith: "Open With",
  otherApp: "Other…",
  reveal: "Reveal in Finder",
  copyPath: "Copy Path",
  defaultApp: (name) => `${name} (default)`,
};

function recordingActions() {
  const calls = [];
  return {
    calls,
    actions: {
      open: () => calls.push(["open"]),
      openWith: (appPath) => calls.push(["openWith", appPath]),
      chooseOtherApp: () => calls.push(["chooseOtherApp"]),
      reveal: () => calls.push(["reveal"]),
      copyPath: () => calls.push(["copyPath"]),
    },
  };
}

test("menu lists Open, Open With, Reveal and Copy Path, marking the default app", () => {
  const { actions, calls } = recordingActions();
  const entries = buildFileMenuEntries(labels, actions, [
    { name: "Typora", path: "/Applications/Typora.app", isDefault: true },
    { name: "TextEdit", path: "/System/Applications/TextEdit.app", isDefault: false },
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.kind === "separator" ? "-" : entry.label),
    ["Open", "Open With", "-", "Reveal in Finder", "Copy Path"],
  );

  const submenu = entries[1];
  assert.equal(submenu.kind, "submenu");
  assert.deepEqual(
    submenu.items.map((entry) => entry.kind === "separator" ? "-" : entry.label),
    ["Typora (default)", "TextEdit", "-", "Other…"],
  );

  submenu.items[1].onSelect();
  submenu.items[3].onSelect();
  entries[0].onSelect();
  entries[3].onSelect();
  entries[4].onSelect();
  assert.deepEqual(calls, [
    ["openWith", "/System/Applications/TextEdit.app"],
    ["chooseOtherApp"],
    ["open"],
    ["reveal"],
    ["copyPath"],
  ]);
});

test("an empty app list still offers Other…, without a dangling separator", () => {
  const { actions } = recordingActions();
  const submenu = buildFileMenuEntries(labels, actions, [])[1];
  assert.deepEqual(submenu.items.map((entry) => entry.label), ["Other…"]);
});

test("without an app list (not macOS) there is no Open With submenu", () => {
  const { actions } = recordingActions();
  const entries = buildFileMenuEntries(labels, actions, null);
  assert.deepEqual(
    entries.map((entry) => entry.kind === "separator" ? "-" : entry.label),
    ["Open", "-", "Reveal in Finder", "Copy Path"],
  );
});

test("reveal wording follows the platform's file manager", () => {
  assert.equal(revealLabelKey("macos"), "fileMenu.revealInFinder");
  assert.equal(revealLabelKey("windows"), "fileMenu.revealInExplorer");
  assert.equal(revealLabelKey("linux"), "fileMenu.revealInFileManager");
  assert.equal(revealLabelKey(null), "fileMenu.revealInFileManager");
});

test("fenceFilePaths ties a fence to the saved path named just above it", () => {
  const md = "已保存: `/Users/me/doc/card.md`。以下为完整内容:\n\n```markdown\n# Title\n```\n";
  assert.deepEqual([...fenceFilePaths(md, "/proj")], [[3, "/Users/me/doc/card.md"]]);
});

test("fenceFilePaths resolves relative paths and takes the last path in the paragraph", () => {
  const md = "Compare `old.txt` with `src/new.ts`:\n```ts\nx\n```";
  assert.deepEqual([...fenceFilePaths(md, "/proj")], [[2, "/proj/src/new.ts"]]);
});

test("fenceFilePaths ignores commands, extensionless names and prose across other blocks", () => {
  assert.equal(fenceFilePaths("Run `npm test`:\n\n```bash\nnpm test\n```", "/p").size, 0);
  assert.equal(fenceFilePaths("Open `Makefile`:\n```make\nall:\n```", "/p").size, 0);
  const md = "See `a.md`\n\n```text\none\n```\n\n```text\ntwo\n```";
  assert.deepEqual([...fenceFilePaths(md, "/p")].map(([line]) => line), [3]);
});

test("fenceFilePaths does not read the inside of a fence as prose or fences", () => {
  const md = "`a.md`\n\n````markdown\n`b.md`\n```text\nx\n```\n````";
  assert.deepEqual([...fenceFilePaths(md, "/p")], [[3, "/p/a.md"]]);
});
