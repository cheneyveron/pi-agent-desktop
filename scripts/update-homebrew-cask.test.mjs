import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CASK_PATH, updateCask } from "./update-homebrew-cask.mjs";

const SHA = "a".repeat(64);

test("updateCask rewrites only the version and sha256 lines", async () => {
  const source = await readFile(CASK_PATH, "utf8");
  const next = updateCask(source, "9.8.7", SHA);
  assert.match(next, /^\s*version "9\.8\.7"$/m);
  assert.match(next, new RegExp(`^\\s*sha256 "${SHA}"$`, "m"));
  const before = source.split("\n");
  const after = next.split("\n");
  assert.equal(after.length, before.length);
  const changed = after.filter((line, i) => line !== before[i]);
  assert.equal(changed.length, 2, "only the version and sha256 lines may change");
});

test("the cask points at the aarch64 DMG the release publishes", async () => {
  const source = await readFile(CASK_PATH, "utf8");
  assert.match(source, /releases\/download\/v#\{version\}\/Pi\.Agent_#\{version\}_aarch64\.dmg/);
  assert.match(source, /depends_on arch: :arm64/);
  assert.match(source, /auto_updates true/);
  assert.doesNotMatch(source, /"~\/\.pi/, "zap must not delete ~/.pi, which the pi CLI shares");
});

test("updateCask rejects malformed input", async () => {
  const source = await readFile(CASK_PATH, "utf8");
  assert.throws(() => updateCask(source, "v1.2.3", SHA), /Invalid version/);
  assert.throws(() => updateCask(source, "1.2.3", "abc"), /Invalid sha256/);
  assert.throws(() => updateCask("cask \"x\" do\nend\n", "1.2.3", SHA), /no version/);
});
