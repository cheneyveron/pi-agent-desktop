"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Module-level registry — ChatWindow registers the abort handler here so that
// the global Esc listener in AppShell can call it without prop-drilling.
// ---------------------------------------------------------------------------
let globalAbortHandler: (() => void) | null = null;

/**
 * Register (or clear) the abort handler for the global Esc shortcut.
 * Call this from ChatWindow whenever agentRunning or handleAbort changes.
 */
export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

/**
 * The global Esc shortcut: stops the running agent, unless the key belongs to
 * something else. Typed into a textarea or input, it is that field's (ChatInput
 * has its own Esc logic). Marked handled already (`defaultPrevented`), it was
 * something nearer's: Settings, a menu or a viewer that closed on it. Those
 * listen on `document` or below and run before this one on `window`, and
 * closing them must not stop a run as well. Returns whether it stopped the
 * agent.
 */
export function handleGlobalEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || !globalAbortHandler) return false;

  const tag = (event.target as HTMLElement | null)?.tagName;
  // Let textarea/input handle Esc internally (ChatInput menus / stop).
  if (tag === "TEXTAREA" || tag === "INPUT") return false;

  event.preventDefault();
  globalAbortHandler();
  return true;
}

// ---------------------------------------------------------------------------
// Hook: global keyboard shortcuts
// ---------------------------------------------------------------------------

interface UseGlobalKeyboardShortcutsOptions {
  /** Called when ⌘N (macOS) / Ctrl+N is pressed. Receives current cwd. */
  onNewSession?: (cwd: string) => void;
  /** The currently selected project directory (sidebar cwd). */
  activeCwd?: string | null;
  /** Called by \\ to close the preview panel and return focus to the composer. */
  onCloseRightPanel?: () => void;
  /** Called by ⌘, (macOS) / Ctrl+, to open Settings. */
  onOpenSettings?: () => void;
  /** Called by ⌘/ (macOS) / Ctrl+/ to show the shortcut reference. */
  onShortcutHelp?: () => void;
  /** Called by ⌘B / Ctrl+B; browsers keep their own Cmd/Ctrl+B on macOS. */
  onToggleSidebar?: () => void;
  /** Called by ⌘L / Ctrl+L; browsers reserve the macOS Cmd+L variant. */
  onFocusComposer?: () => void;
}

/**
 * ⌘, / Ctrl+, opens Settings, the shortcut every desktop app's preferences use.
 * The macOS menu bar already binds ⌘, (src-tauri/src/shell/macos_menu.rs); this
 * covers Windows, Linux and the browser. Returns whether it took the key.
 */
export function handleOpenSettingsShortcut(event: KeyboardEvent, onOpenSettings: (() => void) | undefined): boolean {
  if (event.key !== "," || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false;
  if (event.defaultPrevented || !onOpenSettings) return false;
  event.preventDefault();
  onOpenSettings();
  return true;
}

/** Shortcuts that behave like desktop accelerators: primary modifier required. */
export function handleShortcutActivation(event: KeyboardEvent, key: string): boolean {
  return event.key === key
    && (event.metaKey || event.ctrlKey)
    && !event.shiftKey
    && !event.altKey
    && !event.defaultPrevented;
}

/**
 * Register global keyboard shortcuts for the application.
 *
 * Shortcuts handled here:
 *   Esc              – stop the running agent (via module-level abort handler)
 *   ⌘N / Ctrl+N      – create a new session in the active project directory
 *                      (Ctrl+Alt+N still works for backwards familiarity)
 *   ⌘, / Ctrl+,      – open Settings at the last section
 *   ⌘/ / Ctrl+/      – show keyboard shortcuts
 *   ⌘B  / Ctrl+B     – toggle the sidebar (non-macOS browsers may reserve it)
 *   ⌘L  / Ctrl+L     – focus the composer (macOS browsers may reserve it)
 *
 * Note: Esc inside <textarea> or <input> is deliberately NOT handled here.
 * ChatInput manages its own Esc logic (closing slash / @ file menus, stopping
 * the agent when no menu is open) because it needs intimate knowledge of menu
 * state that is local to that component. Nor is an Esc something nearer
 * already handled (see `handleGlobalEscape()`).
 */
export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const {
    onNewSession,
    activeCwd,
    onCloseRightPanel,
    onOpenSettings,
    onShortcutHelp,
    onToggleSidebar,
    onFocusComposer,
  } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // ---- Esc: stop agent ----
      if (e.key === "Escape") {
        handleGlobalEscape(e);
        return;
      }

      // ---- Cmd/Ctrl+\: hide the preview and go back to the conversation ----
      if (
        handleShortcutActivation(e, "\\")
        && onCloseRightPanel
      ) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        const composing = target?.isContentEditable;
        const insideComposer = Boolean(target?.closest?.(".chat-input-shell"));
        if (!insideComposer && !composing && tag !== "TEXTAREA" && tag !== "INPUT" && tag !== "SELECT") {
          e.preventDefault();
          onCloseRightPanel();
        }
      }

      if (handleOpenSettingsShortcut(e, onOpenSettings)) return;

      if (handleShortcutActivation(e, "/") && onShortcutHelp) {
        e.preventDefault();
        onShortcutHelp();
        return;
      }

      if (handleShortcutActivation(e, "b") && onToggleSidebar) {
        e.preventDefault();
        onToggleSidebar();
        return;
      }

      if (handleShortcutActivation(e, "l") && onFocusComposer) {
        e.preventDefault();
        onFocusComposer();
        return;
      }

      // ---- ⌘N / Ctrl+N: new session ----
      // Note: regular browsers reserve ⌘N/Ctrl+N for "new window"; this works
      // in the desktop (Tauri) build where the page receives the event.
      if (e.key.toLowerCase() === "n" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeCwd,
    onFocusComposer,
    onNewSession,
    onCloseRightPanel,
    onOpenSettings,
    onShortcutHelp,
    onToggleSidebar,
  ]);
}
