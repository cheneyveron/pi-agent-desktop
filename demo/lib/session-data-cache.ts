import type { AgentMessage, SessionTreeNode } from "@/lib/types";

export interface CachedSessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}

const CACHE_TTL_MS = 10_000;
const sessionDataCache = new Map<string, { data: CachedSessionData; cachedAt: number }>();
const prefetches = new Map<string, Promise<CachedSessionData | null>>();

export function getCachedSessionData(sessionId: string): CachedSessionData | null {
  const cached = sessionDataCache.get(sessionId);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    sessionDataCache.delete(sessionId);
    return null;
  }
  return cached.data;
}

export function cacheSessionData(sessionId: string, data: CachedSessionData): void {
  sessionDataCache.set(sessionId, { data, cachedAt: Date.now() });
}

/** Warm a session while its sidebar row is already under the pointer. */
export function prefetchSessionData(sessionId: string): Promise<CachedSessionData | null> {
  const cached = getCachedSessionData(sessionId);
  if (cached) return Promise.resolve(cached);
  const pending = prefetches.get(sessionId);
  if (pending) return pending;

  const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
  const request = fetch(`/api/sessions/${encodeURIComponent(sessionId)}?${params}`)
    .then(async (response) => {
      if (!response.ok) return null;
      const data = await response.json() as CachedSessionData;
      cacheSessionData(sessionId, data);
      return data;
    })
    .catch(() => null)
    .finally(() => prefetches.delete(sessionId));

  prefetches.set(sessionId, request);
  return request;
}
