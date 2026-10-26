import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createE2EServerEnv } from "./e2e-server-env.mjs";

test("server defaults stay inside its fixture while the parent/browser environment stays unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-e2e-env-test-"));
  try {
    const parentHome = join(root, "parent");
    const agentDir = join(root, "agent");
    mkdirSync(parentHome);
    writeFileSync(join(parentHome, "sentinel"), "unchanged");
    const parent = Object.freeze({
      HOME: parentHome, USERPROFILE: parentHome, PI_AGENT_HOME: parentHome,
      PI_CODING_AGENT_DIR: parentHome, XDG_CONFIG_HOME: parentHome,
      XDG_CACHE_HOME: parentHome, XDG_DATA_HOME: parentHome, XDG_STATE_HOME: parentHome,
      XDG_DOWNLOAD_DIR: parentHome, APPDATA: parentHome, LOCALAPPDATA: parentHome,
      PLAYWRIGHT_BROWSERS_PATH: "/existing/browser/cache", PATH: process.env.PATH,
      PI_WEB_DESKTOP_BUILD: "1", PI_WEB_PASSWORD: "parent-password",
      NODE_ENV: "production", PI_OFFLINE: "1",
      __NEXT_PRIVATE_ORIGIN: "http://parent.invalid",
      __NEXT_PRIVATE_STANDALONE_CONFIG: '{"parent":true}',
    });
    const before = { ...parent };
    const env = createE2EServerEnv(parent, agentDir, "dev");
    for (const key of ["HOME", "USERPROFILE", "PI_AGENT_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_DOWNLOAD_DIR", "APPDATA", "LOCALAPPDATA"]) {
      assert.ok(env[key].startsWith(join(agentDir, "home")), key);
      mkdirSync(env[key], { recursive: true });
    }
    assert.equal(env.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(env.NODE_ENV, "development");
    assert.equal(env.PI_WEB_PASSWORD, "");
    assert.equal(env.NEXT_TELEMETRY_DISABLED, "1");
    assert.equal(env.PI_WEB_DESKTOP_BUILD, "1", "keep the documented isolated build selector");
    for (const key of ["PI_OFFLINE", "__NEXT_PRIVATE_ORIGIN", "__NEXT_PRIVATE_STANDALONE_CONFIG"]) {
      assert.equal(Object.hasOwn(env, key), false, key);
    }
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { homedir } from 'node:os';
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      writeFileSync(join(homedir(), 'child-file'), 'fixture only');
      console.log(JSON.stringify({ home: homedir(), agent: process.env.PI_AGENT_HOME }));
    `], { env, encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), { home: env.HOME, agent: env.HOME });
    assert.equal(readFileSync(join(env.HOME, "child-file"), "utf8"), "fixture only");
    assert.equal(readFileSync(join(parentHome, "sentinel"), "utf8"), "unchanged");
    assert.deepEqual(parent, before, "do not alter the runner or browser environment");
    assert.equal(parent.PLAYWRIGHT_BROWSERS_PATH, "/existing/browser/cache");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start mode overrides inherited development mode and empty offline flags", () => {
  const env = createE2EServerEnv({ NODE_ENV: "development", PI_OFFLINE: "" }, "/fixture", "start");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(Object.hasOwn(env, "PI_OFFLINE"), false);
});
