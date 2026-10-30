import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export async function linkDirectory(target, path) {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

async function detectFileSymlinks() {
  if (process.platform !== "win32") return true;
  const probe = await mkdtemp(join(tmpdir(), "pi-web-link-probe-"));
  try {
    const target = join(probe, "target.txt");
    await writeFile(target, "probe");
    await symlink(target, join(probe, "link.txt"), "file");
    return true;
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

export const fileSymlinksAvailable = await detectFileSymlinks();
export const fileSymlinkSkip = fileSymlinksAvailable ? false
  : "Windows file symlinks require Developer Mode or the symlink privilege";

export async function assertOwnerOnlyMode(path, expected = 0o600) {
  const info = await stat(path);
  // Windows reports DOS attributes through mode; it does not implement POSIX permissions.
  if (process.platform !== "win32") assert.equal(info.mode & 0o777, expected);
  assert.ok(info.isFile());
}

export async function fixtureDir(prefix) {
  const temp = resolve(tmpdir());
  const relativeToHome = relative(resolve(homedir()), temp);
  const inProfile = !relativeToHome.startsWith("..") && !isAbsolute(relativeToHome);
  // Ancestor-scanning trust tests must not inherit the developer's ~/.agents/skills.
  const base = inProfile ? resolve("test-results", "fixtures") : temp;
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}

const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

let nativeBashDirectory;

export function useGitBashForTests(t) {
  if (process.platform !== "win32") return;
  if (!nativeBashDirectory) {
    const gitExec = execFileSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).trim();
    const bash = resolve(gitExec, "../../..", "bin/bash.exe");
    accessSync(bash);
    nativeBashDirectory = dirname(bash);
  }
  // Git installed outside Program Files is otherwise missed by the SDK,
  // which can select a WindowsApps WSL alias that cannot use Windows paths.
  const previous = process.env.PATH;
  process.env.PATH = `${nativeBashDirectory};${previous ?? ""}`;
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
}

/** SDK !commands use a POSIX shell; Windows tests explicitly select native Git Bash. */
export function markerCommand(marker, output) {
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker.replaceAll("\\", "/"))}, 'ran');process.stdout.write(${JSON.stringify(output)})`;
  return `!${shellQuote(process.execPath.replaceAll("\\", "/"))} -e ${shellQuote(code)}`;
}
