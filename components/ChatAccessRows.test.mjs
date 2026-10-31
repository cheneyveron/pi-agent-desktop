import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ChatAccessRows } = await jiti.import("./ChatAccessRows.tsx");
const { ChatConfirmDialog } = await jiti.import("./ChatConfirmDialog.tsx");
const { ChatShellPrompt } = await jiti.import("./ChatShellPrompt.tsx");

const render = (element) => renderToStaticMarkup(React.createElement(I18nProvider, null, element));
const access = (state, extra = {}) => ({
  state: { chat: true, folder: "/home/me/.pi/agent/chats/20261022-101500-ab12cd34", unlocked: false, available: true, ...state },
  busy: false,
  error: null,
  reveal: async () => {},
  setUnlocked: async () => true,
  clearError: () => {},
  ...extra,
});

test("a chat with a folder shows what it can do, a way to open the folder and the computer switch", () => {
  const html = render(React.createElement(ChatAccessRows, { access: access({}), onToggleUnlocked() {} }));
  assert.match(html, />Chat</);
  assert.match(html, /Files stay in its own folder\. No shell\./);
  assert.match(html, /Show chat folder/);
  assert.match(html, /Let this chat use my computer/);
  assert.match(html, /aria-checked="false"/);
  assert.doesNotMatch(html, /data-on/);
});

test("an unlocked chat says so and shows the switch on", () => {
  const html = render(React.createElement(ChatAccessRows, { access: access({ unlocked: true }), onToggleUnlocked() {} }));
  assert.match(html, /Chat · computer/);
  assert.match(html, /Can run commands and use files anywhere\./);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /data-on/);
});

test("a legacy chat or a server open to other machines offers no folder row and no switch", () => {
  const legacy = render(React.createElement(ChatAccessRows, { access: access({ folder: null, available: false }), onToggleUnlocked() {} }));
  assert.match(legacy, /Older chat without its own folder/);
  assert.doesNotMatch(legacy, /Show chat folder/);
  assert.doesNotMatch(legacy, /Let this chat use my computer/);

  const exposed = render(React.createElement(ChatAccessRows, { access: access({ available: false }), onToggleUnlocked() {} }));
  assert.match(exposed, /Show chat folder/);
  assert.doesNotMatch(exposed, /Let this chat use my computer/);

  // Before the server has answered (a chat about to start) the row describes a chat with a folder.
  const unknown = render(React.createElement(ChatAccessRows, { access: null, onToggleUnlocked() {} }));
  assert.match(unknown, /Files stay in its own folder/);
  assert.doesNotMatch(unknown, /Let this chat use my computer/);
});

test("the switch is disabled while a change is being applied, and an error is shown", () => {
  const html = render(React.createElement(ChatAccessRows, {
    access: access({}, { busy: true, error: "Send a message first, then this chat can use the computer." }),
    onToggleUnlocked() {},
  }));
  assert.match(html, /role="menuitemcheckbox"[^>]*disabled/);
  assert.match(html, /role="alert"[^>]*>Send a message first/);
});

test("the confirm dialog offers its checkbox, a danger button and the error", () => {
  const html = render(React.createElement(ChatConfirmDialog, {
    title: "Delete this chat?",
    body: "The conversation is removed for good.",
    checkboxLabel: "Also move the chat's folder to the Trash",
    checkboxDefault: true,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    danger: true,
    error: "boom",
    onCancel() {},
    onConfirm() {},
  }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /Delete this chat\?/);
  assert.match(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /is-primary is-danger/);
  assert.match(html, /role="alert"[^>]*>boom/);
});

test("the shell prompt offers one button and shows an error", () => {
  const html = render(React.createElement(ChatShellPrompt, { busy: false, error: "Send a message first", onAllow() {} }));
  assert.match(html, /This needs a shell\. Allow this chat to use your computer\?/);
  assert.match(html, /Allow and continue/);
  assert.match(html, /role="alert"[^>]*>Send a message first/);
  assert.match(render(React.createElement(ChatShellPrompt, { busy: true, error: null, onAllow() {} })), /disabled/);
});
