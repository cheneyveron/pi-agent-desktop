import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppNoticeShelf.tsx", import.meta.url), "utf8");
const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("the app notice shelf is accessible and actionable", () => {
  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /className=\{`notice-shelf-item app-notice-item/);
  assert.match(source, /runAppNoticeAction\(notice\.id\)/);
  assert.match(source, /dismissAppNotice\(notice\.id\)/);
});

test("sidebar operation errors use the global shelf instead of private portals", () => {
  assert.match(sidebar, /appNotify\.error\(\{ message \}\)/);
  assert.doesNotMatch(sidebar, /const \[actionError, setActionError\]/);
  assert.doesNotMatch(sidebar, /role="alert"[\s\S]*?position: "fixed", bottom: 26/);
});
