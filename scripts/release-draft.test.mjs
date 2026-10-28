import assert from "node:assert/strict";
import test from "node:test";
import { planReleaseDraft } from "./release-draft.mjs";

const sha = "4256a3f2e619505348c6283ef611765ecac37ad9";
const old = "ddd1b2fb354832e9fcbbe6f063c3d9a026e9ae9b";
const draft = (id, target, tag = "v0.7.14") => ({ id, tag_name: tag, draft: true, target_commitish: target });

test("a draft left by a run at another commit is deleted before building", () => {
  const releases = [draft(1, old), draft(2, old, "v0.7.13"), { id: 3, tag_name: "v0.7.13", draft: false }];
  assert.deepEqual(planReleaseDraft({ mode: "prepare", releases, tag: "v0.7.14", sha }).delete, [1]);
});

test("a rerun at the same commit keeps its draft and uploaded assets", () => {
  assert.deepEqual(planReleaseDraft({ mode: "prepare", releases: [draft(1, sha)], tag: "v0.7.14", sha }).delete, []);
  assert.deepEqual(planReleaseDraft({ mode: "prepare", releases: [], tag: "v0.7.14", sha }).delete, []);
});

test("an existing tag on another commit or a published release stops the run", () => {
  assert.throws(() => planReleaseDraft({ mode: "prepare", releases: [], tag: "v0.7.14", tagSha: old, sha }), /already points to/);
  assert.throws(
    () => planReleaseDraft({ mode: "prepare", releases: [{ id: 1, tag_name: "v0.7.14", draft: false }], tag: "v0.7.14", sha }),
    /already published/,
  );
});

test("publishing requires exactly one draft aimed at this commit", () => {
  assert.deepEqual(planReleaseDraft({ mode: "check", releases: [draft(1, sha)], tag: "v0.7.14", tagSha: sha, sha }).delete, []);
  assert.throws(() => planReleaseDraft({ mode: "check", releases: [draft(1, old)], tag: "v0.7.14", sha }), /targets ddd1b2fb/);
  assert.throws(() => planReleaseDraft({ mode: "check", releases: [], tag: "v0.7.14", sha }), /found 0/);
});
