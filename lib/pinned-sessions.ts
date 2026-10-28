import type { SessionFamily } from "./session-family";
import { APP_PREF_KEYS, getPrefJson, removePref, setPrefJson } from "./app-prefs";

/**
 * Pinned sessions, as in Claude Desktop: a pinned session (a chat or a project
 * session) leaves its section and is listed under "Pinned" above every group,
 * whatever its project's or chat's archive state. The pin is a browser
 * preference keyed by the root session id; unpinning sends the row back to
 * where it came from.
 */

function idSet(value: unknown): Set<string> {
  return Array.isArray(value)
    ? new Set(value.filter((id): id is string => typeof id === "string"))
    : new Set();
}

/**
 * Fold the chat-only pins of earlier builds into the session-wide list. Once the
 * new key exists it is the only source: the legacy key is dropped so that an old
 * build can never resurrect an unpinned chat.
 */
export function mergePinnedSessionIds(
  stored: unknown,
  legacyChatPins: unknown,
): { ids: Set<string>; migrated: boolean } {
  const legacy = idSet(legacyChatPins);
  if (Array.isArray(stored)) return { ids: idSet(stored), migrated: legacy.size > 0 };
  return { ids: legacy, migrated: legacy.size > 0 };
}

export function readPinnedSessionIds(): Set<string> {
  const { ids, migrated } = mergePinnedSessionIds(
    getPrefJson<unknown>(APP_PREF_KEYS.pinnedSessions),
    getPrefJson<unknown>(APP_PREF_KEYS.pinnedChats),
  );
  if (migrated) {
    if (ids.size > 0) setPrefJson(APP_PREF_KEYS.pinnedSessions, [...ids]);
    removePref(APP_PREF_KEYS.pinnedChats);
  }
  return ids;
}

/**
 * Split session families into the pinned ones and the rest, each by recency.
 * A family is pinned by its root (a subagent follows its parent).
 */
export function splitPinnedFamilies(
  families: readonly SessionFamily[],
  pinnedIds: ReadonlySet<string>,
): { pinned: SessionFamily[]; rest: SessionFamily[] } {
  const byRecency = [...families].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
  return {
    pinned: byRecency.filter((family) => pinnedIds.has(family.root.id)),
    rest: byRecency.filter((family) => !pinnedIds.has(family.root.id)),
  };
}
