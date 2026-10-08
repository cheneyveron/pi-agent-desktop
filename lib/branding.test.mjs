import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const {
  APP_DISTRIBUTION_NAME,
  APP_REPOSITORY,
  APP_VERSION,
  APP_VERSION_DISPLAY,
  PRODUCT_NAME,
} = await jiti.import("./branding.ts");

const userFacingFiles = [
  "app/layout.tsx",
  "components/AppShell.tsx",
  "components/ChatWindow.tsx",
  "components/SessionSidebar.tsx",
  "components/UpdateReminder.tsx",
];

test("locks the local user-facing product name", () => {
  assert.equal(PRODUCT_NAME, "Pi Agent");
  assert.equal(APP_DISTRIBUTION_NAME, "pi-agent-desktop");
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(
    APP_VERSION_DISPLAY,
    APP_VERSION.endsWith(".0") ? APP_VERSION.slice(0, -2) : APP_VERSION,
  );
  for (const relativePath of userFacingFiles) {
    const source = readFileSync(join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /Pi Web/, `${relativePath} must use PRODUCT_NAME`);
  }

  const desktopSource = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
  assert.match(desktopSource, /\.title\("Pi Agent"\)/);
});

test("keeps build versions out of the interface", () => {
  const files = [
    "next.config.ts",
    "components/ChatWindow.tsx",
    "components/SessionSidebar.tsx",
  ];
  for (const relativePath of files) {
    const source = readFileSync(join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /NEXT_PUBLIC_(?:APP|PI)_VERSION/, `${relativePath} exposes a version badge`);
  }
});

test("desktop update metadata consistently targets this distribution", async () => {
  const { componentRepositories } = await import("../scripts/release-components.mjs");
  const { APP_UPDATE_PROJECTS } = await jiti.import("./app-updates.ts");
  const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(APP_REPOSITORY, "cheneyveron/pi-agent-desktop");
  assert.equal(componentRepositories["pi-agent-desktop"], APP_REPOSITORY);
  assert.equal(APP_UPDATE_PROJECTS[0].repository, APP_REPOSITORY);
  assert.deepEqual(config.plugins.updater.endpoints, [
    `https://github.com/${APP_REPOSITORY}/releases/latest/download/latest.json`,
  ]);
});
