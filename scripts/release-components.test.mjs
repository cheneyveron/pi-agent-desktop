import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  createComponentManifest,
  isReleasePinValid,
  nextPatchVersion,
  normalizeVersion,
} from "./release-components.mjs";

test("normalizes GitHub release tags", () => {
  assert.equal(normalizeVersion("v0.81.1"), "0.81.1");
  assert.equal(normalizeVersion("0.7.17"), "0.7.17");
  assert.throws(() => normalizeVersion("latest"), /Invalid release version/);
});

test("compares stable and prerelease versions", () => {
  assert.equal(compareVersions("0.81.1", "0.81.0"), 1);
  assert.equal(compareVersions("0.81", "0.81.0"), 0);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.10"), 1);
});

test("bumps the patch version", () => {
  assert.equal(nextPatchVersion("v0.1.0"), "0.1.1");
  assert.equal(nextPatchVersion("1.2"), "1.2.1");
});

test("only accepts explicit pins for the exact bundled component version", () => {
  assert.equal(isReleasePinValid({ version: "0.8.7", reason: "Fork compatibility review" }, "0.8.7"), true);
  assert.equal(isReleasePinValid({ version: "0.8.8", reason: "Wrong version" }, "0.8.7"), false);
  assert.equal(isReleasePinValid({ version: "0.8.7", reason: "" }, "0.8.7"), false);
});

test("writes an auditable three-component manifest", () => {
  assert.deepEqual(
    createComponentManifest({ "pi-agent-desktop": "0.1.0", pi: "0.81.1", "pi-web": "0.7.17" }),
    {
      schemaVersion: 1,
      appVersion: "0.1.0",
      components: [
        { id: "pi-agent-desktop", repository: "cheneyveron/pi-agent-desktop", version: "0.1.0" },
        { id: "pi", repository: "earendil-works/pi", version: "0.81.1" },
        { id: "pi-web", repository: "agegr/pi-web", version: "0.7.17" },
      ],
    },
  );
});
