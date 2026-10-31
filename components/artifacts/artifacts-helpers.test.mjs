import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { CHATS_SCOPE, artifactScope, filterArtifacts, scopeOptions } = await jiti.import("./artifacts-helpers.ts");

const item = (overrides) => ({
  sessionId: "s",
  sessionTitle: "Session",
  cwd: "/work/app",
  projectRoot: "/work/app",
  projectKey: "/work/app",
  scheduled: false,
  identifier: "page",
  title: "Page",
  type: "html",
  versionCount: 1,
  updated: "2026-10-01T00:00:00.000Z",
  activeContent: false,
  ...overrides,
});

test("a worktree shares its project's scope; every chat shares one scope", () => {
  assert.equal(artifactScope(item({ cwd: "/work/app-wt" })), "project:/work/app");
  assert.equal(artifactScope(item({ workspaceKind: "chat", cwd: "/chats/a", projectKey: "/chats/a" })), CHATS_SCOPE);
});

test("scope options list projects by name, then Chats", () => {
  const items = [
    item({ projectRoot: "/work/zeta", projectKey: "/work/zeta", cwd: "/work/zeta" }),
    item({ workspaceKind: "chat", cwd: "/chats/a" }),
    item({}),
    item({ identifier: "other" }),
  ];
  assert.deepEqual(scopeOptions(items, "Chats"), [
    { value: "project:/work/app", label: "app" },
    { value: "project:/work/zeta", label: "zeta" },
    { value: CHATS_SCOPE, label: "Chats" },
  ]);
});

test("filters by type and scope, empty meaning all", () => {
  const items = [item({ identifier: "a" }), item({ identifier: "b", type: "svg" }), item({ identifier: "c", workspaceKind: "chat" })];
  assert.deepEqual(filterArtifacts(items, "", "").map((x) => x.identifier), ["a", "b", "c"]);
  assert.deepEqual(filterArtifacts(items, "svg", "").map((x) => x.identifier), ["b"]);
  assert.deepEqual(filterArtifacts(items, "html", CHATS_SCOPE).map((x) => x.identifier), ["c"]);
});

const { svgImageSource, textExcerpt, thumbnailKind } = await jiti.import("./artifacts-helpers.ts");

test("thumbnails never need scripts: React keeps its icon", () => {
  assert.deepEqual(["svg", "mermaid", "html", "markdown", "code", "react"].map(thumbnailKind), ["image", "mermaid", "frame", "text", "text", "icon"]);
});

test("a Markdown excerpt drops block markers, rules and table separators", () => {
  const doc = "# Title\n\n> quoted **bold**\n- item one\n1. step\n---\n| a | b |\n|---|---|\n```js\nconst x = 1;\n```\nplain";
  assert.equal(textExcerpt(doc, "markdown"), "Title\nquoted bold\nitem one\nstep\n| a | b |\nconst x = 1;\nplain");
  assert.equal(textExcerpt("a\nb\nc", "code", 2), "a\nb");
});

test("an SVG image gets the namespace it needs", () => {
  assert.equal(decodeURIComponent(svgImageSource("<svg width=\"1\"></svg>").split(",")[1]), '<svg xmlns="http://www.w3.org/2000/svg" width="1"></svg>');
  const namespaced = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  assert.equal(decodeURIComponent(svgImageSource(namespaced).split(",")[1]), namespaced);
});

test("a page thumbnail is an SVG image wrapping the document", async () => {
  const { pageImageSvg, PAGE_THUMBNAIL_WIDTH } = await jiti.import("./artifacts-helpers.ts");
  const svg = pageImageSvg('<html xmlns="http://www.w3.org/1999/xhtml"><body>Hi</body></html>');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, new RegExp(`<foreignObject x="0" y="0" width="${PAGE_THUMBNAIL_WIDTH}"`));
  assert.match(svg, /<body>Hi<\/body><\/html><\/foreignObject><\/svg>$/);
});

test("files are keyed by path and filtered as created or edited", async () => {
  const { artifactKey, filterArtifacts, fileThumbnailKind, TYPE_ALL_ARTIFACTS, TYPE_ALL_FILES, TYPE_CREATED_FILES, TYPE_EDITED_FILES } = await jiti.import("./artifacts-helpers.ts");
  const page = item({ kind: "artifact", identifier: "page", type: "html" });
  const created = item({ kind: "file", sessionId: "a", path: "/w/new.md", created: true });
  const edited = item({ kind: "file", sessionId: "b", path: "/w/old.ts", created: false });
  assert.equal(artifactKey(created), artifactKey({ ...created, sessionId: "other" }));
  assert.notEqual(artifactKey(created), artifactKey(edited));
  const names = (type) => filterArtifacts([page, created, edited], type, "").map((entry) => (entry.kind === "file" ? entry.path : entry.identifier));
  assert.deepEqual(names(""), ["page", "/w/new.md", "/w/old.ts"]);
  assert.deepEqual(names(TYPE_ALL_ARTIFACTS), ["page"]);
  assert.deepEqual(names("html"), ["page"]);
  assert.deepEqual(names(TYPE_ALL_FILES), ["/w/new.md", "/w/old.ts"]);
  assert.deepEqual(names(TYPE_CREATED_FILES), ["/w/new.md"]);
  assert.deepEqual(names(TYPE_EDITED_FILES), ["/w/old.ts"]);
  assert.deepEqual(["a.PNG", "d.svg", "b.html", "c.md", "e.ts", "f.bin"].map(fileThumbnailKind), ["file-image", "file-image", "frame", "text", "code", "icon"]);
});
