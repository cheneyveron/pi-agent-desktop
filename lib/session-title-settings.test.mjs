import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { isAutoTitleEnabled, writeAutoTitleEnabled } = await jiti.import("./session-title-settings.ts");

test("defaults on (fork), persists the switch, and keeps unknown keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-settings-"));
  const path = join(dir, "pi-web", "settings.json");
  assert.equal(isAutoTitleEnabled(path), true);

  mkdirSync(join(dir, "pi-web"));
  writeFileSync(path, JSON.stringify({ artifactsPrompt: false }));
  assert.equal(writeAutoTitleEnabled(true, path), true);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { artifactsPrompt: false, version: 1, autoTitle: true });
  assert.equal(writeAutoTitleEnabled(false, path), false);
});

test("an unreadable file keeps it off; only an explicit false turns it off otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-settings-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, "{not json");
  assert.equal(isAutoTitleEnabled(path), false);
  writeFileSync(path, JSON.stringify({ autoTitle: "yes" }));
  assert.equal(isAutoTitleEnabled(path), true);
  writeFileSync(path, JSON.stringify({ autoTitle: false }));
  assert.equal(isAutoTitleEnabled(path), false);
});
