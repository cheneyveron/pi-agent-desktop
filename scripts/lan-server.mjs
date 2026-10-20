// `npm run dev:lan` / `npm run start:lan`: next on 0.0.0.0, with PI_WEB_HOSTNAME set so the
// server knows it is exposed (it switches off what must stay on this computer, such as a
// chat reading the user's files). Setting it from a script keeps it working on Windows.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { checkNetworkExposure } = require("../bin/network-exposure-warning.js");
const { wireChildProcessLifecycle } = require("../bin/process-lifecycle.js");

const HOSTNAME = "0.0.0.0";
const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("Usage: node scripts/lan-server.mjs <dev|start>");
  process.exit(1);
}

const exposure = checkNetworkExposure(HOSTNAME);
if (exposure) console.warn(exposure.message);
if (exposure?.fatal) process.exit(1);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, mode, "-H", HOSTNAME, "-p", "30141"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PI_WEB_HOSTNAME: HOSTNAME },
});
wireChildProcessLifecycle(child);
