// Fork-only: ships the main-session service (main-session/, docs/agents/main-session.md) inside
// the staged desktop server, so desktop/main-session-launcher.cjs can start it with the bundled
// Node. The service is plain .ts run by Node's type stripping (which never strips inside
// node_modules), so it lands at resources/server/main-session/, beside the server's node_modules.
//
// Next's file tracer never sees these files, so everything they need is staged here explicitly:
// - the runtime modules (no tests, test helpers or fixtures), prompts/ and package.json;
// - files outside main-session/ they import by relative path (lib/exact-system-prompt.ts),
//   at the same path relative to the server root, so `../lib/…` keeps resolving;
// - the resolution closure of every bare package they import (typebox), except the
//   @earendil-works scope, which prepare-desktop.mjs already overlays completely.

import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stageResolvedClosure } from "./stage-package.mjs";

export const MAIN_SESSION_DIR = "main-session";
const PI_SCOPE = "@earendil-works/";

/** Whether a path inside main-session/ (posix or native separators) ships with the desktop server. */
export function isMainSessionRuntimeFile(relPath) {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.includes("fixtures") || parts.includes("node_modules")) return false;
  const name = parts[parts.length - 1];
  if (/\.test\.(?:mjs|ts|js)$/.test(name) || name === "test-helpers.mjs") return false;
  return true;
}

/** Relative and bare module specifiers of a source file: static imports, re-exports and literal dynamic imports. */
export function moduleSpecifiers(source) {
  const relativeSpecifiers = new Set();
  const bareSpecifiers = new Set();
  const patterns = [
    /^\s*import\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s+["']([^"']+)["']/gm,
    /^\s*export\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) relativeSpecifiers.add(specifier);
      else if (!specifier.startsWith("/")) bareSpecifiers.add(specifier);
    }
  }
  return { relative: [...relativeSpecifiers], bare: [...bareSpecifiers] };
}

/** `pkg/sub` → `pkg`, `@scope/pkg/sub` → `@scope/pkg`. */
export function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full, base)));
    else files.push(relative(base, full));
  }
  return files;
}

const isModuleFile = (file) => /\.(?:ts|mjs|js)$/.test(file);

/**
 * Copy main-session/ and what it imports into `serverResourcesDir`.
 *
 * @param {{ rootDir: string, serverResourcesDir: string }} options
 * @returns {Promise<{ files: string[], outside: string[], packages: string[] }>} paths relative to the server dir
 */
export async function stageMainSession({ rootDir, serverResourcesDir }) {
  const sourceDir = join(rootDir, MAIN_SESSION_DIR);
  const destinationDir = join(serverResourcesDir, MAIN_SESSION_DIR);
  await cp(sourceDir, destinationDir, {
    recursive: true,
    force: true,
    filter: (src) => isMainSessionRuntimeFile(relative(sourceDir, src)),
  });
  const files = (await listFiles(destinationDir)).map((file) => join(MAIN_SESSION_DIR, file));

  // Follow relative imports that leave main-session/, transitively.
  const outside = [];
  const bare = new Map(); // package name -> importing source file
  const pending = files.filter(isModuleFile).map((file) => join(rootDir, file));
  const seen = new Set(pending);
  const libDirExisted = await access(join(serverResourcesDir, "lib"), constants.F_OK).then(() => true, () => false);
  while (pending.length > 0) {
    const file = pending.shift();
    const specifiers = moduleSpecifiers(await readFile(file, "utf8"));
    for (const specifier of specifiers.bare) {
      const name = packageName(specifier);
      if (!bare.has(name)) bare.set(name, file);
    }
    for (const specifier of specifiers.relative) {
      const target = resolve(dirname(file), specifier);
      const rel = relative(rootDir, target);
      if (rel.startsWith("..") || rel.startsWith(sep)) {
        throw new Error(`${relative(rootDir, file)} imports ${specifier}, outside the repository.`);
      }
      if (rel === MAIN_SESSION_DIR || rel.startsWith(`${MAIN_SESSION_DIR}${sep}`)) {
        if (!isMainSessionRuntimeFile(relative(MAIN_SESSION_DIR, rel))) {
          throw new Error(`${relative(rootDir, file)} imports ${specifier}, which is excluded from the desktop bundle.`);
        }
        continue;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      await access(target, constants.R_OK);
      await mkdir(dirname(join(serverResourcesDir, rel)), { recursive: true });
      await cp(target, join(serverResourcesDir, rel), { force: true });
      outside.push(rel);
      if (isModuleFile(target)) pending.push(target);
    }
  }
  // lib/*.ts outside main-session/ is ESM; say so where it is staged, unless the server
  // already had a lib/ of its own (then Node detects the syntax, with a warning).
  if (!libDirExisted && outside.some((rel) => rel.startsWith(`lib${sep}`))) {
    await writeFile(join(serverResourcesDir, "lib", "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
  }

  const stagedNodeModulesDir = join(serverResourcesDir, "node_modules");
  const packages = [];
  for (const [name, importer] of bare) {
    if (name.startsWith(PI_SCOPE)) {
      // Overlaid with its complete dist/ by prepare-desktop.mjs; it must already be there.
      await access(join(stagedNodeModulesDir, name, "package.json"), constants.R_OK).catch(() => {
        throw new Error(`${name} (imported by ${relative(rootDir, importer)}) is missing from the staged server.`);
      });
      continue;
    }
    await stageResolvedClosure({ importer, specifiers: [name], sourceRoot: rootDir, stagedNodeModulesDir });
    packages.push(name);
  }
  return { files, outside, packages };
}
