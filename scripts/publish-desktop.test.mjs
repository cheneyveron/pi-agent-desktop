import assert from "node:assert/strict";
import test from "node:test";
import { chooseRun, validateAssets, validateUpdate } from "./publish-desktop.mjs";

function fixture() {
  const version = "0.6.0";
  const names = [
    "Pi.Agent_0.6.0_aarch64.dmg", "Pi.Agent_0.6.0_aarch64.app.tar.gz",
    "Pi.Agent_0.6.0_aarch64.app.tar.gz.sig", "Pi.Agent_0.6.0_amd64.deb",
    "Pi.Agent_0.6.0_amd64.deb.sig", "Pi.Agent_0.6.0_x64-setup.exe",
    "Pi.Agent_0.6.0_x64-setup.exe.sig", "latest.json", "component-versions.json",
  ];
  const release = { tag_name: `v${version}`, draft: false, prerelease: false, assets: names.map((name, id) => ({
    name, state: "uploaded", size: 10, url: `https://api.github.com/assets/${id}`,
    browser_download_url: `https://github.com/download/${name}`,
  })) };
  const assets = validateAssets(release, version);
  const update = { version, platforms: Object.fromEntries([
    ["darwin-aarch64", names[1]], ["linux-x86_64", names[3]], ["windows-x86_64", names[5]],
  ].map(([target, name]) => [target, { url: assets.get(name).url, signature: "signed" }])) };
  return { version, release, assets, update };
}

test("resuming picks the newest manual run for the exact source commit", () => {
  const runs = [
    { id: 1, head_sha: "abc", event: "workflow_dispatch" },
    { id: 3, head_sha: "abc", event: "workflow_dispatch" },
    { id: 4, head_sha: "other", event: "workflow_dispatch" },
    { id: 5, head_sha: "abc", event: "push" },
  ];
  assert.equal(chooseRun(runs, "abc").id, 3);
  assert.equal(chooseRun(runs, "missing"), undefined);
});

test("publication requires every platform, manifest, nonempty files and a stable release", () => {
  const { release, version } = fixture();
  assert.throws(() => validateAssets({ ...release, draft: true }, version), /draft/);
  assert.throws(() => validateAssets({ ...release, prerelease: true }, version), /prerelease/);
  for (const asset of release.assets) {
    assert.throws(() => validateAssets({ ...release, assets: release.assets.filter((a) => a !== asset) }, version), /Missing/);
    assert.throws(() => validateAssets({ ...release, assets: release.assets.map((a) => a === asset ? { ...a, size: 0 } : a) }, version), /incomplete/);
  }
});

test("updater accepts GitHub API asset URLs and public download URLs", () => {
  const { update, assets, version } = fixture();
  assert.equal(validateUpdate(update, assets, version).length, 3);
  const windows = update.platforms["windows-x86_64"];
  windows.url = [...assets.values()].find((a) => a.url === windows.url).browser_download_url;
  assert.equal(validateUpdate(update, assets, version).length, 3);
});

test("updater refuses missing platforms, wrong versions, unrelated downloads and empty signatures", () => {
  const { update, assets, version } = fixture();
  assert.throws(() => validateUpdate({ ...update, version: "0.5.4" }, assets, version), /version/);
  const bad = structuredClone(update);
  delete bad.platforms["windows-x86_64"];
  assert.throws(() => validateUpdate(bad, assets, version), /Missing updater/);
  bad.platforms = structuredClone(update.platforms);
  bad.platforms["windows-x86_64"].url = "https://example.com/other.exe";
  assert.throws(() => validateUpdate(bad, assets, version), /outside/);
  bad.platforms = structuredClone(update.platforms);
  bad.platforms["windows-x86_64"].url = update.platforms["linux-x86_64"].url;
  assert.throws(() => validateUpdate(bad, assets, version), /Wrong installer/);
  bad.platforms = structuredClone(update.platforms);
  bad.platforms["windows-x86_64"].signature = "";
  assert.throws(() => validateUpdate(bad, assets, version), /Missing signature/);
});
