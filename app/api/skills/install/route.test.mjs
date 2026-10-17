import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// Every case here must be refused before `npx skills add` runs: these tests
// never reach the network or install anything.
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-skills-install-agent-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

function allowOnly(...roots) {
  globalThis.__piAllowedRootsCache = { roots: new Set(roots), expiresAt: Date.now() + 60_000 };
}

function install(body, headers = {}) {
  return POST(new Request("http://localhost:30141/api/skills/install", {
    method: "POST",
    headers: { host: "localhost:30141", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("cross-site requests and non-JSON bodies are refused", async () => {
  const crossSite = await install({ package: "owner/skill" }, {
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(crossSite.status, 403);
  const form = await install("package=owner/skill", { "content-type": "application/x-www-form-urlencoded" });
  assert.equal(form.status, 415);
});

test("the package must be a non-empty string that cannot be read as an option", async () => {
  for (const pkg of [undefined, "", "   ", 42, ["owner/skill"]]) {
    const response = await install({ package: pkg });
    assert.equal(response.status, 400, JSON.stringify(pkg));
    assert.deepEqual(await response.json(), { error: "package required" });
  }
  for (const pkg of ["-g", "--global", " --agent=claude"]) {
    const response = await install({ package: pkg });
    assert.equal(response.status, 400, pkg);
    assert.deepEqual(await response.json(), { error: "Invalid package" });
  }
});

test("a project install needs an allowed and trusted cwd", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "pi-web-skills-install-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  // Only a folder with trust-requiring config (.pi/settings.json, mcp.json,
  // extensions) needs a decision; a bare folder counts as trusted, as in pi.
  await mkdir(path.join(project, ".pi"));
  await writeFile(path.join(project, ".pi", "settings.json"), "{}");

  allowOnly();
  assert.equal((await install({ package: "owner/skill", scope: "project" })).status, 400);
  const outside = await install({ package: "owner/skill", scope: "project", cwd: project });
  assert.equal(outside.status, 403);
  assert.deepEqual(await outside.json(), { error: "Access denied" });

  allowOnly(project);
  const untrusted = await install({ package: "owner/skill", scope: "project", cwd: project });
  assert.equal(untrusted.status, 403);
  assert.match((await untrusted.json()).error, /must be trusted/);
});
