import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const terminalById = await jiti.import("./[id]/route.ts");
const { getTerminalCwd } = await jiti.import("../../../lib/terminal-manager.ts");

// Seed the allowed-roots cache so the route never scans the real session store.
function allowOnly(...roots) {
  globalThis.__piAllowedRootsCache = { roots: new Set(roots), expiresAt: Date.now() + 60_000 };
}

function createRequest(body) {
  return POST(new Request("http://localhost/api/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-web-terminal-route-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("terminal creation validates the id and cwd before touching the filesystem", async () => {
  allowOnly();
  assert.equal((await createRequest({ id: "../x", cwd: "/" })).status, 400);
  assert.equal((await createRequest({ id: 42, cwd: "/" })).status, 400);
  assert.equal((await createRequest({})).status, 400);
  assert.equal((await createRequest({ cwd: "  " })).status, 400);
});

test("a cwd outside the allowed roots is refused the same way whatever is there", async (t) => {
  const allowed = await tempDir(t);
  const outside = await tempDir(t);
  const file = path.join(outside, "file.txt");
  await writeFile(file, "x");
  allowOnly(allowed);

  // Directory, regular file and missing path all answer 403, so the response
  // does not reveal what exists outside the allowed roots.
  for (const cwd of [outside, file, path.join(outside, "missing")]) {
    const response = await createRequest({ cwd });
    assert.equal(response.status, 403, cwd);
    assert.deepEqual(await response.json(), { error: "Access denied" });
  }
});

test("a symlink inside an allowed root that leaves it is refused", async (t) => {
  const allowed = await tempDir(t);
  const outside = await tempDir(t);
  const { linkDirectory } = await import("../../../scripts/test-platform.mjs");
  const link = path.join(allowed, "escape");
  await linkDirectory(outside, link);
  allowOnly(allowed);

  const response = await createRequest({ cwd: link });
  assert.equal(response.status, 403);
});

test("an allowed path that is not a directory is rejected without starting a shell", async (t) => {
  const allowed = await tempDir(t);
  const file = path.join(allowed, "file.txt");
  await writeFile(file, "x");
  allowOnly(allowed);

  const id = "0".repeat(32);
  const response = await createRequest({ id, cwd: file });
  assert.equal(response.status, 400);
  assert.equal(getTerminalCwd(id), undefined);
});

test("commands for an unknown terminal answer 404, malformed ones 400", async () => {
  const params = Promise.resolve({ id: "f".repeat(32) });
  const send = (body) => terminalById.POST(new Request("http://localhost/api/terminal/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { params });

  assert.equal((await send({ type: "input", data: "ls\n" })).status, 404);
  assert.equal((await send({ type: "resize", cols: 80, rows: 24 })).status, 404);
  assert.equal((await send({ type: "input", data: "x".repeat(64 * 1024 + 1) })).status, 400);
  assert.equal((await send({ type: "resize", cols: 1, rows: 24 })).status, 400);
  assert.equal((await send({ type: "exec", data: "ls" })).status, 400);
  assert.equal((await terminalById.GET(new Request("http://localhost"), { params })).status, 404);
});
