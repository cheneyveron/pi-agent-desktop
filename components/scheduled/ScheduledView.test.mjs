import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./ScheduledView.tsx", import.meta.url), "utf8");
const { englishMessages } = await createJiti(import.meta.url).import("../../lib/i18n/locale-plugins.ts");

test("scheduler owner notice explains the lease and offers only safe takeover", async () => {
  assert.match(source, /schedulerOwnerInfo/);
  assert.match(source, /const ownerTakeoverReady = Boolean\(schedulerOwnerInfo && \(!schedulerOwnerInfo\.fresh \|\| !schedulerOwnerInfo\.alive\)\)/);
  assert.match(source, /scheduledApi\.takeoverScheduler\(\)/);
  assert.match(source, /refreshScheduledTasks\(\)/);
  assert.match(source, /ownerTakeoverReady &&/);
  assert.equal(englishMessages["scheduled.takeOver"], "Take over");
});
