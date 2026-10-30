import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

// Exercise the actual packaged runtime: source-tree tests cannot detect omitted workers.
const resources = resolve(process.argv[2] || "src-tauri/resources");
const node = ["node/node.exe", "node/node", "Pi Agent Server.app/Contents/MacOS/node"]
  .map((file) => join(resources, file)).find(existsSync);
assert.ok(node, "Bundled Node runtime is required");
const program = `
const pty = require(${JSON.stringify(join(resources, "server/node_modules/node-pty"))});
const windows = process.platform === 'win32';
const child = pty.spawn(windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
  windows ? ['/d', '/c', 'echo PI_PACKAGED_TERMINAL_OK'] : ['-c', 'printf PI_PACKAGED_TERMINAL_OK'],
  { cwd: process.cwd(), env: process.env, cols: 80, rows: 24 });
let output = '';
const timer = setTimeout(() => { child.kill(); process.exit(2); }, 15000);
child.onData(data => { output += data; });
child.onExit(({exitCode}) => {
  clearTimeout(timer);
  console.log(JSON.stringify({exitCode, output}));
  // node-pty keeps its ConPTY worker alive after the child shell exits.
  process.exit(exitCode === 0 && output.includes('PI_PACKAGED_TERMINAL_OK') ? 0 : 1);
});
`;
const child = spawn(node, ["-e", program], { stdio: "inherit", windowsHide: true });
const timeout = setTimeout(() => child.kill(), 20000);
try {
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Packaged terminal failed (${code})`)));
  });
  console.log("PASS: bundled terminal launches a shell, reads output and exits successfully.");
} finally {
  clearTimeout(timeout);
}
