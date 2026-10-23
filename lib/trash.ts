import { randomBytes } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { userHome } from "./user-home";

/**
 * Where a removed folder goes so the user can still get it back: the system Trash on macOS
 * and Linux (same volume as the home folder, so a rename is enough), and an app-owned
 * `chats-trash` folder elsewhere or when the system Trash cannot be written.
 */
export async function moveFolderToTrash(
  folder: string,
  options: { platform?: NodeJS.Platform; home?: string; agentDir?: string; now?: Date } = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? userHome();
  const name = basename(folder);
  try {
    if (platform === "darwin") return await renameUnique(folder, join(home, ".Trash"), name);
    if (platform === "linux") {
      const dataHome = process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
      const trash = join(dataHome, "Trash");
      const target = await renameUnique(folder, join(trash, "files"), name);
      const infoDir = join(trash, "info");
      await mkdir(infoDir, { recursive: true });
      const when = (options.now ?? new Date()).toISOString().slice(0, 19);
      await writeFile(
        join(infoDir, `${basename(target)}.trashinfo`),
        `[Trash Info]\nPath=${encodeURI(folder)}\nDeletionDate=${when}\n`,
      );
      return target;
    }
  } catch {
    // Fall through to the app's own trash.
  }
  return renameUnique(folder, join(options.agentDir ?? getAgentDir(), "chats-trash"), name);
}

async function renameUnique(from: string, toDir: string, name: string): Promise<string> {
  await mkdir(toDir, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const target = join(toDir, attempt === 0 ? name : `${name}-${randomBytes(3).toString("hex")}`);
    if (await exists(target)) continue;
    await rename(from, target);
    return target;
  }
  throw new Error("Could not find a free name in the Trash");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
