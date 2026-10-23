import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitAttachedFiles } from "./chat-attachments";
import { checkDownloadName, saveDownload } from "./chat-file-access";

export const CHAT_ATTACHMENTS_DIRNAME = "attachments";

/**
 * A text file attached to a chat message travels inside the message, so the model always has
 * it. A chat with a folder also keeps a copy there (`attachments/`), which is what a later
 * shell, or the user in Finder, can open. A file already saved with the same name and
 * content is not saved again; a taken name gets ` (1)` added, like any save.
 *
 * Returns the paths written. Never throws: the copy is a convenience, not part of sending.
 */
export function saveAttachedFilesToFolder(folder: string, content: string): string[] {
  const { files } = splitAttachedFiles(content);
  if (files.length === 0) return [];
  const dir = join(folder, CHAT_ATTACHMENTS_DIRNAME);
  const written: string[] = [];
  for (const file of files) {
    try {
      const checked = checkDownloadName(file.name.replace(/[\\/]+/g, "_"));
      // A name that is refused (a program extension, hidden file) still deserves a copy, as text.
      const name = checked.ok ? checked.name : `${file.name.replace(/[^\w. -]+/g, "_").replace(/^\.+/, "") || "attachment"}.txt`;
      const data = Buffer.from(file.text, "utf8");
      const same = join(dir, name);
      if (existsSync(same) && readFileSync(same).equals(data)) continue;
      written.push(saveDownload(dir, name, data).path);
    } catch {
      // Too large, unwritable folder: the message still carries the text.
    }
  }
  return written;
}
