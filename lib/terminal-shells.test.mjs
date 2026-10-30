import assert from "node:assert/strict";
import test from "node:test";
import { discoverTerminalShells } from "./terminal-shells.ts";

function discover(platform, env, files, registered = "") {
  const available = new Set(files.map(path => platform === "win32" ? path.toLowerCase() : path));
  return discoverTerminalShells({ platform, env,
    executable: path => available.has(platform === "win32" ? path.toLowerCase() : path),
    registeredShells: () => registered });
}

const cmd = "C:\\Windows\\System32\\cmd.exe";
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

test("Windows detects executable paths with spaces and prefers PowerShell 7", () => {
  const result = discover("win32", { Path: '"C:\\Program Files\\PowerShell\\7";C:\\Windows\\System32', COMSPEC: cmd }, [cmd, powershell, pwsh]);
  assert.equal(result.defaultPath, pwsh);
  assert.deepEqual(result.shells.map(shell => shell.label), ["PowerShell 7", "Windows PowerShell", "CMD"]);
  assert.deepEqual(result.shells[0].args, ["-NoLogo"]);
  assert.deepEqual(result.shells[2].args, []);
});

test("Windows falls back to built-in PowerShell, then CMD", () => {
  assert.equal(discover("win32", {}, [cmd, powershell]).defaultPath, powershell);
  assert.equal(discover("win32", {}, [cmd]).defaultPath, cmd);
});

test("Windows finds native Git Bash but excludes WindowsApps aliases and relative PATH entries", () => {
  const alias = "C:\\Users\\test\\WindowsApps\\pwsh.exe";
  const git = "D:\\Tools\\Git\\cmd\\git.exe";
  const bash = "D:\\Tools\\Git\\bin\\bash.exe";
  const result = discover("win32", { PATH: ".;C:\\Users\\test\\WindowsApps;D:\\Tools\\Git\\cmd" }, [alias, "pwsh.exe", cmd, git, bash]);
  assert.equal(result.defaultPath, cmd);
  assert.equal(result.shells.find(shell => shell.path === bash)?.label, "Git Bash");
  assert.ok(!result.shells.some(shell => shell.path === alias));
});

test("macOS preserves the user's login shell and discovers Apple Silicon Homebrew shells", () => {
  const result = discover("darwin", { SHELL: "/bin/zsh", PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
    ["/bin/zsh", "/bin/bash", "/bin/sh", "/opt/homebrew/bin/fish", "/opt/homebrew/bin/pwsh"], "/bin/zsh\n/bin/bash\n/bin/sh\n");
  assert.equal(result.defaultPath, "/bin/zsh");
  assert.deepEqual(result.shells.find(shell => shell.path === "/bin/zsh").args, ["-l"]);
  assert.deepEqual(result.shells.find(shell => shell.path === "/opt/homebrew/bin/pwsh").args, ["-NoLogo"]);
  assert.equal(result.shells.filter(shell => shell.path === "/bin/zsh").length, 1);
  assert.ok(result.shells.some(shell => shell.path === "/opt/homebrew/bin/fish"));
});

test("macOS detects Intel Homebrew outside GUI PATH and falls back from a missing login shell", () => {
  const result = discover("darwin", { SHELL: "/missing/fish", PATH: "/usr/bin:/bin" },
    ["/bin/zsh", "/bin/bash", "/usr/local/bin/fish"]);
  assert.equal(result.defaultPath, "/bin/zsh");
  assert.ok(result.shells.some(shell => shell.path === "/usr/local/bin/fish"));
  assert.ok(!result.shells.some(shell => shell.path === "/missing/fish"));
});

test("Unix accepts executable registered login shells and ignores comments and missing files", () => {
  const result = discover("linux", { SHELL: "/usr/bin/fish", PATH: "/usr/bin:/bin" },
    ["/usr/bin/fish", "/bin/sh", "/usr/bin/tcsh"], "# shells\n/usr/bin/fish\r\n/usr/bin/tcsh\n/missing\n");
  assert.equal(result.defaultPath, "/usr/bin/fish");
  assert.ok(result.shells.some(shell => shell.path === "/usr/bin/tcsh"));
  assert.ok(!result.shells.some(shell => shell.path === "/missing"));
  assert.equal(discover("linux", {}, ["/bin/sh"]).defaultPath, "/bin/sh");
});
