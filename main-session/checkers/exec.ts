// The one way checkers run a command: execFile with a timeout, never a shell. Tests pass a
// fake that returns fixture output.

import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, args: string[], options: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args, options) => new Promise((resolve) => {
  execFile(cmd, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});
