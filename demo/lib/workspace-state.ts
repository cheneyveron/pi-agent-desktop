import { getInitialNavigation, type InitialNavigation } from "./initial-navigation.ts";

export type PersistedFileTab = {
  filePath: string;
  label: string;
  sourceSessionId?: string | null;
  initialDisplayMode?: "source" | "preview" | "diff";
};

export type PersistedWorkspace = {
  sessionId: string | null;
  cwd: string | null;
  fileTabs: PersistedFileTab[];
  activeFileTabId: string | null;
  rightPanelOpen: boolean;
};

/**
 * URL params win. Otherwise fall back to the last session the user had open so
 * desktop cold starts reopen the previous chat instead of Get Started / a blank
 * new session.
 */
export function resolveInitialNavigation(
  searchParams: Pick<URLSearchParams, "get">,
  workspace: PersistedWorkspace | null,
): InitialNavigation {
  const fromUrl = getInitialNavigation(searchParams);
  if (fromUrl.sessionId || fromUrl.requestedCwd) return fromUrl;
  if (workspace?.sessionId) {
    return { requestedCwd: null, sessionId: workspace.sessionId, sidebarCollapsed: false };
  }
  return fromUrl;
}

export function workspaceFileTabsMatchContext(
  workspace: PersistedWorkspace | null,
  sessionId: string | null,
  cwd: string | null,
): boolean {
  if (!workspace?.fileTabs?.length) return false;
  if (workspace.sessionId && sessionId && workspace.sessionId === sessionId) return true;
  if (workspace.cwd && cwd && workspace.cwd === cwd) return true;
  return false;
}
