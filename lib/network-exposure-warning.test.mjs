import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { checkNetworkExposure, getNetworkExposureWarning } = require("../bin/network-exposure-warning.js");
const scriptPath = fileURLToPath(new URL("../bin/network-exposure-warning.js", import.meta.url));

test("stays silent on loopback hostnames", () => {
  for (const hostname of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    assert.equal(getNetworkExposureWarning(hostname, {}), null);
  }
});

test("refuses a public listener without a password", () => {
  const exposure = checkNetworkExposure("0.0.0.0", {});
  assert.equal(exposure.fatal, true);
  assert.match(exposure.message, /Refusing to listen on 0\.0\.0\.0 without authentication/);
  assert.match(exposure.message, /PI_WEB_PASSWORD/);
  assert.match(exposure.message, /PI_WEB_ALLOW_UNAUTHENTICATED=1/);
});

test("an explicit opt-out starts unauthenticated with a warning", () => {
  const exposure = checkNetworkExposure("0.0.0.0", { PI_WEB_ALLOW_UNAUTHENTICATED: "1" });
  assert.equal(exposure.fatal, false);
  assert.match(exposure.message, /0\.0\.0\.0 without authentication/);
  // Only the exact value opts out; a stray "true" or "0" must not.
  for (const value of ["0", "true", ""]) {
    assert.equal(checkNetworkExposure("0.0.0.0", { PI_WEB_ALLOW_UNAUTHENTICATED: value }).fatal, true, value);
  }
});

test("warns about plain HTTP instead when a password is set", () => {
  const warning = getNetworkExposureWarning("0.0.0.0", { PI_WEB_PASSWORD: "secret" });
  assert.match(warning, /password authentication over HTTP/);
  assert.doesNotMatch(warning, /without authentication/);
  assert.equal(checkNetworkExposure("0.0.0.0", { PI_WEB_PASSWORD: "secret" }).fatal, false);
});

test("the CLI form exits 1 for an unauthenticated public host and is silent on loopback", () => {
  const env = { ...process.env };
  delete env.PI_WEB_PASSWORD;
  delete env.PI_WEB_ALLOW_UNAUTHENTICATED;
  const lan = spawnSync(process.execPath, [scriptPath, "0.0.0.0"], { env, encoding: "utf8" });
  assert.equal(lan.status, 1);
  assert.match(lan.stderr, /Refusing to listen/);
  const allowed = spawnSync(process.execPath, [scriptPath, "0.0.0.0"], {
    env: { ...env, PI_WEB_ALLOW_UNAUTHENTICATED: "1" },
    encoding: "utf8",
  });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stderr, /without authentication/);
  const withPassword = spawnSync(process.execPath, [scriptPath, "0.0.0.0"], {
    env: { ...env, PI_WEB_PASSWORD: "secret" },
    encoding: "utf8",
  });
  assert.equal(withPassword.status, 0);
  const local = spawnSync(process.execPath, [scriptPath, "127.0.0.1"], { env, encoding: "utf8" });
  assert.equal(local.status, 0);
  assert.equal(local.stderr, "");
});

test("pi-web refuses an unauthenticated public host before starting Next", () => {
  const env = { ...process.env };
  delete env.PI_WEB_PASSWORD;
  delete env.PI_WEB_ALLOW_UNAUTHENTICATED;
  const cliPath = fileURLToPath(new URL("../bin/pi-web.js", import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, "-H", "0.0.0.0", "--no-open"], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to listen/);
});

test("the lan scripts run the exposure check before starting Next", async () => {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const mode of ["dev", "start"]) {
    assert.equal(pkg.scripts[`${mode}:lan`], `node scripts/lan-server.mjs ${mode}`);
  }
  // The launcher checks exposure first, and only then spawns Next.
  const launcher = await readFile(new URL("../scripts/lan-server.mjs", import.meta.url), "utf8");
  assert.ok(launcher.indexOf("checkNetworkExposure(HOSTNAME)") < launcher.indexOf("spawn(process.execPath"));
});
