import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A `var(--x)` with no fallback whose variable nobody defines makes the whole
// declaration invalid at computed-value time. 7d3d13e1 removed
// --right-panel-gutter while the compact panel still read it: top, right,
// bottom and width all fell back to their initial values, so the closed
// drawer peeked over the topbar and the open one shrank into a corner.

const root = fileURLToPath(new URL("../", import.meta.url));

function filesUnder(dir, extensions) {
  return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)) && !entry.name.includes(".test."))
    .map((entry) => join(entry.parentPath, entry.name));
}

test("every CSS variable read without a fallback is defined somewhere", () => {
  const css = filesUnder("app", [".css"]).map((file) => readFileSync(file, "utf8")).join("\n");
  // Variables can also be set from components (inline styles, setProperty).
  const source = ["components", "hooks", "lib", "app"]
    .flatMap((dir) => filesUnder(dir, [".tsx", ".ts"]))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const defined = new Set([
    ...Array.from(css.matchAll(/(--[\w-]+)\s*:/g), (match) => match[1]),
    ...Array.from(source.matchAll(/["'`](--[\w-]+)["'`]/g), (match) => match[1]),
  ]);
  const missing = new Set();
  for (const match of css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    if (!match[2] && !defined.has(match[1])) missing.add(match[1]);
  }
  assert.deepEqual([...missing].sort(), []);
});
