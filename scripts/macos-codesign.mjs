// Developer ID signing for the code Tauri does not sign itself.
//
// Tauri signs the main binary and the outer .app, but treats everything under
// Contents/Resources as data. Our Resources hold the Node runtime (wrapped in
// "Pi Agent Server.app") and native modules such as node-pty's pty.node and
// spawn-helper. Notarization rejects the whole app if any Mach-O inside it lacks
// a Developer ID signature with the hardened runtime and a secure timestamp, so
// they are signed here, in src-tauri/resources, before `tauri build` copies them.
//
// Runs only on macOS with a real identity: ad-hoc builds ("-") and other
// platforms are left untouched.
import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** True when `identity` asks for a real (not ad-hoc) signature. */
export function wantsDeveloperIdSigning(identity, platform = process.platform) {
  return platform === "darwin" && typeof identity === "string" && identity.trim() !== "" && identity.trim() !== "-";
}

/** Recognises thin and universal Mach-O headers (not Java class files, which share 0xCAFEBABE). */
export function isMachO(header) {
  if (!header || header.length < 8) return false;
  const magic = header.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    // Universal binaries store an architecture count here; Java stores its
    // class-file version (45 and up).
    const count = header.readUInt32BE(4);
    return count > 0 && count < 45;
  }
  return false;
}

async function readHeader(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Every regular Mach-O file under `dir`, deepest first (symlinks are skipped). */
export async function findMachOFiles(dir) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && isMachO(await readHeader(path))) found.push(path);
    }
  }
  await walk(dir);
  return found.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
}

async function codesign(path, identity, entitlements) {
  const args = ["--force", "--timestamp", "--options", "runtime", "--sign", identity];
  if (entitlements) args.push("--entitlements", entitlements);
  await run("codesign", [...args, path]);
}

/**
 * Signs the staged server tree and the Node helper app, inside out, then checks
 * the helper with `codesign --verify --strict`.
 */
export async function signDesktopResources({ identity, serverDir, helperApp, helperEntitlements }) {
  const binaries = await findMachOFiles(serverDir);
  for (const binary of binaries) await codesign(binary, identity);
  await codesign(helperApp, identity, helperEntitlements);
  await run("codesign", ["--verify", "--strict", "--verbose=2", helperApp]);
  return binaries;
}
