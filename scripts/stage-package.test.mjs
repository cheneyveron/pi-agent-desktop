import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { dedupeNestedPackages, externalPackageSpecifiers, findNestedPiScopePackages, findStagedCopies, stageCompletePackage, stageResolvedClosure } from "./stage-package.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stage-package-"));
  const source = join(root, "source", "quickjs-wasi");
  await mkdir(join(source, "dist"), { recursive: true });
  await writeFile(join(source, "package.json"), '{"name":"quickjs-wasi","version":"3.6.2"}');
  await writeFile(join(source, "quickjs.wasm"), "wasm");
  await writeFile(join(source, "dist", "index.js"), "full");
  const staged = join(root, "staged", "node_modules");
  await mkdir(staged, { recursive: true });
  return { root, source, staged, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function partialCopy(dir) {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "package.json"), '{"name":"quickjs-wasi","version":"3.6.2"}');
  await writeFile(join(dir, "dist", "index.js"), "traced");
}

const hasWasm = (dir) => readFile(join(dir, "quickjs.wasm"), "utf8").then((text) => text === "wasm", () => false);

test("completes a traced top-level copy (pi 1.0.1 layout)", async () => {
  const f = await fixture();
  try {
    await partialCopy(join(f.staged, "quickjs-wasi"));
    const written = await stageCompletePackage({ name: "quickjs-wasi", sources: [f.source], stagedNodeModulesDir: f.staged });
    assert.deepEqual(written, [join(f.staged, "quickjs-wasi")]);
    assert.equal(await hasWasm(join(f.staged, "quickjs-wasi")), true);
    assert.equal(await readFile(join(f.staged, "quickjs-wasi", "dist", "index.js"), "utf8"), "full");
  } finally {
    await f.cleanup();
  }
});

test("completes a nested copy when nothing is hoisted (pi 1.0.0 layout)", async () => {
  const f = await fixture();
  try {
    const nested = join(f.staged, "@earendil-works", "pi-coding-agent", "node_modules", "quickjs-wasi");
    await partialCopy(nested);
    const written = await stageCompletePackage({ name: "quickjs-wasi", sources: [f.source], stagedNodeModulesDir: f.staged });
    assert.deepEqual(written, [nested]);
    assert.equal(await hasWasm(nested), true);
    assert.equal(await findStagedCopies(f.staged, "quickjs-wasi").then((copies) => copies.length), 1);
  } finally {
    await f.cleanup();
  }
});

test("completes every copy when the top level and a nested one both exist", async () => {
  const f = await fixture();
  try {
    const top = join(f.staged, "quickjs-wasi");
    const nested = join(f.staged, "some-pkg", "node_modules", "quickjs-wasi");
    await partialCopy(top);
    await partialCopy(nested);
    const written = await stageCompletePackage({ name: "quickjs-wasi", sources: [f.source], stagedNodeModulesDir: f.staged });
    assert.deepEqual(written.sort(), [nested, top].sort());
    assert.equal(await hasWasm(top), true);
    assert.equal(await hasWasm(nested), true);
  } finally {
    await f.cleanup();
  }
});

test("falls back to the top level when the tracer kept no copy", async () => {
  const f = await fixture();
  try {
    const written = await stageCompletePackage({ name: "quickjs-wasi", sources: [f.source], stagedNodeModulesDir: f.staged });
    assert.deepEqual(written, [join(f.staged, "quickjs-wasi")]);
    assert.equal(await hasWasm(join(f.staged, "quickjs-wasi")), true);
  } finally {
    await f.cleanup();
  }
});

test("uses the first readable source and refuses when none exists", async () => {
  const f = await fixture();
  try {
    const missing = join(f.root, "nope");
    await stageCompletePackage({ name: "quickjs-wasi", sources: [missing, f.source], stagedNodeModulesDir: f.staged });
    assert.equal(await hasWasm(join(f.staged, "quickjs-wasi")), true);
    await assert.rejects(
      stageCompletePackage({ name: "quickjs-wasi", sources: [missing], stagedNodeModulesDir: f.staged }),
      /quickjs-wasi not found under node_modules/,
    );
  } finally {
    await f.cleanup();
  }
});

async function piFixture() {
  const root = await mkdtemp(join(tmpdir(), "stage-package-pi-"));
  const server = join(root, "resources", "server");
  const staged = join(server, "node_modules");
  await mkdir(staged, { recursive: true });
  return { root, server, staged, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function stagedPiPackage(staged, name, version, files = ["dist/index.js"]) {
  const dir = join(staged, "@earendil-works", name);
  await mkdir(dir, { recursive: true });
  if (version !== null) {
    await writeFile(join(dir, "package.json"), `{"name":"@earendil-works/${name}","version":"${version}"}`);
  }
  for (const file of files) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), "");
  }
  return dir;
}

test("dedupeNestedPackages removes a same-version nested copy", async () => {
  const f = await piFixture();
  try {
    await stagedPiPackage(f.staged, "pi-agent-core", "1.0.2");
    const agentDir = await stagedPiPackage(f.staged, "pi-coding-agent", "1.0.2");
    const nested = await stagedPiPackage(
      join(agentDir, "node_modules"),
      "pi-agent-core",
      "1.0.2",
    );
    const removed = await dedupeNestedPackages(f.server, () => {});
    assert.equal(removed, 1);
    assert.equal(await findStagedCopies(f.staged, "@earendil-works/pi-agent-core").then((c) => c.length), 1);
    assert.ok(!existsSync(nested));
    assert.equal((await findNestedPiScopePackages(f.staged)).length, 0);
  } finally {
    await f.cleanup();
  }
});

test("dedupeNestedPackages keeps a genuinely conflicting nested copy", async () => {
  const f = await piFixture();
  try {
    await stagedPiPackage(f.staged, "pi-agent-core", "1.0.2");
    const agentDir = await stagedPiPackage(f.staged, "pi-coding-agent", "1.0.2");
    await stagedPiPackage(join(agentDir, "node_modules"), "pi-agent-core", "0.87.1");
    const removed = await dedupeNestedPackages(f.server, () => {});
    assert.equal(removed, 0);
    // Kept — and therefore reported by the #72 build gate.
    assert.deepEqual(await findNestedPiScopePackages(f.staged), [
      join(agentDir, "node_modules", "@earendil-works", "pi-agent-core"),
    ]);
  } finally {
    await f.cleanup();
  }
});

test("dedupeNestedPackages warns and keeps nested pi copies when the top-level version is unreadable", async () => {
  const f = await piFixture();
  try {
    // The 0.4.7 payload shape: top-level pi-agent-core shipped dist/ only.
    await stagedPiPackage(f.staged, "pi-agent-core", null);
    const agentDir = await stagedPiPackage(f.staged, "pi-coding-agent", "0.87.1");
    await stagedPiPackage(join(agentDir, "node_modules"), "pi-agent-core", "0.87.1");
    const warnings = [];
    const removed = await dedupeNestedPackages(f.server, (message) => warnings.push(message));
    assert.equal(removed, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /pi-agent-core/);
    assert.deepEqual(await findNestedPiScopePackages(f.staged), [
      join(agentDir, "node_modules", "@earendil-works", "pi-agent-core"),
    ]);
  } finally {
    await f.cleanup();
  }
});

test("findNestedPiScopePackages ignores nested non-pi dependencies", async () => {
  const f = await piFixture();
  try {
    const agentDir = await stagedPiPackage(f.staged, "pi-coding-agent", "1.0.2");
    await mkdir(join(agentDir, "node_modules", "chalk"), { recursive: true });
    assert.deepEqual(await findNestedPiScopePackages(f.staged), []);
  } finally {
    await f.cleanup();
  }
});

async function writePackage(dir, manifest, files = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), contents);
  }
}

test("externalPackageSpecifiers keeps bare imports and requires the bedrock packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "stage-specifiers-"));
  try {
    const file = join(root, "bedrock-converse-stream.js");
    await writeFile(file, [
      'import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";',
      'import { NodeHttpHandler } from "@smithy/node-http-handler";',
      'import { HttpProxyAgent } from "http-proxy-agent";',
      'import { HttpsProxyAgent } from "https-proxy-agent";',
      'import { calculateCost } from "../models.js";',
      'import "node:fs";',
      'const dynamic = await import("./local.js");',
    ].join("\n"));
    assert.deepEqual(await externalPackageSpecifiers(file, [
      "@aws-sdk/client-bedrock-runtime",
      "@smithy/node-http-handler",
      "http-proxy-agent",
      "https-proxy-agent",
    ]), [
      "@aws-sdk/client-bedrock-runtime",
      "@smithy/node-http-handler",
      "http-proxy-agent",
      "https-proxy-agent",
    ]);
    await assert.rejects(
      externalPackageSpecifiers(file, ["missing-pkg"]),
      /does not import missing-pkg/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stageResolvedClosure copies the bedrock closure without clobbering hoisted copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "stage-bedrock-"));
  try {
    const importer = join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "bedrock-converse-stream.js");
    await mkdir(dirname(importer), { recursive: true });
    await writeFile(importer, "");
    await writePackage(
      join(root, "node_modules", "@aws-sdk", "client-bedrock-runtime"),
      { name: "@aws-sdk/client-bedrock-runtime", version: "3.1127.0", dependencies: { "@smithy/core": "1.0.0" } },
      { "dist/index.js": "sdk", "node_modules/leftover/junk.js": "no" },
    );
    await writePackage(
      join(root, "node_modules", "@smithy", "core"),
      { name: "@smithy/core", version: "1.0.0" },
      { "dist/index.js": "smithy" },
    );
    await writePackage(
      join(root, "node_modules", "https-proxy-agent"),
      { name: "https-proxy-agent", version: "7.0.6" },
      { "dist/index.js": "v7" },
    );
    await writePackage(
      join(root, "node_modules", "agent-base"),
      { name: "agent-base", version: "7.1.4" },
      { "dist/index.js": "agent7" },
    );
    await writePackage(
      join(root, "node_modules", "@earendil-works", "pi-ai", "node_modules", "https-proxy-agent"),
      {
        name: "https-proxy-agent",
        version: "9.1.0",
        dependencies: { "agent-base": "9.0.0" },
        optionalDependencies: { "missing-optional": "1.0.0" },
      },
      { "dist/index.js": "v9" },
    );
    await writePackage(
      join(root, "node_modules", "@earendil-works", "pi-ai", "node_modules", "agent-base"),
      { name: "agent-base", version: "9.0.0" },
      { "dist/index.js": "agent9" },
    );

    const staged = join(root, "staged", "node_modules");
    await mkdir(staged, { recursive: true });
    const written = await stageResolvedClosure({
      importer,
      specifiers: ["@aws-sdk/client-bedrock-runtime", "https-proxy-agent"],
      sourceRoot: root,
      stagedNodeModulesDir: staged,
    });

    assert.equal(await readFile(join(staged, "@aws-sdk", "client-bedrock-runtime", "dist", "index.js"), "utf8"), "sdk");
    assert.equal(existsSync(join(staged, "@aws-sdk", "client-bedrock-runtime", "node_modules", "leftover")), false);
    assert.equal(await readFile(join(staged, "@smithy", "core", "dist", "index.js"), "utf8"), "smithy");
    assert.equal(
      await readFile(join(staged, "@earendil-works", "pi-ai", "node_modules", "https-proxy-agent", "dist", "index.js"), "utf8"),
      "v9",
    );
    assert.equal(
      await readFile(join(staged, "@earendil-works", "pi-ai", "node_modules", "agent-base", "dist", "index.js"), "utf8"),
      "agent9",
    );
    assert.equal(existsSync(join(staged, "https-proxy-agent")), false);
    assert.equal(existsSync(join(staged, "agent-base")), false);
    assert.equal(written.length, 4);

    await assert.rejects(
      stageResolvedClosure({
        importer,
        specifiers: ["not-installed"],
        sourceRoot: root,
        stagedNodeModulesDir: staged,
      }),
      /not-installed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
