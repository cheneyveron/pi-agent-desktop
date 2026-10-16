import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getTurnFilePatch, setTurnFilePatch, subscribeTurnFilePatches } = await jiti.import("./turn-file-patches.ts");

test("stores, replaces and clears a patch, notifying only on change", () => {
  let calls = 0;
  const unsubscribe = subscribeTurnFilePatches(() => { calls += 1; });
  setTurnFilePatch("/a", "P1");
  setTurnFilePatch("/a", "P1");
  assert.equal(getTurnFilePatch("/a"), "P1");
  setTurnFilePatch("/a", undefined);
  setTurnFilePatch("/a", undefined);
  assert.equal(getTurnFilePatch("/a"), undefined);
  assert.equal(calls, 2);
  unsubscribe();
  setTurnFilePatch("/a", "P2");
  assert.equal(calls, 2);
  setTurnFilePatch("/a", undefined);
});
