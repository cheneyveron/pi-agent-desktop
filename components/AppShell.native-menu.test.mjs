import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useNativeAppMenu.ts", import.meta.url), "utf8");
const rustSource = await readFile(
  new URL("../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);
const rustShellSource = await readFile(
  new URL("../src-tauri/src/shell/macos_menu.rs", import.meta.url),
  "utf8",
);

test("routes native macOS menu actions into app state", () => {
  assert.match(appShellSource, /useNativeAppMenu\(handleNativeMenuAction\)/);
  assert.match(appShellSource, /payload === "new-session"/);
  assert.match(appShellSource, /payload === "settings-general" \|\| payload === "settings-models"/);
  assert.match(appShellSource, /setSettingsSection\(payload === "settings-general" \? "general" : "models"\)/);
  assert.match(hookSource, /listen<string>\("pi-agent-menu-action"/);
});

test("installs the standard macOS app menu", () => {
  assert.match(rustSource, /use shell::\{[\s\S]*?build_macos_app_menu/);
  assert.match(rustShellSource, /pub fn build_macos_app_menu\(app: &AppHandle\)/);
  assert.match(rustShellSource, /PredefinedMenuItem::about/);
  assert.match(rustShellSource, /PredefinedMenuItem::services/);
  assert.match(rustShellSource, /PredefinedMenuItem::undo/);
  assert.match(rustShellSource, /PredefinedMenuItem::fullscreen/);
  assert.match(rustShellSource, /app\.set_menu\(menu\)\?/);
});
