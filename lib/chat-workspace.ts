import { randomBytes } from "node:crypto";
import { mkdir, readdir, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { samePath } from "./paths";

const CHAT_ROOT_DIRNAME = "chats";
const LEGACY_CHAT_WORKSPACE_DIRNAME = "chat-workspace";
/** An empty chat folder this old belongs to a chat that never got a first message. */
const EMPTY_FOLDER_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Every chat lives in a folder of its own under one root. The root itself is the cwd a
 * brand-new chat is requested with; the server swaps it for a fresh folder when the chat is
 * created, so the browser never builds a chat's path.
 */
export function chatWorkspaceDir(agentDir = getAgentDir()): string {
  return join(agentDir, CHAT_ROOT_DIRNAME);
}

/** The single shared cwd that chats used before each chat got a folder; those chats keep their old policy. */
export function legacyChatWorkspaceDir(agentDir = getAgentDir()): string {
  return join(agentDir, LEGACY_CHAT_WORKSPACE_DIRNAME);
}

/** Create the chat root and make sure it is private to the current user. */
export async function ensureChatWorkspace(agentDir = getAgentDir()): Promise<string> {
  const dir = chatWorkspaceDir(agentDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The root a new chat is requested with (not yet a folder of its own). */
export function isChatRootPath(cwd: string | null | undefined, agentDir = getAgentDir()): boolean {
  return Boolean(cwd && samePath(cwd, chatWorkspaceDir(agentDir)));
}

/** A chat's own folder: a direct child of the chat root. */
export function isChatFolderPath(cwd: string | null | undefined, agentDir = getAgentDir()): boolean {
  if (!cwd) return false;
  const parent = dirname(cwd.replace(/[\\/]+$/, ""));
  return samePath(parent, chatWorkspaceDir(agentDir)) && !isChatRootPath(cwd, agentDir);
}

export function isLegacyChatWorkspacePath(cwd: string | null | undefined, agentDir = getAgentDir()): boolean {
  return Boolean(cwd && samePath(cwd, legacyChatWorkspaceDir(agentDir)));
}

/** Whether a session with this cwd is a chat: the root, a chat's folder, or the legacy shared cwd. */
export function isChatWorkspacePath(cwd: string | null | undefined, agentDir = getAgentDir()): boolean {
  return isChatRootPath(cwd, agentDir) || isChatFolderPath(cwd, agentDir) || isLegacyChatWorkspacePath(cwd, agentDir);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Create a new chat's folder: `YYYYMMDD-HHMMSS-xxxxxxxx`, sortable and unique. */
export async function createChatFolder(agentDir = getAgentDir(), now = new Date()): Promise<string> {
  const root = await ensureChatWorkspace(agentDir);
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dir = join(root, `${stamp}-${randomBytes(4).toString("hex")}`);
    try {
      await mkdir(dir, { mode: 0o700 });
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not create a folder for the chat");
}

/** Make sure the cwd of an existing chat is there (the legacy cwd, or a folder that was pruned while empty). */
export async function ensureChatCwd(cwd: string, agentDir = getAgentDir()): Promise<void> {
  if (isChatFolderPath(cwd, agentDir) || isLegacyChatWorkspacePath(cwd, agentDir) || isChatRootPath(cwd, agentDir)) {
    await mkdir(cwd, { recursive: true, mode: 0o700 });
  }
}

/**
 * Remove chat folders that stayed empty for a day: a composer that prepared a chat
 * (to load its commands) and was never sent. A chat that has a first message and no files
 * loses its empty folder too, which `ensureChatCwd` brings back when the chat is opened.
 */
export async function pruneEmptyChatFolders(
  agentDir = getAgentDir(),
  options: { now?: number; keep?: ReadonlySet<string> } = {},
): Promise<number> {
  const root = chatWorkspaceDir(agentDir);
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const dir = join(root, name);
    if ([...(options.keep ?? [])].some((kept) => samePath(kept, dir))) continue;
    try {
      const info = await stat(dir);
      if (!info.isDirectory() || now - info.mtimeMs < EMPTY_FOLDER_GRACE_MS) continue;
      if ((await readdir(dir)).length > 0) continue;
      await rmdir(dir);
      removed += 1;
    } catch {
      // Raced with a chat that just wrote into it, or unreadable: leave it.
    }
  }
  return removed;
}
