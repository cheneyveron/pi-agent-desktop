// `npm run dev:all`: `next dev` on 127.0.0.1:30141 plus the main-session service
// (main-session/server.mjs on 127.0.0.1:30180). An already running service is reused; when
// Next exits the service started here stops with it. MAIN_SESSION=off starts Next alone.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.MAIN_SESSION_PORT ?? "30180";

async function serviceRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

const children = [];
if (process.env.MAIN_SESSION !== "off") {
  if (await serviceRunning()) {
    console.log(`[dev:all] main session already running on 127.0.0.1:${port}`);
  } else {
    children.push(spawn(process.execPath, [path.join(pkgDir, "main-session", "server.mjs")], { cwd: pkgDir, stdio: "inherit", env: process.env }));
  }
}

const nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
const next = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", "30141", ...process.argv.slice(2)], { cwd: pkgDir, stdio: "inherit", env: process.env });

const stopChildren = (signal) => {
  for (const child of children) if (child.exitCode === null) child.kill(signal);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopChildren(signal);
    if (next.exitCode === null) next.kill(signal);
  });
}
next.on("exit", (code, signal) => {
  stopChildren("SIGTERM");
  process.exit(code ?? (signal ? 1 : 0));
});
