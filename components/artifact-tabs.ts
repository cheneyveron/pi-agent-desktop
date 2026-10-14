import { getSessionArtifact, type ArtifactOpenRequest } from "@/lib/artifact-store";
import type { Tab } from "./TabBar";

/** An artifact open in the right panel. Not persisted: artifacts are re-read from the transcript. */
export interface ArtifactTab {
  id: string;
  sessionId: string;
  identifier: string;
  title: string;
  versionRequest?: { version?: number; nonce: number };
}

export function artifactTabId(sessionId: string, identifier: string): string {
  return `artifact:${sessionId}:${identifier}`;
}

/** Opens (or re-targets) the tab for a request; one tab per artifact identifier. */
export function upsertArtifactTab(tabs: ArtifactTab[], request: ArtifactOpenRequest, nonce: number): ArtifactTab[] {
  const id = artifactTabId(request.sessionId, request.identifier);
  const tab: ArtifactTab = {
    id,
    sessionId: request.sessionId,
    identifier: request.identifier,
    title: request.title,
    versionRequest: { version: request.version, nonce },
  };
  return tabs.some((item) => item.id === id)
    ? tabs.map((item) => item.id === id ? tab : item)
    : [...tabs, tab];
}

/** The label follows the newest version's title, which a regeneration may change. */
export function artifactPanelTab(tab: ArtifactTab): Tab {
  const title = getSessionArtifact(tab.sessionId, tab.identifier)?.versions.at(-1)?.title || tab.title;
  return { id: tab.id, label: title, filePath: title, kind: "artifact" };
}

/**
 * Artifact tabs of the conversation now shown. Tabs from another one cannot
 * ask for fixes, go stale, and vanish once the store forgets that session, so
 * switching conversations closes them. Returns `tabs` itself when nothing goes.
 */
export function artifactTabsForSession(tabs: ArtifactTab[], sessionId: string | null | undefined): ArtifactTab[] {
  const kept = tabs.filter((tab) => tab.sessionId === sessionId);
  return kept.length === tabs.length ? tabs : kept;
}
