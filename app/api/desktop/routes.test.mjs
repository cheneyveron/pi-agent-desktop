import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { fileSymlinkSkip } from "../../../scripts/test-platform.mjs";

// The native-dialog routes accept absolute paths, so the desktop token is all
// that keeps them from browser and LAN clients. lib/desktop-api-contract.test.mjs
// pins that the check is in the source; these run the handlers.
const TOKEN = "t".repeat(48);
const originalToken = process.env.PI_DESKTOP_API_TOKEN;
process.env.PI_DESKTOP_API_TOKEN = TOKEN;
after(() => {
  if (originalToken === undefined) delete process.env.PI_DESKTOP_API_TOKEN;
  else process.env.PI_DESKTOP_API_TOKEN = originalToken;
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const save = await jiti.import("./save/route.ts");
const readImages = await jiti.import("./read-images/route.ts");

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function allowOnly(...roots) {
  globalThis.__piAllowedRootsCache = { roots: new Set(roots), expiresAt: Date.now() + 60_000 };
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-web-desktop-route-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function request(url, { token = TOKEN, host = "127.0.0.1:30141", headers = {}, body } = {}) {
  const all = { host, ...headers };
  if (token !== null) all["x-pi-desktop-token"] = token;
  return new Request(`http://127.0.0.1:30141${url}`, { method: "POST", headers: all, body });
}

function jsonRequest(url, payload, options = {}) {
  return request(url, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify(payload),
  });
}

const UNAUTHORIZED = [
  ["no token", { token: null }],
  ["a wrong token", { token: "x".repeat(48) }],
  ["a non-loopback host", { host: "192.168.1.20:30141" }],
  ["a cross-site request", { headers: { "sec-fetch-site": "cross-site" } }],
];

test("both routes refuse every request that is not the desktop WebView", async (t) => {
  const dir = await tempDir(t);
  const image = path.join(dir, "a.png");
  await writeFile(image, PNG);
  allowOnly(dir);

  for (const [label, options] of UNAUTHORIZED) {
    const dest = path.join(dir, `out-${label.replaceAll(" ", "-")}.bin`);
    const saved = await save.POST(request("/api/desktop/save", {
      ...options,
      headers: { "x-pi-dest-path": encodeURIComponent(dest), ...options.headers },
      body: "payload",
    }));
    assert.equal(saved.status, 403, `save: ${label}`);
    await assert.rejects(readFile(dest), { code: "ENOENT" }, `save wrote with ${label}`);

    const read = await readImages.POST(jsonRequest("/api/desktop/read-images", { paths: [image] }, options));
    assert.equal(read.status, 403, `read-images: ${label}`);
  }
});

test("save writes bytes to an absolute destination and refuses relative ones", async (t) => {
  const dir = await tempDir(t);
  const dest = path.join(dir, "saved.txt");

  const ok = await save.POST(request("/api/desktop/save", {
    headers: { "x-pi-dest-path": encodeURIComponent(dest) },
    body: "hello",
  }));
  assert.equal(ok.status, 200);
  assert.equal(await readFile(dest, "utf8"), "hello");

  const relative = await save.POST(request("/api/desktop/save", {
    headers: { "x-pi-dest-path": encodeURIComponent("saved.txt") },
    body: "hello",
  }));
  assert.equal(relative.status, 400);

  const missingParent = await save.POST(request("/api/desktop/save", {
    headers: { "x-pi-dest-path": encodeURIComponent(path.join(dir, "nope", "x.txt")) },
    body: "hello",
  }));
  assert.equal(missingParent.status, 400);
});

test("save never writes through a symlink at the destination", { skip: fileSymlinkSkip }, async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, "target.txt");
  await writeFile(target, "original");
  const link = path.join(dir, "link.txt");
  await symlink(target, link);

  const response = await save.POST(request("/api/desktop/save", {
    headers: { "x-pi-dest-path": encodeURIComponent(link) },
    body: "overwritten",
  }));
  assert.equal(response.status, 400);
  assert.equal(await readFile(target, "utf8"), "original");
});

test("save copies only sources inside the allowed roots", async (t) => {
  const allowed = await tempDir(t);
  const outside = await tempDir(t);
  const inside = path.join(allowed, "in.txt");
  const secret = path.join(outside, "secret.txt");
  await writeFile(inside, "in");
  await writeFile(secret, "secret");
  allowOnly(allowed);

  const dest = path.join(outside, "copy.txt");
  const ok = await save.POST(jsonRequest("/api/desktop/save", { sourcePath: inside, destPath: dest }));
  assert.equal(ok.status, 200);
  assert.equal(await readFile(dest, "utf8"), "in");

  const denied = await save.POST(jsonRequest("/api/desktop/save", {
    sourcePath: secret,
    destPath: path.join(allowed, "leak.txt"),
  }));
  assert.equal(denied.status, 403);
  await assert.rejects(readFile(path.join(allowed, "leak.txt")), { code: "ENOENT" });
});

test("read-images returns image payloads and rejects non-images and relative paths", async (t) => {
  const dir = await tempDir(t);
  const image = path.join(dir, "a.png");
  const text = path.join(dir, "notes.txt");
  await writeFile(image, PNG);
  await writeFile(text, "not an image");

  const ok = await readImages.POST(jsonRequest("/api/desktop/read-images", { paths: [image] }));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  const [file] = body.files;
  assert.equal(file.name, "a.png");
  assert.equal(file.mimeType, "image/png");
  assert.equal(Buffer.from(file.data, "base64").equals(PNG), true);

  assert.equal((await readImages.POST(jsonRequest("/api/desktop/read-images", { paths: [text] }))).status, 400);
  assert.equal((await readImages.POST(jsonRequest("/api/desktop/read-images", { paths: ["a.png"] }))).status, 400);
  assert.equal((await readImages.POST(jsonRequest("/api/desktop/read-images", { paths: [] }))).status, 400);
  assert.equal((await readImages.POST(jsonRequest("/api/desktop/read-images", { paths: "a.png" }))).status, 400);
});
