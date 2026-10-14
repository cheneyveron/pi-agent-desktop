import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { isArtifactsPromptEnabled, writeArtifactsPromptEnabled } = await jiti.import("./artifact-settings.ts");

test("defaults on, persists the switch, and keeps unknown keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-settings-"));
  const path = join(dir, "pi-web", "settings.json");
  assert.equal(isArtifactsPromptEnabled(path), true);

  mkdirSync(join(dir, "pi-web"));
  writeFileSync(path, JSON.stringify({ other: 1 }));
  assert.equal(writeArtifactsPromptEnabled(false, path), false);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { other: 1, version: 1, artifactsPrompt: false });
  assert.equal(isArtifactsPromptEnabled(path), false);
  assert.equal(writeArtifactsPromptEnabled(true, path), true);
});

test("an unreadable file keeps the prompt on", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-settings-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, "{not json");
  assert.equal(isArtifactsPromptEnabled(path), true);
});
