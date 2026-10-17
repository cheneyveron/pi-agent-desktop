#!/usr/bin/env node
// Refresh the demo's copies of components/, hooks/ and lib/ (plus the app's
// stylesheets) from the main Pi Web tree.
//
//   node demo/scripts/sync-from-app.mjs           sync, then print a report
//   node demo/scripts/sync-from-app.mjs --check   report only; exit 1 on drift
//
// Which files are copied: everything the demo actually imports. The walk starts
// at the demo's own code (app/, mock/, types/) and the demo-patched files, and
// follows `@/components|hooks|lib/...` and relative imports through the main
// tree's versions. Copies nothing imports any more are deleted.
//
// Demo-patched files (PATCHED below, also listed in demo/README.md) are never
// overwritten. "merge" files get the main tree's changes since the last sync
// three-way merged into the demo copy (`git merge-file`, base = the version
// recorded in sync-base.json); conflicts are left as markers to fix by hand.
// "stub" files are hand-written type-only stand-ins for server modules; the
// report says when their original changed so the types can be checked.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const demoDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(demoDir, "..");
const baseFile = join(demoDir, "sync-base.json");

const SYNCED_DIRS = ["components", "hooks", "lib"];
// Copied verbatim whether or not the walk reaches them: the stylesheets are
// imported by the demo's own app/layout.tsx, the package file by lib/branding.ts.
const SYNCED_FILES = [
  "app/globals.css",
  "app/settings.css",
  "app/native-theme.css",
  "src-tauri/pi-agent-desktop-package.json",
];
// Demo-owned roots: walked for imports, never touched.
const DEMO_ROOTS = ["app", "mock", "types"];

/** @type {Record<string, "merge" | "stub">} */
const PATCHED = {
  "components/AppShell.tsx": "merge",
  "components/FileIcons.tsx": "merge",
  "components/ProviderIcon.tsx": "merge",
  "components/FileViewer.tsx": "merge",
  "components/FileExplorer.tsx": "merge",
  "components/MarkdownBody.tsx": "merge",
  "lib/subagent-extension.ts": "stub",
  "lib/terminal-manager.ts": "stub",
};

const check = process.argv.includes("--check");
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.tsx"];
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8", maxBuffer: 64 << 20 });
const readOr = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const isSynced = (rel) => SYNCED_DIRS.some((d) => rel.startsWith(`${d}/`));

function gitShow(commit, rel) {
  try {
    return git("show", `${commit}:${rel}`);
  } catch {
    return null;
  }
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => !p.split(/[\\/]/).includes("node_modules") && statSync(join(dir, p)).isFile())
    .map((p) => p.split("\\").join("/"));
}

// --- patched files: three-way merge against the recorded base -------------
const state = JSON.parse(readOr(baseFile) ?? "{}");
const baseCommitFor = (rel) => state.files?.[rel] ?? state.commit;

/** Content the demo should hold after this sync, keyed by demo-relative path. */
const planned = new Map();
const report = { added: [], updated: [], removed: [], merged: [], conflicts: [], stubs: [], external: [], deps: new Set(), typeDeps: new Set(), server: new Set() };

for (const [rel, mode] of Object.entries(PATCHED)) {
  const demoText = readOr(join(demoDir, rel));
  const mainText = readOr(join(rootDir, rel));
  if (demoText === null) throw new Error(`demo/${rel} is listed as patched but missing`);
  if (mainText === null) {
    report.stubs.push(`${rel}: removed from the main tree`);
    planned.set(rel, demoText);
    continue;
  }
  const base = baseCommitFor(rel);
  const baseText = base ? gitShow(base, rel) : null;
  if (baseText === null) throw new Error(`No base for ${rel}: set "commit" in demo/sync-base.json`);
  if (baseText === mainText) {
    planned.set(rel, demoText);
    continue;
  }
  if (mode === "stub") {
    report.stubs.push(`${rel}: original changed since ${base.slice(0, 8)}; check the types (git diff ${base.slice(0, 8)} -- ${rel})`);
    planned.set(rel, demoText);
    continue;
  }
  const tmp = join(demoDir, ".sync-tmp");
  mkdirSync(tmp, { recursive: true });
  const [o, b, t] = ["demo", "base", "main"].map((n) => join(tmp, n));
  writeFileSync(o, demoText);
  writeFileSync(b, baseText);
  writeFileSync(t, mainText);
  let merged;
  let conflicts = 0;
  try {
    merged = execFileSync("git", ["merge-file", "-p", "-L", "demo", "-L", "base", "-L", "main", o, b, t], { encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (e) {
    if (typeof e.status !== "number" || e.status < 0 || e.status > 127) throw e;
    merged = e.stdout;
    conflicts = e.status;
  }
  rmSync(tmp, { recursive: true, force: true });
  planned.set(rel, merged);
  (conflicts ? report.conflicts : report.merged).push(conflicts ? `${rel} (${conflicts} conflict${conflicts > 1 ? "s" : ""})` : rel);
}

// --- import walk ------------------------------------------------------------
const IMPORT_RE = /(import|export)\s+(type\s+)?(?:([^'"]*?)\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

/** Import specifiers of a module, marking the ones erased at compile time. */
function specifiers(text) {
  const out = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[4] ?? m[5] ?? m[6];
    // `import type …`, or `import { type A, type B }` where every name is a type.
    const names = m[3]?.trim().match(/^\{([\s\S]*)\}$/)?.[1].split(",").map((n) => n.trim()).filter(Boolean);
    const typeOnly = Boolean(m[2]) || Boolean(names?.length && names.every((n) => n.startsWith("type ")));
    out.push({ spec, typeOnly });
  }
  return out;
}

// Packages the demo declares itself (types/*.d.ts), so a type import of them is fine.
const stubbedModules = new Set(
  listFiles(join(demoDir, "types")).flatMap((p) =>
    [...readFileSync(join(demoDir, "types", p), "utf8").matchAll(/declare module ["']([^"']+)["']/g)].map((m) => m[1])),
);

/** Resolve a specifier to a repo-relative path inside the main tree or demo. */
function resolve(spec, fromRel) {
  let target;
  if (spec.startsWith("@/")) target = spec.slice(2);
  else if (spec.startsWith(".")) target = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  else return { bare: spec };
  const owner = isSynced(target) || SYNCED_FILES.includes(target) ? rootDir : demoDir;
  for (const ext of EXTENSIONS) {
    const candidate = target + ext;
    const inDemo = existsSync(join(demoDir, candidate)) && statSync(join(demoDir, candidate)).isFile();
    const inOwner = existsSync(join(owner, candidate)) && statSync(join(owner, candidate)).isFile();
    if (PATCHED[candidate] || (owner === demoDir ? inDemo : inOwner)) return { rel: candidate };
  }
  return { missing: target };
}

// Every reached file is copied (tsc needs type-only imports too); "runtime"
// files are the ones reached through value imports, which end up in the bundle.
const needed = new Set(SYNCED_FILES);
const queue = [];
for (const root of DEMO_ROOTS) for (const p of listFiles(join(demoDir, root))) queue.push([`${root}/${p}`, true]);
for (const rel of Object.keys(PATCHED)) queue.push([rel, true]);
const seen = new Map(); // rel -> reached at runtime

while (queue.length) {
  const [rel, runtime] = queue.pop();
  if (seen.has(rel) && (seen.get(rel) || !runtime)) continue;
  seen.set(rel, runtime);
  if (!/\.(m?[jt]sx?)$/.test(rel)) continue;
  const text = planned.get(rel) ?? (isSynced(rel) ? readOr(join(rootDir, rel)) : readOr(join(demoDir, rel)));
  if (text === null) continue;
  const copied = isSynced(rel) && !PATCHED[rel];
  for (const { spec, typeOnly } of specifiers(text)) {
    const r = resolve(spec, rel);
    if (r.bare) {
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!copied || stubbedModules.has(spec) || stubbedModules.has(pkg)) continue;
      if (NODE_BUILTINS.has(spec)) {
        if (runtime && !typeOnly) report.server.add(`${rel} → ${spec}`);
      } else if (runtime && !typeOnly) report.deps.add(pkg);
      else report.typeDeps.add(pkg);
      continue;
    }
    if (r.missing) {
      report.external.push(`${rel} → ${spec} (not found)`);
      continue;
    }
    if (isSynced(r.rel) && !PATCHED[r.rel]) needed.add(r.rel);
    else if (!isSynced(r.rel) && !SYNCED_FILES.includes(r.rel) && !DEMO_ROOTS.some((d) => r.rel.startsWith(`${d}/`))) {
      report.external.push(`${rel} → ${spec} (outside the synced dirs)`);
    }
    queue.push([r.rel, runtime && !typeOnly]);
  }
}

// --- plan copies and removals ------------------------------------------------
for (const rel of needed) {
  if (PATCHED[rel]) continue;
  const mainText = readOr(join(rootDir, rel));
  if (mainText === null) continue;
  const demoText = readOr(join(demoDir, rel));
  if (demoText === mainText) continue;
  planned.set(rel, mainText);
  (demoText === null ? report.added : report.updated).push(rel);
}
const toRemove = [];
for (const dir of SYNCED_DIRS) {
  for (const p of listFiles(join(demoDir, dir))) {
    const rel = `${dir}/${p}`;
    if (!needed.has(rel) && !PATCHED[rel]) toRemove.push(rel);
  }
}
report.removed.push(...toRemove);

// Packages the copied code imports that demo/package.json does not declare.
// Type-only imports may resolve through another package's dependencies, so
// they are listed only when nothing in node_modules provides them.
const demoPkg = JSON.parse(readFileSync(join(demoDir, "package.json"), "utf8"));
const declared = new Set([...Object.keys(demoPkg.dependencies ?? {}), ...Object.keys(demoPkg.devDependencies ?? {})]);
const installed = (pkg) => existsSync(join(demoDir, "node_modules", pkg)) || existsSync(join(demoDir, "node_modules", "@types", pkg.replace(/^@/, "").replace("/", "__")));
const missingDeps = [
  ...[...report.deps].filter((d) => !declared.has(d)),
  ...[...report.typeDeps].filter((d) => !declared.has(d) && !report.deps.has(d) && !installed(d)).map((d) => `${d} (only from code the bundle never loads)`),
].sort();

// --- apply -------------------------------------------------------------------
if (!check) {
  for (const [rel, text] of planned) {
    const path = join(demoDir, rel);
    if (readOr(path) === text) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  for (const rel of toRemove) rmSync(join(demoDir, rel));
  const head = git("rev-parse", "HEAD").trim();
  const dirty = git("status", "--porcelain", "--", ...SYNCED_DIRS, ...SYNCED_FILES).trim();
  writeFileSync(baseFile, `${JSON.stringify({ commit: head }, null, 2)}\n`);
  if (dirty) console.warn(`warning: the main tree has uncommitted changes; sync-base.json records ${head.slice(0, 8)} anyway\n`);
}

// --- report ------------------------------------------------------------------
const section = (title, items) => {
  if (!items.length) return;
  console.log(`${title} (${items.length}):`);
  for (const item of items) console.log(`  ${item}`);
};
const verb = check ? "would be " : "";
section(`Copies ${verb}added`, report.added);
section(`Copies ${verb}updated`, report.updated);
section(`Copies ${verb}removed (nothing imports them)`, report.removed);
section(`Patched files ${check ? "with main-tree changes to merge" : "merged cleanly"}`, report.merged);
section("Patched files with merge conflicts — resolve the markers by hand", report.conflicts);
section("Type-only stubs whose original changed", report.stubs);
section("Node built-ins in the browser bundle (server code reached through a value import)", [...report.server]);
section("Packages missing from demo/package.json", missingDeps);
section("Imports the walk could not follow", report.external);

const drift = report.added.length + report.updated.length + report.removed.length + report.merged.length + report.conflicts.length + report.stubs.length;
if (!drift) console.log("demo copies are in sync with the main tree.");
if (check && drift) process.exitCode = 1;
if (!check && report.conflicts.length) process.exitCode = 1;
