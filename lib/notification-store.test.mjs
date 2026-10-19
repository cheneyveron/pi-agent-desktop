import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./notification-store.ts", import.meta.url), "utf8");

test("global notices queue overflow and never auto-expire when an action is present", () => {
  assert.match(source, /const MAX_NOTICES = 4/);
  assert.match(source, /if \(next\.length > MAX_NOTICES\)/);
  assert.match(source, /filter\(\(notice\) => !notice\.exiting && !notice\.action\)/);
  assert.match(source, /export const appNotify = \{/);
});
