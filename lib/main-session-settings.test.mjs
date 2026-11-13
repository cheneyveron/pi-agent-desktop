import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_MAIN_SESSION_SETTINGS,
  parseMainSessionSettings,
  parseMainSessionSettingsPatch,
  piWebSettingsFile,
  readMainSessionSettings,
} from "./main-session-settings.ts";

test("the main session and its automatic continue are off by default", () => {
  assert.deepEqual(DEFAULT_MAIN_SESSION_SETTINGS, { enabled: false, autoContinue: false, takeoverMinutes: 5 });
  assert.deepEqual(parseMainSessionSettings(undefined), DEFAULT_MAIN_SESSION_SETTINGS);
  // Only a literal true turns a switch on; a bad delay falls back to five minutes.
  assert.deepEqual(parseMainSessionSettings({ enabled: "yes", autoContinue: 1, takeoverMinutes: 0 }), DEFAULT_MAIN_SESSION_SETTINGS);
  assert.deepEqual(parseMainSessionSettings({ enabled: true, autoContinue: true, takeoverMinutes: 15 }), { enabled: true, autoContinue: true, takeoverMinutes: 15 });
});

test("reads the mainSession key of Pi Web's settings file; a missing or broken file reads as off", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-main-settings-"));
  const file = piWebSettingsFile(agentDir);
  assert.equal(file, join(agentDir, "pi-web", "settings.json"));
  assert.deepEqual(readMainSessionSettings(file), DEFAULT_MAIN_SESSION_SETTINGS);
  mkdirSync(join(agentDir, "pi-web"), { recursive: true });
  writeFileSync(file, "{ not json");
  assert.deepEqual(readMainSessionSettings(file), DEFAULT_MAIN_SESSION_SETTINGS);
  writeFileSync(file, JSON.stringify({ version: 1, autoTitle: true, mainSession: { enabled: true, takeoverMinutes: 10 } }));
  assert.deepEqual(readMainSessionSettings(file), { enabled: true, autoContinue: false, takeoverMinutes: 10 });
});

test("an update names at least one field and only valid values", () => {
  assert.deepEqual(parseMainSessionSettingsPatch({ enabled: true }), { enabled: true });
  assert.deepEqual(parseMainSessionSettingsPatch({ autoContinue: false, takeoverMinutes: 30 }), { autoContinue: false, takeoverMinutes: 30 });
  assert.throws(() => parseMainSessionSettingsPatch({}), /required/);
  assert.throws(() => parseMainSessionSettingsPatch([]), /object/);
  assert.throws(() => parseMainSessionSettingsPatch({ enabled: "true" }), /enabled must be a boolean/);
  assert.throws(() => parseMainSessionSettingsPatch({ takeoverMinutes: 0 }), /takeoverMinutes/);
  assert.throws(() => parseMainSessionSettingsPatch({ takeoverMinutes: "5" }), /takeoverMinutes/);
});
