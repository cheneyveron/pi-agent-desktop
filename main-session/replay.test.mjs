import assert from "node:assert/strict";
import test from "node:test";
import { replay } from "./replay.ts";

const items = [
  { id: "V1", ticket: "CAS-4731", dep: "deploy", desc: "after int deploy, verify Classic Report mail path", t0: "2026-10-27T19:06:00Z" },
  { id: "P1", ticket: "CAS-4731", dep: "PR", desc: "PR #169 review/merge", t0: "2026-10-27T19:06:00Z", prs: { "h/o/cas-report/169": { state: "MERGED", mergedAt: "2026-10-28T16:00:00Z" } } },
  { id: "W1", ticket: "PCT-119276", dep: "person", desc: "SP/Poseidon owner on ProductInstanceNotFound", t0: "2026-10-20T14:00:00Z" },
  { id: "U1", ticket: "EAI-370", dep: "person", desc: "user to provide fresh browser session", t0: "2026-10-30T15:21:00Z" },
  { id: "D1", ticket: "PCT-120665", dep: "date", desc: "recheck Pro line on/after 2026-10-29", t0: "2026-10-05T00:00:00Z" },
];

test("each kind of waiting item surfaces where the rules put it", () => {
  const out = replay({ items, to: "2026-11-05" });
  assert.equal(out.surfaced.V1.date, "2026-10-29", "verification the morning after the merge");
  assert.equal(out.surfaced.V1.category, "post_merge_verify");
  assert.equal(out.surfaced.V1.lagFromEventDays, 1);
  assert.equal(out.surfaced.W1.date, "2026-10-23", "a third party, on the third day without change");
  assert.equal(out.surfaced.W1.category, "waiting");
  assert.equal(out.surfaced.U1.date, "2026-10-31", "something the user owes, the next morning");
  assert.equal(out.surfaced.U1.category, "fresh");
  assert.equal(out.surfaced.D1.date, "2026-10-29", "a date wait on its date");
  assert.equal(out.surfaced.D1.lagFromEventDays, 0);
  assert.equal(out.surfaced.P1, undefined, "a PR wait is the checker's, not the user's");
  assert.ok(out.asks.some((a) => a.items.includes("V1") && a.category === "post_merge_verify"));
});

test("never more than five lines a day, and the same input gives the same output", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `X${i}`, ticket: `CAS-${1000 + i}`, dep: i % 2 ? "person" : "deploy",
    desc: i % 2 ? `customer to confirm ${i}` : `user to push fix ${i}`, t0: `2026-10-${String(10 + (i % 5)).padStart(2, "0")}T12:00:00Z`,
  }));
  const a = replay({ items: many });
  assert.ok(a.digests.every((d) => d.lines.length <= 5));
  assert.equal(a.summary.maxLinesPerDay, 5);
  assert.deepEqual(replay({ items: many }), a);
});

test("pickups passed as events resolve items; pickups.json guesses are ignored unless asked", () => {
  const withGuess = [{ ...items[3], pickup_ts: "2026-10-30T16:00:00Z" }];
  assert.ok(replay({ items: withGuess, to: "2026-11-02" }).surfaced.U1);
  assert.equal(replay({ items: withGuess, to: "2026-11-02", derivePickups: true }).surfaced.U1, undefined);
  const resolved = replay({ items: [items[3]], events: [{ t: "2026-10-30T18:00:00Z", type: "pickup", item: "U1" }], to: "2026-11-02" });
  assert.equal(resolved.surfaced.U1, undefined);
});

test("bad input is refused", () => {
  assert.throws(() => replay({ items: [] }), /non-empty/);
  assert.throws(() => replay({ items: [{ id: "Z", desc: "no time" }] }), /no time/);
});
