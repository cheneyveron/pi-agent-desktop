"use client";

// Fork-owned: the desktop shell reopens the last file tabs on a cold start and
// keeps the workspace (session, cwd, file tabs, right panel) persisted for the
// next one (lib/workspace-state.ts). AppShell (upstream-owned) only calls this.

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { APP_PREF_KEYS, setPrefJson } from "@/lib/app-prefs";
import { workspaceFileTabsMatchContext, type PersistedWorkspace } from "@/lib/workspace-state";
import type { Tab } from "@/components/TabBar";

interface UseDesktopWorkspaceTabsOptions {
  desktopMode: boolean;
  initialSessionRestored: boolean;
  persistedWorkspace: PersistedWorkspace | null;
  sessionId: string | null;
  /** The selected session's cwd, else the new-session or active cwd. */
  cwd: string | null;
  showPlaceholder: boolean;
  fileTabs: Tab[];
  activeFileTabId: string | null;
  rightPanelOpen: boolean;
  setFileTabs: Dispatch<SetStateAction<Tab[]>>;
  setActiveFileTabId: Dispatch<SetStateAction<string | null>>;
  setRightPanelOpen: Dispatch<SetStateAction<boolean>>;
}

export function useDesktopWorkspaceTabs({
  desktopMode, initialSessionRestored, persistedWorkspace, sessionId, cwd, showPlaceholder,
  fileTabs, activeFileTabId, rightPanelOpen, setFileTabs, setActiveFileTabId, setRightPanelOpen,
}: UseDesktopWorkspaceTabsOptions) {
  const [workspaceHydrated, setWorkspaceHydrated] = useState(() => !desktopMode);

  // Reopen the last file tabs after the cold-start session/cwd restore settles.
  useEffect(() => {
    if (!desktopMode || !initialSessionRestored || workspaceHydrated) return;

    const canMatch = workspaceFileTabsMatchContext(
      persistedWorkspace,
      sessionId,
      cwd,
    );
    const hasSavedTabs = Boolean(persistedWorkspace?.fileTabs?.length);

    // Wait for sidebar auto-select before giving up on tab restore.
    if (hasSavedTabs && !canMatch && !cwd && !showPlaceholder) return;

    if (canMatch && persistedWorkspace) {
      const tabs: Tab[] = persistedWorkspace.fileTabs.map((tab) => ({
        id: `file:${tab.filePath}`,
        label: tab.label,
        filePath: tab.filePath,
        sourceSessionId: tab.sourceSessionId,
        initialDisplayMode: tab.initialDisplayMode,
      }));
      setFileTabs(tabs);
      const activeId = persistedWorkspace.activeFileTabId;
      setActiveFileTabId(
        activeId && tabs.some((tab) => tab.id === activeId)
          ? activeId
          : (tabs[0]?.id ?? null),
      );
      setRightPanelOpen(Boolean(persistedWorkspace.rightPanelOpen && tabs.length > 0));
    }
    setWorkspaceHydrated(true);
  }, [
    initialSessionRestored,
    desktopMode,
    workspaceHydrated,
    persistedWorkspace,
    sessionId,
    cwd,
    showPlaceholder,
    setFileTabs,
    setActiveFileTabId,
    setRightPanelOpen,
  ]);

  // Persist workspace so the next desktop cold start can restore chat + files.
  useEffect(() => {
    if (!desktopMode || !workspaceHydrated) return;
    setPrefJson(APP_PREF_KEYS.workspace, {
      sessionId,
      cwd,
      fileTabs: fileTabs.map((tab) => ({
        filePath: tab.filePath,
        label: tab.label,
        sourceSessionId: tab.sourceSessionId,
        initialDisplayMode: tab.initialDisplayMode,
      })),
      activeFileTabId,
      rightPanelOpen,
    } satisfies PersistedWorkspace);
  }, [
    workspaceHydrated,
    desktopMode,
    sessionId,
    cwd,
    fileTabs,
    activeFileTabId,
    rightPanelOpen,
  ]);
}
