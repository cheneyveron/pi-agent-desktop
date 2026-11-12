/** The pinned items first, each part in its given order (the sidebar's pinned projects). */
export function pinnedFirst<T>(items: readonly T[], isPinned: (item: T) => boolean): T[] {
  return [...items.filter(isPinned), ...items.filter((item) => !isPinned(item))];
}

/** Toggle one id in an id set, returning a new set (React state friendly). */
export function toggleId(ids: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
