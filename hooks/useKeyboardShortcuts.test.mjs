import assert from "node:assert/strict";
import test from "node:test";
import {
  handleGlobalEscape,
  handleOpenSettingsShortcut,
  handleShortcutActivation,
  registerAbortHandler,
} from "./useKeyboardShortcuts.ts";

function keydown(key, { tagName = "BUTTON", defaultPrevented = false } = {}) {
  return {
    key,
    target: { tagName },
    defaultPrevented,
    preventDefault() { this.defaultPrevented = true; },
  };
}

test("Escape stops a running agent when nothing else took the key", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), true);
  assert.equal(stopped, 1);
  assert.equal(event.defaultPrevented, true);
  // Focus on the page itself, as after a click on nothing in particular.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "BODY" })), true);
  assert.equal(stopped, 2);
  assert.equal(handleGlobalEscape(keydown("Enter")), false);
  assert.equal(stopped, 2);
});

test("an Escape something nearer already handled does not stop the agent too", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  // Settings, the Mermaid viewer or a menu closed on it and marked it handled.
  assert.equal(handleGlobalEscape(keydown("Escape", { defaultPrevented: true })), false);
  // ChatInput and other fields keep their own Escape.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "TEXTAREA" })), false);
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "INPUT" })), false);
  assert.equal(stopped, 0);
});

test("with no run to stop, Escape is left alone", () => {
  registerAbortHandler(null);
  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), false);
  assert.equal(event.defaultPrevented, false);
});

test("Cmd/Ctrl+, opens Settings unless it is already open or the key was taken", () => {
  let opened = 0;
  const open = () => { opened += 1; };
  const comma = (mods = {}) => ({ key: ",", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...mods });

  const ctrl = comma({ ctrlKey: true });
  assert.equal(handleOpenSettingsShortcut(ctrl, open), true);
  assert.equal(ctrl.defaultPrevented, true);
  assert.equal(handleOpenSettingsShortcut(comma({ metaKey: true }), open), true);
  assert.equal(opened, 2);

  assert.equal(handleOpenSettingsShortcut(comma(), open), false);
  assert.equal(handleOpenSettingsShortcut(comma({ ctrlKey: true, shiftKey: true }), open), false);
  assert.equal(handleOpenSettingsShortcut(comma({ ctrlKey: true, defaultPrevented: true }), open), false);
  assert.equal(handleOpenSettingsShortcut(comma({ ctrlKey: true }), undefined), false);
  assert.equal(opened, 2);
});

test("accelerator shortcuts require a primary modifier and reject taken keys", () => {
  const activation = (key, mods = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...mods,
  });

  assert.equal(handleShortcutActivation(activation("\\"), "\\"), false);
  assert.equal(handleShortcutActivation(activation("\\", { metaKey: true }), "\\"), true);
  assert.equal(handleShortcutActivation(activation("\\", { ctrlKey: true }), "\\"), true);
  assert.equal(handleShortcutActivation(activation("\\", { ctrlKey: true, shiftKey: true }), "\\"), false);
  assert.equal(handleShortcutActivation(activation("\\", { ctrlKey: true, altKey: true }), "\\"), false);
  assert.equal(handleShortcutActivation(activation("\\", { ctrlKey: true, defaultPrevented: true }), "\\"), false);
  assert.equal(handleShortcutActivation(activation("/", { metaKey: true }), "\\"), false);
});
