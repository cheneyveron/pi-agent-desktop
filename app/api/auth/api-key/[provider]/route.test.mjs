import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

// auth.json lives in a temporary agent dir; nothing here touches ~/.pi.
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-api-key-route-"));
const authPath = path.join(agentDir, "auth.json");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = originalOffline;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const apiKeyRoute = await jiti.import("./route.ts");
const providersRoute = await jiti.import("../../providers/route.ts");

const SECRET = "sk-test-ab12cd34ef56gh78ij90kl12mn34op56";
const params = (provider) => ({ params: Promise.resolve({ provider }) });
const readAuth = async () => JSON.parse(await readFile(authPath, "utf8"));

beforeEach(async () => {
  await writeFile(authPath, JSON.stringify({
    openai: { type: "api_key", key: SECRET },
    anthropic: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 3_600_000 },
  }));
});

test("saving requires a non-empty key", async () => {
  for (const apiKey of [undefined, "", "   ", 42]) {
    const response = await apiKeyRoute.POST(new Request("http://localhost/api/auth/api-key/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }), params("openai"));
    assert.equal(response.status, 400, JSON.stringify(apiKey));
  }
  assert.equal((await readAuth()).openai.key, SECRET);
});

test("delete removes an API key but never an OAuth login", async () => {
  const oauth = await apiKeyRoute.DELETE(new Request("http://localhost"), params("anthropic"));
  assert.equal(oauth.status, 409);
  assert.equal((await readAuth()).anthropic.type, "oauth");

  const apiKey = await apiKeyRoute.DELETE(new Request("http://localhost"), params("openai"));
  assert.equal(apiKey.status, 200);
  const auth = await readAuth();
  assert.equal("openai" in auth, false);
  assert.equal(auth.anthropic.type, "oauth");
});

test("provider listings report sign-in state without the stored secret", async () => {
  const response = await providersRoute.GET();
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes("oauth-access"), false);
  assert.equal(text.includes("oauth-refresh"), false);
  const body = JSON.parse(text);
  assert.ok(Array.isArray(body.apiKeyProviders));
  assert.ok(Array.isArray(body.oauthProviders));
});
