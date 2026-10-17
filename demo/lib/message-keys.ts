// React keys for the transcript that survive a message getting its entry id.
//
// A message the client appends itself (the optimistic user bubble, assistant
// messages streamed in this run) has no `.jsonl` entry id until the transcript
// is reloaded, so keying by `entryIds[idx] ?? idx` changed the key of every
// such message at that reload: React dropped the bubble and mounted a new one,
// which showed as the sent question flashing right after it was sent. Pending
// messages get a local key instead, and the entry id that later shows up at the
// same position with the same role takes that key over.

export interface MessageKeyTracker {
  /** entry id -> local key it inherited from its pending message */
  aliases: Map<string, string>;
  /** position -> local key and role of the pending message there last time */
  pending: Map<number, { key: string; role: string }>;
  nextLocal: number;
}

export function createMessageKeyTracker(): MessageKeyTracker {
  return { aliases: new Map(), pending: new Map(), nextLocal: 0 };
}

export function assignMessageKeys(
  tracker: MessageKeyTracker,
  messages: ReadonlyArray<{ role: string }>,
  entryIds: ReadonlyArray<string | undefined>,
): string[] {
  const keys: string[] = [];
  const nextPending = new Map<number, { key: string; role: string }>();
  messages.forEach((message, idx) => {
    const previous = tracker.pending.get(idx);
    const inherited = previous && previous.role === message.role ? previous.key : undefined;
    const entryId = entryIds[idx];
    if (entryId) {
      // Each local key is handed over once: the position leaves `pending`
      // below, so no other entry id can inherit it.
      if (inherited && !tracker.aliases.has(entryId)) tracker.aliases.set(entryId, inherited);
      keys.push(tracker.aliases.get(entryId) ?? entryId);
      return;
    }
    const key = inherited ?? `local-${tracker.nextLocal++}`;
    nextPending.set(idx, { key, role: message.role });
    keys.push(key);
  });
  tracker.pending = nextPending;
  return keys;
}
