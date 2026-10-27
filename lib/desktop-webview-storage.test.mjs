import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Unread markers, composer drafts and open tabs live in the webview's
// localStorage. On macOS that is ~/Library/WebKit/<id>; the upgrade-time cache
// clear once deleted the whole folder, so every update lost them.
test("the cache clears never delete the macOS WebsiteData folder that holds localStorage", async () => {
  const rust = await readFile(new URL("../src-tauri/src/native_prefs.rs", import.meta.url), "utf8");
  const code = rust.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /Library\/WebKit/, "no cache clear may target ~/Library/WebKit/<id>");
  const upgradeClear = code.match(/fn clear_webview_caches\(app: &AppHandle\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(upgradeClear, "clear_webview_caches exists");
  assert.match(upgradeClear, /app_cache_dir\(\)[\s\S]*?join\("WebKit"\)/, "macOS clears the HTTP cache under ~/Library/Caches/<id>/WebKit");
});
