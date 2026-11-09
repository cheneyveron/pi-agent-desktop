import assert from "node:assert/strict";
import test from "node:test";
import { countComponents, countSource, readBaseline } from "./inline-style-tokens.mjs";

test("counts literal sizes, weights and hex colours but not tokens", () => {
  assert.deepEqual(countSource(`
    style={{ fontSize: 12, fontWeight: 600, color: "#ef4444" }}
    style={{ fontSize: compact ? 11 : 12, fontWeight: "500" }}
    style={{ fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)", color: "var(--danger)" }}
    <path stroke="#fff" />
    // fontSize: 99 and "#000000" in a comment are ignored
  `), { fontSize: 2, fontWeight: 2, hexColor: 2 });
});

test("components add no new inline fontSize, fontWeight or hex colours", () => {
  const baseline = readBaseline().files;
  const raised = [];
  for (const [file, counts] of Object.entries(countComponents())) {
    for (const [rule, n] of Object.entries(counts)) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (n > allowed) raised.push(`${file}: ${rule} ${allowed} -> ${n}`);
    }
  }
  assert.deepEqual(raised, [], "New inline values in components. Give the element a className with its rule in "
    + "app/native-theme.css, or use a token (var(--fs-*), var(--fw-*), var(--danger) / --success / --warning). "
    + "After removing legacy values, lower the baseline with `node scripts/inline-style-tokens.mjs update`.");
});
