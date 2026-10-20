import assert from "node:assert/strict";
import test from "node:test";
import { publicUpdaterManifest } from "./public-updater-urls.mjs";

const assets = [
  { apiUrl: "https://api.github.com/repos/o/r/releases/assets/1", name: "Pi.Agent_1.0.0_aarch64.app.tar.gz" },
  { apiUrl: "https://api.github.com/repos/o/r/releases/assets/2", name: "Pi.Agent_1.0.0_x64-setup.exe" },
];

test("API asset URLs become public download URLs", () => {
  const manifest = {
    version: "1.0.0",
    platforms: {
      "darwin-aarch64": { signature: "a", url: assets[0].apiUrl },
      "windows-x86_64": { signature: "b", url: assets[1].apiUrl },
    },
  };
  const out = publicUpdaterManifest(manifest, assets, "o/r", "v1.0.0");
  assert.equal(out.platforms["darwin-aarch64"].url, "https://github.com/o/r/releases/download/v1.0.0/Pi.Agent_1.0.0_aarch64.app.tar.gz");
  assert.equal(out.platforms["windows-x86_64"].signature, "b");
});

test("an already public URL is kept and an unknown one fails", () => {
  const public_ = "https://github.com/o/r/releases/download/v1.0.0/x.tar.gz";
  const kept = publicUpdaterManifest({ platforms: { a: { url: public_ } } }, assets, "o/r", "v1.0.0");
  assert.equal(kept.platforms.a.url, public_);
  assert.throws(() => publicUpdaterManifest({ platforms: { a: { url: "https://example.com/x" } } }, assets, "o/r", "v1.0.0"));
});
