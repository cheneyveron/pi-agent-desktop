import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUpdateRequest,
  getUpdaterDir,
  isStrictVersion,
  parseUpdaterStatus,
} from "./server-update-protocol.ts";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("the Upgrade button is only supported when an updater directory is configured", () => {
  assert.equal(getUpdaterDir({}), null);
  assert.equal(getUpdaterDir({ PI_WEB_UPDATER_DIR: "  " }), null);
  assert.equal(getUpdaterDir({ PI_WEB_UPDATER_DIR: "/var/lib/pi-updater" }), "/var/lib/pi-updater");
});

test("only plain x.y.z versions can become an image tag", () => {
  assert.equal(isStrictVersion("0.7.5"), true);
  for (const bad of ["latest", "0.7", "v0.7.5", "0.7.5-rc.1", "0.7.5\nid=x", "0.7.5; id", "../0.7.5", 7, null]) {
    assert.equal(isStrictVersion(bad), false, String(bad));
  }
});

test("a request is two key=value lines and refuses unsafe input", () => {
  assert.equal(formatUpdateRequest(ID, "0.7.5"), `id=${ID}\nversion=0.7.5\n`);
  assert.throws(() => formatUpdateRequest(ID, "latest"));
  assert.throws(() => formatUpdateRequest("not-an-id", "0.7.5"));
  assert.throws(() => formatUpdateRequest(`${ID}\nversion=9.9.9`, "0.7.5"));
});

test("status files are parsed, including an error that contains an equals sign", () => {
  assert.deepEqual(parseUpdaterStatus(`id=${ID}\nphase=pulling\nversion=0.7.5\n`), {
    id: ID, phase: "pulling", version: "0.7.5", error: undefined,
  });
  assert.equal(parseUpdaterStatus(`id=${ID}\nphase=failed\nversion=0.7.5\nerror=rolled back a=b\n`)?.error, "rolled back a=b");
  assert.equal(parseUpdaterStatus(""), null);
  assert.equal(parseUpdaterStatus("phase=done\n"), null);
});
