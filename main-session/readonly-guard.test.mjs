import assert from "node:assert/strict";
import test from "node:test";
import { checkReadonlyBash, splitWords } from "./readonly-guard.ts";
import { parseVerdict } from "./dispatch.ts";

const allowed = [
  "git log --oneline -n 20",
  "git -C /work/cas-admin show HEAD~1 --stat",
  "git --no-pager diff origin/int...HEAD",
  "git status",
  "git ls-remote --heads origin cheney/fix/x",
  "gh pr view 752 --json state,mergedAt",
  "gh pr checks 752",
  "gh pr list --author @me",
  "curl -s https://api.example.com/health",
  "curl -s 'https://api.example.com/v1/items?a=1&b=2'",
  "curl -s -X GET https://api.example.com/x -H 'Authorization: Bearer abc'",
  "wisp sql \"SELECT TOP 10 * FROM tm_org WHERE id = 'x'\"",
];

const refused = [
  ["git push origin main", /not read-only/],
  ["git commit -m x", /not read-only/],
  ["git log --output=/tmp/x", /--output/],
  ["git -c core.pager=sh log", /not read-only/],
  ["git log; rm -rf /", /shell operators/],
  ["git log | head", /shell operators/],
  ["git log > out.txt", /shell operators/],
  ["echo $(whoami)", /shell operators/],
  ["curl -s \"https://x/$HOME\"", /shell operators/],
  ["gh pr merge 752", /not allowed/],
  ["gh api repos/x", /not allowed/],
  ["curl https://x", /curl -s/],
  ["curl -s -X POST https://x", /only send GET/],
  ["curl -s -XDELETE https://x", /only send GET/],
  ["curl -s -d a=b https://x", /not allowed/],
  ["curl -s -o /tmp/f https://x", /not allowed/],
  ["wisp sql \"UPDATE tm_org SET x=1\"", /SELECT/],
  ["wisp sql \"SELECT * INTO t2 FROM t\"", /write keyword/],
  ["rm -rf /", /not on the read-only list/],
  ["node -e 1", /not on the read-only list/],
  ["", /empty/],
  ["git log 'unbalanced", /unbalanced/],
];

test("read-only commands pass", () => {
  for (const command of allowed) assert.deepEqual(checkReadonlyBash(command), { ok: true }, command);
});

test("writes, other programs and shell syntax are refused with a reason", () => {
  for (const [command, reason] of refused) {
    const verdict = checkReadonlyBash(command);
    assert.equal(verdict.ok, false, command);
    assert.match(verdict.reason, reason, command);
  }
});

test("words split on spaces outside quotes", () => {
  assert.deepEqual(splitWords(`a "b c" 'd e' f`), ["a", "b c", "d e", "f"]);
  assert.equal(splitWords(`a "b`), null);
});

test("dispatch verdicts come from the answer's first word", () => {
  assert.deepEqual(parseVerdict("PASS: deployed image matches"), { failed: false, known: true });
  assert.deepEqual(parseVerdict("FAIL: 500 from /health"), { failed: true, known: true });
  assert.deepEqual(parseVerdict("could not reach dev"), { failed: false, known: false });
});
