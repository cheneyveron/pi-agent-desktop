import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transform } from "esbuild";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const source = await readFile(new URL("./notification-store.ts", import.meta.url), "utf8");

test("global notices queue overflow and never auto-expire when an action is present", () => {
  assert.match(source, /const MAX_NOTICES = 4/);
  assert.match(source, /if \(next\.length > MAX_NOTICES\)/);
  assert.match(source, /filter\(\(notice\) => !notice\.exiting && !notice\.action && !notice\.persistent\)/);
  assert.match(source, /export const appNotify = \{/);
});

// Export the real store's snapshot only in this in-memory test module.
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve("react")).href;
const { code } = await transform(source.replace('from "react"', `from ${JSON.stringify(reactUrl)}`)
  + "\nexport { getSnapshot as snapshot };", { loader: "ts", format: "esm" });
const store = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("persistent progress updates in place and success starts a fresh expiry deadline", (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  store.resetAppNoticeStore();
  try {
    const id = store.appNotify.info({ message: "Generating", persistent: true });
    context.mock.timers.tick(120_000);
    assert.equal(store.snapshot()[0].exiting, undefined);
    assert.equal(store.updateAppNotice(id, { message: "Done", type: "success", persistent: false }), true);
    assert.equal(store.snapshot().length, 1);
    assert.equal(store.snapshot()[0].type, "success");
    context.mock.timers.tick(6999);
    assert.equal(store.snapshot()[0].exiting, undefined);
    context.mock.timers.tick(1);
    assert.equal(store.snapshot()[0].exiting, true);
    context.mock.timers.tick(180);
    assert.deepEqual(store.snapshot(), []);
  } finally { store.resetAppNoticeStore(); }
});

test("actionable failure persists, retry clears its action, and dismiss cannot be undone by update", (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  store.resetAppNoticeStore();
  try {
    const id = store.appNotify.info({ message: "Generating", persistent: true });
    store.updateAppNotice(id, { message: "Invalid key", type: "error", persistent: true,
      action: { label: "Settings", run() {} } });
    context.mock.timers.tick(120_000);
    assert.equal(store.snapshot()[0].exiting, undefined);
    store.updateAppNotice(id, { message: "Retrying", type: "info", persistent: true, action: undefined });
    assert.equal(store.snapshot()[0].action, undefined);
    store.dismissAppNotice(id);
    assert.equal(store.updateAppNotice(id, { message: "Too late" }), false);
    context.mock.timers.tick(180);
    assert.deepEqual(store.snapshot(), []);
    assert.equal(store.updateAppNotice(id, { message: "Too late" }), false);
  } finally { store.resetAppNoticeStore(); }
});
