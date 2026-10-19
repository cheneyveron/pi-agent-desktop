import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./provider-listing-runtime.ts");
  } catch {
    return import("./provider-listing-runtime.ts");
  }
}

const { customModelsJsonProviderIds, collectProviderListingInputs } = await loadSubject();

test("custom models.json provider ids exclude built-in providers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-provider-listing-"));
  const modelsPath = join(dir, "models.json");
  try {
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        "my-gateway": { api: "openai-completions" },
        // A models.json override for a built-in provider is still built in:
        // the API-key list remains the place that manages its auth.json key.
        deepseek: { baseUrl: "https://gateway.example.com" },
      },
    }));

    assert.deepEqual([...customModelsJsonProviderIds(modelsPath)], ["my-gateway"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable or missing models.json yields no custom provider ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-provider-listing-"));
  try {
    assert.deepEqual([...customModelsJsonProviderIds(join(dir, "missing.json"))], []);
    writeFileSync(join(dir, "broken.json"), "[");
    assert.deepEqual([...customModelsJsonProviderIds(join(dir, "broken.json"))], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the adapter marks the custom ids it is given", async () => {
  const runtime = {
    getModels: () => [{ provider: "my-gateway" }],
    listCredentials: async () => [],
    getProviders: () => [{
      id: "my-gateway",
      name: "My Gateway",
      auth: { apiKey: { login: () => null } },
    }],
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
  };

  const inputs = await collectProviderListingInputs(runtime, new Set(["my-gateway"]));
  assert.equal(inputs[0].isCustomProvider, true);
});
