import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";

// Artifacts and files the user starred on the Artifacts page. A file is one
// row however many conversations touched it, so it is keyed by path; an
// artifact belongs to its conversation, so it is keyed by session and identifier.

const VERSION = 1;

export type FavoriteTarget =
  | { kind: "file"; path: string }
  | { kind: "artifact"; sessionId: string; identifier: string };

export function getFavoritesPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "artifact-favorites.json");
}

export function favoriteKey(target: FavoriteTarget): string {
  return target.kind === "file" ? `file\u0000${target.path}` : `artifact\u0000${target.sessionId}\u0000${target.identifier}`;
}

/** Every starred key; a missing or unreadable file means none. */
export function readFavorites(favoritesPath: string | null = getFavoritesPath()): Set<string> {
  const favorites = new Set<string>();
  if (!favoritesPath) return favorites;
  try {
    const data = JSON.parse(readFileSync(favoritesPath, "utf8")) as { keys?: unknown };
    if (Array.isArray(data.keys)) for (const key of data.keys) if (typeof key === "string") favorites.add(key);
  } catch {
    // Nothing starred yet, or a file this version cannot read.
  }
  return favorites;
}

export function writeFavorite(target: FavoriteTarget, favorite: boolean, favoritesPath = getFavoritesPath()): void {
  const favorites = readFavorites(favoritesPath);
  if (favorite) favorites.add(favoriteKey(target));
  else favorites.delete(favoriteKey(target));
  mkdirSync(dirname(favoritesPath), { recursive: true });
  writePrivateFileAtomicSync(favoritesPath, JSON.stringify({ version: VERSION, keys: [...favorites] }, null, 2));
}
