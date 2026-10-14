import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

/**
 * The window chrome moved out of AppShell.tsx, which used these expressions
 * inline:
 *
 *   className={`app-topbar${desktopPlatform === "macos" && … }`}
 *   data-tauri-drag-region={desktopPlatform ? true : undefined}
 *   {desktopPlatform && desktopPlatform !== "macos" && ( …buttons… )}
 *
 * The extraction replaced them with `isMacOS`, `dragRegionProps` and
 * `isDesktop && !isMacOS`. These tests pin that equivalence for every platform
 * value, so a refactor cannot quietly change which chrome a platform gets.
 */

// The real implementation, not a restatement of it — a copy would keep passing
// after someone changed the source. The alias mirrors tsconfig's "@/*" paths,
// which jiti does not read on its own.
const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const jiti = createJiti(import.meta.url, { alias: { "@": rootDir } });
const { desktopChromeFor: chromeFor } = await jiti.import("./useDesktopChrome.ts");

const PLATFORMS = ["macos", "windows", "linux", null];

test("drag region matches the original data-tauri-drag-region expression", () => {
  for (const platform of PLATFORMS) {
    const legacy = platform ? true : undefined;
    const actual = chromeFor(platform).dragRegionProps["data-tauri-drag-region"];
    assert.equal(actual, legacy, `platform ${platform}`);
  }
});

test("mac inset matches the original desktopPlatform === 'macos' expression", () => {
  for (const platform of PLATFORMS) {
    assert.equal(chromeFor(platform).isMacOS, platform === "macos", `platform ${platform}`);
  }
});

test("custom window buttons render exactly where they used to", () => {
  for (const platform of PLATFORMS) {
    const legacy = Boolean(platform && platform !== "macos");
    const chrome = chromeFor(platform);
    assert.equal(chrome.isDesktop && !chrome.isMacOS, legacy, `platform ${platform}`);
  }
});

test("a browser build gets no desktop chrome at all", () => {
  const chrome = chromeFor(null);
  assert.equal(chrome.isDesktop, false);
  assert.equal(chrome.isMacOS, false);
  assert.deepEqual(chrome.dragRegionProps, {});
});

test("macOS keeps its native traffic lights and draws no buttons", () => {
  const chrome = chromeFor("macos");
  assert.equal(chrome.isDesktop, true);
  assert.equal(chrome.isMacOS, true);
  assert.equal(chrome.isDesktop && !chrome.isMacOS, false);
  assert.equal(chrome.dragRegionProps["data-tauri-drag-region"], true);
});

test("macOS traffic lights share the sidebar controls' centre line", () => {
  const css = readFileSync(new URL("../../app/native-theme.css", import.meta.url), "utf8");
  // MAC_TRAFFIC_LIGHT_Y compensates for AppKit's button offset and lands its
  // centre at 24pt. A 48px controls row is centred at the same 24px without
  // pushing the sidebar header down (the bug reported in #108).
  assert.match(css, /\.session-sidebar-header--mac-inset \{[\s\S]*?padding-top: 0 !important;/);
  assert.match(css, /\.sidebar-controls-row \{[\s\S]*?height: 48px;/);
});

test("windows and linux draw their own buttons", () => {
  for (const platform of ["windows", "linux"]) {
    const chrome = chromeFor(platform);
    assert.equal(chrome.isDesktop && !chrome.isMacOS, true, `platform ${platform}`);
    assert.equal(chrome.dragRegionProps["data-tauri-drag-region"], true, `platform ${platform}`);
  }
});
