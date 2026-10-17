// Per-session chat scroll memory. Module-level (not component refs) so the
// caches survive ChatWindow remounts such as the new-chat sessionKey bump.

const MAX_ENTRIES = 50;

/** Insertion-ordered Map used as a small LRU: set() refreshes recency. */
export class LruNumberCache {
  private map = new Map<string, number>();

  get(key: string): number | undefined {
    return this.map.get(key);
  }

  set(key: string, value: number): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

/** scrollTop of the chat container, keyed by session identity. */
export const sessionScrollTops = new LruNumberCache();

/** Lazy-load page window (visibleCount), keyed by session identity. */
export const sessionVisibleCounts = new LruNumberCache();

/** Within this distance of the bottom the user counts as following the tail. */
export const BOTTOM_FOLLOW_EPSILON_PX = 32;

/**
 * Remember where the user left a session. A viewport at (or within epsilon of)
 * the bottom is deliberately forgotten: the restore path falls back to
 * scroll-to-bottom when nothing is stored, so a user who was following new
 * content keeps following it instead of landing on a stale pixel offset.
 */
export function rememberScrollPosition(
  key: string,
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distanceFromBottom <= BOTTOM_FOLLOW_EPSILON_PX) {
    sessionScrollTops.delete(key);
  } else {
    sessionScrollTops.set(key, el.scrollTop);
  }
}
