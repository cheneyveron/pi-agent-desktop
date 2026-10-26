import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("every native-dialog filesystem route requires desktop authorization", async () => {
  const routes = await Promise.all([
    source("app/api/desktop/read-images/route.ts"),
    source("app/api/desktop/save/route.ts"),
    source("app/api/files/[...path]/route.ts"),
  ]);
  for (const route of routes) {
    assert.match(route, /isDesktopApiRequestAllowed\(request\)/);
  }
});

test("desktop token crosses only the Tauri command and process environment contract", async () => {
  const [native, rust, identityRoute, capability, permissions, packageJson] = await Promise.all([
    source("lib/desktop-native.ts"),
    source("src-tauri/src/lib.rs"),
    source("app/api/desktop/identity/route.ts"),
    source("src-tauri/capabilities/desktop-dialog.json"),
    source("src-tauri/permissions/desktop-shell.toml"),
    source("package.json"),
  ]);

  assert.match(native, /invoke<string>\("get_desktop_api_token"\)/);
  assert.match(native, /headers\.set\(DESKTOP_API_TOKEN_HEADER/);
  assert.match(rust, /\.env\(DESKTOP_API_TOKEN_ENV, desktop_api_token\)/);
  assert.match(rust, /\.env\(DESKTOP_INSTANCE_ID_ENV, desktop_instance_id\)/);
  assert.match(rust, /probe_server\(\s*address,\s*expected_instance_id,/);
  assert.match(identityRoute, /DESKTOP_INSTANCE_ID_HEADER/);
  assert.match(identityRoute, /status: 204/);
  assert.match(rust, /fn get_desktop_api_token/);
  assert.match(capability, /allow-get-desktop-api-token/);
  assert.match(permissions, /commands\.allow = \["get_desktop_api_token"\]/);
  assert.match(JSON.parse(packageJson).scripts["desktop:dev"], /scripts\/desktop-dev\.mjs/);
});
