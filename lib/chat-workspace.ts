import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { samePath } from "./paths";

const CHAT_WORKSPACE_DIRNAME = "chat-workspace";

/** The hidden cwd Pi needs for chats that do not belong to a project. */
export function chatWorkspaceDir(agentDir = getAgentDir()): string {
  return join(agentDir, CHAT_WORKSPACE_DIRNAME);
}

/** Create the chat workspace and make sure it is private to the current user. */
export async function ensureChatWorkspace(agentDir = getAgentDir()): Promise<string> {
  const dir = chatWorkspaceDir(agentDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function isChatWorkspacePath(cwd: string | null | undefined, agentDir = getAgentDir()): boolean {
  return Boolean(cwd && samePath(cwd, chatWorkspaceDir(agentDir)));
}
