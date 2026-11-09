#!/usr/bin/env node
// Counts hard-coded inline type sizes, weights and hex colours in components/**/*.tsx.
// New UI takes a className (rules in app/native-theme.css) or a token such as
// var(--fs-caption), var(--fw-semibold) or var(--danger). The legacy values that
// remain are frozen per file in inline-style-baseline.json, so counts may only fall.
//
//   node scripts/inline-style-tokens.mjs           print current counts
//   node scripts/inline-style-tokens.mjs update    lower the baseline to the current counts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const BASELINE_PATH = join(root, "scripts/inline-style-baseline.json");

export const RULES = {
  // fontSize: 12 / fontSize: "12px" / fontSize: compact ? 11 : 12 — a token is var(--fs-*).
  fontSize: /\bfontSize:\s*(?:[^,}\n]*\?\s*)?["'`]?\d/g,
  fontWeight: /\bfontWeight:\s*(?:[^,}\n]*\?\s*)?["'`]?\d/g,
  // A hex literal inside a string, template or attribute value.
  hexColor: /(?<=["'`(\s,:])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g,
};

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });
}

export function countSource(source) {
  const clean = stripComments(source);
  return Object.fromEntries(Object.entries(RULES).map(([name, rule]) => [name, clean.match(rule)?.length ?? 0]));
}

export function countComponents() {
  const counts = {};
  for (const path of walk(join(root, "components")).sort()) {
    const file = relative(root, path).split(sep).join("/");
    const fileCounts = countSource(readFileSync(path, "utf8"));
    if (Object.values(fileCounts).some(Boolean)) counts[file] = fileCounts;
  }
  return counts;
}

export function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const counts = countComponents();
  if (process.argv[2] === "update") {
    const previous = readBaseline().files;
    const raised = Object.entries(counts).flatMap(([file, c]) => Object.entries(c)
      .filter(([rule, n]) => n > (previous[file]?.[rule] ?? 0)).map(([rule, n]) => `${file} ${rule} ${previous[file]?.[rule] ?? 0} -> ${n}`));
    if (raised.length && !process.argv.includes("--allow-increase")) {
      console.error(`Refusing to raise the baseline:\n  ${raised.join("\n  ")}\nUse a className or a token instead.`);
      process.exit(1);
    }
    writeFileSync(BASELINE_PATH, JSON.stringify({
      note: "Legacy inline values in components/**/*.tsx. Counts may only fall; see scripts/inline-style-tokens.mjs.",
      files: counts,
    }, null, 2) + "\n");
    console.log(`Baseline written: ${Object.keys(counts).length} files.`);
  } else {
    const totals = {};
    for (const c of Object.values(counts)) for (const [rule, n] of Object.entries(c)) totals[rule] = (totals[rule] ?? 0) + n;
    console.log(JSON.stringify(totals));
  }
}
