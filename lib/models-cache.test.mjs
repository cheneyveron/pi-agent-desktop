import assert from "node:assert/strict";
import test from "node:test";

import {
  invalidateModelsCache,
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
} from "./models-cache.ts";

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    defaultThinkingLevel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
  };
}

test("caches model data independently for each cwd", async () => {
  invalidateModelsCache();
  let firstLoads = 0;
  let secondLoads = 0;

  const first = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("first");
  });
  await loadModelsWithCache("/second", async () => {
    secondLoads += 1;
    return modelsData("second");
  });
  const firstAgain = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("replacement");
  });

  assert.deepEqual(firstAgain, first);
  assert.equal(firstLoads, 1);
  assert.equal(secondLoads, 1);
});

test("shares one loader between concurrent requests for the same cwd", async () => {
  invalidateModelsCache();
  let loads = 0;
  let finishLoad;
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => { finishLoad = resolve; });
  };

  const first = loadModelsWithCache("/shared", loader);
  const second = loadModelsWithCache("/shared", loader);
  await Promise.resolve();

  assert.equal(loads, 1);
  finishLoad(modelsData("shared"));
  assert.deepEqual(await second, await first);
});

test("does not cache a stale load that finishes after invalidation", async () => {
  invalidateModelsCache();
  let finishOldLoad;
  const oldLoad = loadModelsWithCache("/stale", () => new Promise((resolve) => { finishOldLoad = resolve; }));
  await Promise.resolve();

  invalidateModelsCache();
  let freshLoads = 0;
  const fresh = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("fresh");
  });
  finishOldLoad(modelsData("stale"));
  await oldLoad;

  const cached = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("unexpected");
  });
  assert.deepEqual(cached, fresh);
  assert.equal(freshLoads, 1);
});

test("retries after a model load fails", async () => {
  invalidateModelsCache();
  await assert.rejects(
    loadModelsWithCache("/failed", async () => { throw new Error("load failed"); }),
    /load failed/,
  );

  let retries = 0;
  const fresh = await loadModelsWithCache("/failed", async () => {
    retries += 1;
    return modelsData("fresh");
  });
  assert.deepEqual(fresh, modelsData("fresh"));
  assert.equal(retries, 1);
});

test("serves an expired list at once and refreshes it later in the background", async (t) => {
  invalidateModelsCache();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return modelsData(`load-${loads}`);
  };

  const first = await loadModelsWithCache("/swr", loader);
  t.mock.timers.tick(61_000);

  // Expired: the old list comes back without waiting for the loader.
  assert.deepEqual(await loadModelsWithCache("/swr", loader), first);
  assert.deepEqual(await loadModelsWithCache("/swr", loader), first);
  assert.equal(loads, 1);

  t.mock.timers.tick(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 2, "one background refresh for any number of stale hits");
  assert.deepEqual(await loadModelsWithCache("/swr", loader), modelsData("load-2"));
});

test("keeps the expired list when a background refresh fails, then retries", async (t) => {
  invalidateModelsCache();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let fail = false;
  let loads = 0;
  const loader = async () => {
    loads += 1;
    if (fail) throw new Error("load failed");
    return modelsData(`load-${loads}`);
  };

  const first = await loadModelsWithCache("/swr-fail", loader);
  t.mock.timers.tick(61_000);
  fail = true;
  assert.deepEqual(await loadModelsWithCache("/swr-fail", loader), first);
  t.mock.timers.tick(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 2);

  fail = false;
  assert.deepEqual(await loadModelsWithCache("/swr-fail", loader), first);
  t.mock.timers.tick(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 3);
  assert.deepEqual(await loadModelsWithCache("/swr-fail", loader), modelsData("load-3"));
});

test("drops expired lists on invalidation instead of serving them", async (t) => {
  invalidateModelsCache();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await loadModelsWithCache("/swr-invalidate", async () => modelsData("old"));
  t.mock.timers.tick(61_000);
  invalidateModelsCache();
  assert.deepEqual(
    await loadModelsWithCache("/swr-invalidate", async () => modelsData("new")),
    modelsData("new"),
  );
});

test("adds runtime errors without discarding available models", () => {
  const data = modelsData("builtin");
  const result = withModelRuntimeError(data, "Invalid models.json schema");

  assert.deepEqual(result, {
    ...data,
    modelError: "Invalid models.json schema",
  });
});

test("uses a safe error for unexpected model load failures", () => {
  const data = {
    ...modelsData("builtin"),
    modelError: "Failed to load /Users/example/.pi/agent/models.json with token secret",
  };
  const result = withSafeModelLoadFailure(data);

  assert.deepEqual(result, {
    ...data,
    modelError: "Model list is temporarily unavailable. Check your configuration and try again.",
  });
});
