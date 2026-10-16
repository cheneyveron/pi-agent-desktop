// The diff a file tool (edit) reported for a file, handed from the chat's
// "Files changed" list to the file viewer. It takes precedence over the git
// diff, so the viewer shows what the tool changed even outside a git repo or
// when the working tree holds other edits. Kept in memory only: it describes
// the turn the user clicked, not a durable property of the file.

const patches = new Map<string, string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Remember `patch` for `filePath`; an empty/missing patch clears the entry. */
export function setTurnFilePatch(filePath: string, patch: string | undefined): void {
  const current = patches.get(filePath);
  if (patch) {
    if (current === patch) return;
    patches.set(filePath, patch);
  } else {
    if (current === undefined) return;
    patches.delete(filePath);
  }
  emit();
}

export function getTurnFilePatch(filePath: string): string | undefined {
  return patches.get(filePath);
}

export function subscribeTurnFilePatches(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
