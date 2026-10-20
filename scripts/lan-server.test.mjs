import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("./lan-server.mjs", import.meta.url), "utf8");

test("the LAN scripts start Next through the launcher that marks the server as exposed", () => {
  assert.equal(pkg.scripts["dev:lan"], "node scripts/lan-server.mjs dev");
  assert.equal(pkg.scripts["start:lan"], "node scripts/lan-server.mjs start");
  assert.match(source, /PI_WEB_HOSTNAME: HOSTNAME/);
  assert.match(source, /HOSTNAME = "0\.0\.0\.0"/);
});

test("the launcher refuses to listen beyond loopback without a password", () => {
  const env = { ...process.env };
  delete env.PI_WEB_PASSWORD;
  delete env.PI_WEB_ALLOW_UNAUTHENTICATED;
  const result = spawnSync(process.execPath, ["scripts/lan-server.mjs", "start"], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to listen/);
});

test("the launcher rejects an unknown mode", () => {
  const result = spawnSync(process.execPath, ["scripts/lan-server.mjs", "bogus"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage/);
});
