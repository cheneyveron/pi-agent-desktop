import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("a native notification opens its session only when it is clicked", async () => {
  const [notify, appShell, rust, lib, capability, permissions] = await Promise.all([
    source("lib/desktop-notify.ts"),
    source("components/AppShell.tsx"),
    source("src-tauri/src/shell/notification.rs"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/capabilities/desktop-dialog.json"),
    source("src-tauri/permissions/desktop-shell.toml"),
  ]);

  // Posted through the shell, which reports clicks; the plugin's send cannot.
  assert.match(notify, /invoke\("show_session_notification"/);
  assert.doesNotMatch(notify, /plugin-notification/);
  assert.match(lib, /show_session_notification,/);
  assert.match(capability, /"allow-show-session-notification"/);
  assert.match(permissions, /commands\.allow = \["show_session_notification"\]/);

  // The event is emitted only after a click on the notification itself.
  assert.match(rust, /pub const NOTIFICATION_CLICKED_EVENT: &str = "pi-agent-notification-clicked";/);
  assert.match(rust, /if !wait_for_click\(&app, &title, &body\) \{\s*return;\s*\}/);
  assert.match(rust, /response == NotificationResponse::Click/);
  assert.match(rust, /\*response == NotificationResponse::Default/);
  assert.match(notify, /listen<string>\("pi-agent-notification-clicked"/);
  assert.match(appShell, /onDesktopNotificationClicked\(/);

  // Window focus is never taken as a click (it jumped to the session whenever
  // the user switched back to the app).
  assert.doesNotMatch(notify, /onFocusChanged/);
});
