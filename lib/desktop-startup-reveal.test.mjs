import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

// The window is built hidden and shown when the first screen is ready. Each
// link of that chain, and the fallbacks that keep the window from staying
// hidden, is pinned here: losing one brings back either the blank webview or a
// window that never appears.
test("the main window is built hidden and revealed through app_ready", async () => {
  const [window, shell, rust, native, capability, permissions] = await Promise.all([
    source("src-tauri/src/shell/window.rs"),
    source("src-tauri/src/shell/mod.rs"),
    source("src-tauri/src/lib.rs"),
    source("lib/desktop-native.ts"),
    source("src-tauri/capabilities/desktop-dialog.json"),
    source("src-tauri/permissions/desktop-shell.toml"),
  ]);

  assert.match(window, /\.visible\(false\)/);
  // Fallbacks: the load event for pages that never report, a deadline for pages that never load.
  assert.match(window, /schedule_reveal_after_page_load/);
  assert.match(rust, /schedule_reveal_deadline\(app\.handle\(\)\)/);
  assert.match(shell, /pub fn app_ready/);
  assert.match(rust, /\n\s+app_ready,/);
  assert.match(capability, /allow-app-ready/);
  assert.match(permissions, /commands\.allow = \["app_ready"\]/);
  assert.match(native, /invoke\("app_ready"/);
  // A login-time start stays in the tray instead of popping a window.
  assert.match(shell, /launched_at_login\(\) \|\| MAIN_WINDOW_REVEALED\.swap/);
});

test("the first screen reports ready from the placeholder and from a loaded chat", async () => {
  const [appShell, chatWindow] = await Promise.all([
    source("components/AppShell.tsx"),
    source("components/ChatWindow.tsx"),
  ]);
  assert.match(appShell, /useReportDesktopReady\(showPlaceholder, "placeholder"\)/);
  assert.match(chatWindow, /useReportDesktopReady\(!loading, "chat"\)/);
});

test("the custom stylesheet does not block the first paint", async () => {
  const layout = await source("app/layout.tsx");
  assert.match(layout, /href="\/api\/custom-css" media="print"/);
  assert.match(layout, /CUSTOM_CSS_ACTIVATE_SCRIPT/);
});

test("the packaged server reuses Node's compile cache", async () => {
  const [rust, launcher] = await Promise.all([
    source("src-tauri/src/lib.rs"),
    source("desktop/server-launcher.cjs"),
  ]);
  assert.match(rust, /PI_DESKTOP_COMPILE_CACHE_DIR/);
  assert.match(launcher, /enableCompileCache\(cacheDir\)/);
  // Not NODE_COMPILE_CACHE: every node process the agent starts would inherit it.
  assert.doesNotMatch(rust, /"NODE_COMPILE_CACHE"/);
});

// Showing a window that was hidden flashed an empty rectangle (transparent
// webview over vibrancy, repainted only once on screen). On macOS it comes back
// at alpha 0 and turns opaque when the page reports presented frames.
test("a hidden window comes back masked until the page has painted", async () => {
  const [appkit, shell, rust, capability, permissions] = await Promise.all([
    source("src-tauri/src/shell/window_appkit.rs"),
    source("src-tauri/src/shell/mod.rs"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/capabilities/desktop-dialog.json"),
    source("src-tauri/permissions/desktop-shell.toml"),
  ]);

  assert.match(appkit, /setAlphaValue: alpha/);
  assert.match(appkit, /invoke\("window_painted"\)/);
  // The mask always ends, even when the page never answers.
  assert.match(appkit, /PAINT_MASK_MAX/);
  assert.match(appkit, /end_paint_mask\(&app, "timed out"\)/);
  assert.match(shell, /show_hidden_window_masked\(app, &window\)/);
  assert.match(shell, /pub fn window_painted/);
  assert.match(rust, /\n\s+window_painted,/);
  assert.match(capability, /allow-window-painted/);
  assert.match(permissions, /commands\.allow = \["window_painted"\]/);
});
