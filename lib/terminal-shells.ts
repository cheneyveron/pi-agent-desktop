import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface TerminalShell {
  path: string;
  label: string;
  args: string[];
}

interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executable?: (path: string) => boolean;
  registeredShells?: () => string;
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function discoverTerminalShells({
  platform = process.platform,
  env = process.env,
  executable = executableFile,
  registeredShells = () => { try { return readFileSync("/etc/shells", "utf8"); } catch { return ""; } },
}: DiscoveryOptions = {}): { shells: TerminalShell[]; defaultPath: string | null } {
  const windows = platform === "win32";
  const paths = windows ? win32 : posix;
  const variable = (name: string) => windows
    ? env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) ?? name]
    : env[name];
  const key = (path: string) => windows ? paths.normalize(path).toLowerCase() : paths.normalize(path);
  const directories = (variable("PATH") ?? "").split(windows ? ";" : ":")
    .map(path => path.replace(/^"(.*)"$/, "$1")).filter(path => paths.isAbsolute(path));
  const find = (name: string) => directories.map(dir => paths.join(dir, name)).find(path =>
    !(windows && /[/\\]WindowsApps[/\\]/i.test(path)) && executable(path));
  const shells: TerminalShell[] = [];
  const add = (path: string | undefined, label?: string) => {
    if (!path || !paths.isAbsolute(path) || !executable(path) || shells.some(shell => key(shell.path) === key(path))) return;
    const name = paths.basename(path).replace(/\.exe$/i, "").toLowerCase();
    const powerShell = name === "pwsh" || name === "powershell";
    const names: Record<string, string> = { pwsh: "PowerShell 7", powershell: "Windows PowerShell", cmd: "CMD", zsh: "Zsh", bash: "Bash", fish: "Fish", sh: "Sh" };
    shells.push({ path: paths.normalize(path), label: label ?? names[name] ?? paths.basename(path),
      args: powerShell ? ["-NoLogo"] : name === "cmd" ? [] : ["-l"] });
  };

  if (windows) {
    const programFiles = variable("ProgramFiles") ?? "C:\\Program Files";
    const systemRoot = variable("SystemRoot") ?? "C:\\Windows";
    add(find("pwsh.exe") ?? [paths.join(programFiles, "PowerShell", "7", "pwsh.exe"),
      paths.join(programFiles, "PowerShell", "7-lts", "pwsh.exe")].find(executable));
    add(paths.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    add(variable("ComSpec")?.replace(/^"(.*)"$/, "$1") ?? paths.join(systemRoot, "System32", "cmd.exe"));
    add(paths.join(systemRoot, "System32", "cmd.exe"));
    const git = find("git.exe");
    const gitBash = [git && paths.join(paths.dirname(paths.dirname(git)), "bin", "bash.exe"),
      paths.join(programFiles, "Git", "bin", "bash.exe")].find(path => path && executable(path));
    add(gitBash, "Git Bash");
    return { shells, defaultPath: shells[0]?.path ?? null };
  }

  add(variable("SHELL"));
  for (const name of ["zsh", "bash", "fish", "pwsh"]) {
    const installed = find(name) ?? [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find(executable);
    add(installed);
  }
  for (const path of registeredShells().split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"))) add(path);
  for (const path of ["/bin/zsh", "/bin/bash", "/bin/sh"]) add(path);
  for (const shell of shells) {
    if (shells.some(other => other !== shell && other.label === shell.label && other.path !== shell.path)) {
      shell.label += ` (${paths.dirname(shell.path)})`;
    }
  }
  const login = variable("SHELL");
  const preferred = shells.find(shell => login && key(shell.path) === key(login));
  const fallback = shells.find(shell => shell.path === (platform === "darwin" ? "/bin/zsh" : "/bin/sh"));
  return { shells, defaultPath: preferred?.path ?? fallback?.path ?? shells[0]?.path ?? null };
}
