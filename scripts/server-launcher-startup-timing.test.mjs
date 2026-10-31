import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// #157: after Next printed "Ready", the shell's identity probe went unanswered
// for over a minute and server.log said nothing. The launcher now records the
// first connection, the first request and its response, and event-loop stalls.
const fakeServer = `
const http = require("node:http");
const server = http.createServer((request, response) => {
  // Hold the event loop the way a slow synchronous module load would.
  const until = Date.now() + 2600;
  while (Date.now() < until) {}
  response.statusCode = 204;
  response.end();
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  http.get({ host: "127.0.0.1", port, path: "/api/desktop/identity?x=1" }, (response) => {
    response.resume();
    response.on("end", () => setTimeout(() => process.exit(0), 600));
  });
});
`;

test("the launcher logs the first request, its response and event-loop stalls", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-launcher-timing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(join(rootDir, "desktop", "server-launcher.cjs"), join(dir, "desktop-server.cjs"));
  await writeFile(join(dir, "server.js"), fakeServer);

  const result = spawnSync(process.execPath, [join(dir, "desktop-server.cjs")], {
    env: { ...process.env, PI_WEB_PARENT_PID: String(process.pid) },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const log = result.stderr;

  assert.match(log, /\[Pi Agent\] launcher started \+\d+\.\ds \(node v/);
  assert.match(log, /\[Pi Agent\] first connection accepted \+\d+\.\ds/);
  // The query string is dropped: it may carry tokens.
  assert.match(log, /\[Pi Agent\] first request GET \/api\/desktop\/identity received \+\d+\.\ds\n/);
  assert.match(log, /\[Pi Agent\] first response 204 sent after \d+ ms/);
  assert.match(log, /\[Pi Agent\] event loop blocked for \d+ ms \(ended \+\d+\.\ds\)/);
  // Only the first request is reported.
  assert.equal(log.match(/first request/g).length, 1);
});
