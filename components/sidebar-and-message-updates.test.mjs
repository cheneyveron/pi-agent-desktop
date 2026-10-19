import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebarSource = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const messageSource = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");

test("session rows keep the action menu reachable on touch devices", () => {
  assert.match(sidebarSource, /matchMedia\?\.\("\(hover: none\)"\)/);
  assert.match(sidebarSource, /hovered \|\| treeFocused \|\| touchMode \|\| menuOpen \?/);
});

test("message actions stay reachable for keyboard and touch users", () => {
  assert.match(messageSource, /className="message-copy-actions"/);
  assert.match(messageSource, /className="user-msg-actions"/);
  assert.match(messageSource, /aria-live="polite"/);
  assert.doesNotMatch(messageSource, /pointerEvents: hovered/);
  assert.doesNotMatch(messageSource, /opacity: hovered/);
});

test("busy sessions disable in-session edits without hiding the action", () => {
  const chatWindowSource = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chatWindowSource, /onEditContent=\{handleEditContent\}/);
  assert.match(chatWindowSource, /editDisabled=\{sessionBusy\}/);
  assert.match(messageSource, /disabled=\{editBlocked\}/);
  assert.match(messageSource, /t\("i18n\.editFromHereBusyTitle"\)/);
});

test("rename and delete failures surface an error instead of being swallowed", () => {
  assert.match(sidebarSource, /sidebar\.renameFailed/);
  assert.match(sidebarSource, /sidebar\.deleteFailed/);
  assert.match(sidebarSource, /role="alert"/);
  assert.doesNotMatch(sidebarSource, /\/\* ignore \*\//);
});

test("interrupted tool calls render a cancelled marker instead of success styling", () => {
  // Loaded (non-streaming) message + no paired result ⇒ aborted.
  assert.match(messageSource, /aborted=\{!isStreaming && !result\}/);
  assert.match(messageSource, /t\("chat\.toolCancelled"\)/);
  // Aborted styling is neutral slate, distinct from the green success border.
  assert.match(messageSource, /rgba\(148,163,184,0\.4\)/);
});
