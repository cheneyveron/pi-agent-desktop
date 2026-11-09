import assert from "node:assert/strict";
import test from "node:test";
import { answerFromState, chat, parseWhen } from "./chat.ts";
import { utcClock } from "./dates.ts";
import { Judge } from "./judge.ts";
import { makeCtx, task } from "./test-helpers.mjs";

// Monday 2026-11-02 13:00 UTC.
const NOW = new Date("2026-11-02T13:00:00.000Z");
const when = (text) => {
  const { at, rest } = parseWhen(text, NOW, utcClock);
  return [at.toISOString().slice(0, 16), rest];
};

test("reminder times in the user's words", () => {
  assert.deepEqual(when("明天下午3点 看 PR"), ["2026-11-03T15:00", "看 PR"]);
  assert.deepEqual(when("后天 合并"), ["2026-11-04T09:00", "合并"]);
  assert.deepEqual(when("3天后 复查 CAS-1"), ["2026-11-05T09:00", "复查 CAS-1"]);
  assert.deepEqual(when("2小时后 看日志"), ["2026-11-02T15:00", "看日志"]);
  assert.deepEqual(when("周五 交周报"), ["2026-11-06T09:00", "交周报"]);
  assert.deepEqual(when("下周一 早上9点半 开会"), ["2026-11-09T09:30", "开会"]);
  assert.deepEqual(when("11月15日 部署"), ["2026-11-15T09:00", "部署"]);
  assert.deepEqual(when("2026-12-01 续费"), ["2026-12-01T09:00", "续费"]);
  assert.deepEqual(when("今晚 8点 发版"), ["2026-11-02T20:00", "发版"]);
  assert.deepEqual(when("看一下 PR"), ["2026-11-03T09:00", "看一下 PR"], "no time → tomorrow 09:00");
});

test("提醒我 schedules a reminder on the task it names", async () => {
  const h = makeCtx(NOW.toISOString());
  h.ctx.store.putTask(task("CAS-4764"));
  const result = await chat(h.ctx, undefined, "提醒我明天 推 CAS-4764 的修复");
  assert.equal(result.actions[0].action, "schedule");
  assert.equal(h.ctx.store.schedules[0].task, "CAS-4764");
  assert.equal(h.ctx.store.schedules[0].createdBy, "user");
  assert.equal(h.ctx.store.schedules[0].at, "2026-11-03T09:00:00.000Z");
  assert.deepEqual(result.cites[0].task, "CAS-4764");
});

test("以后 is remembered", async () => {
  const h = makeCtx(NOW.toISOString());
  const result = await chat(h.ctx, undefined, "以后 CAS 的 PR 都先合 dev");
  assert.equal(result.actions[0].action, "remember");
  assert.equal(h.memory.records[0].speaker, "user");
});

test("a runner without a chosen model runs no turn", async () => {
  const h = makeCtx(NOW.toISOString());
  let turns = 0;
  const judge = new Judge(h.ctx, async () => { turns++; return "x"; });
  assert.equal(judge.enabled, true);
  assert.equal(judge.available, false);
  assert.deepEqual(await judge.run({ kind: "chat", text: "hi" }), { reply: "", events: [] });
  assert.equal(turns, 0);
});

test("without a model, questions are answered from task state", async () => {
  const h = makeCtx(NOW.toISOString());
  h.ctx.store.putTask(task("EAI-370", { status: "need", stands: "PR #260 open", next: [{ text: "live-verify CEGP", run: "me" }] }));
  const named = answerFromState(h.ctx, "eai-370 还有什么没做");
  assert.match(named.reply, /EAI-370（need）：PR #260 open 下一步：live-verify CEGP/);
  const general = await chat(h.ctx, new Judge(h.ctx, undefined), "这周我欠什么");
  assert.match(general.reply, /1 个任务等你/);
  assert.deepEqual(general.cites, [{ task: "EAI-370" }]);
});

test("with a model, the judge's reply and its actions come back with cites", async () => {
  const h = makeCtx(NOW.toISOString());
  h.ctx.store.putTask(task("CAS-4672", { stands: "PR #949 merged" }));
  const runner = async ({ user, tools, model }) => {
    assert.deepEqual(model, { provider: "anthropic", modelId: "claude-haiku-4-5" });
    assert.match(user, /CAS-4672 到哪了/);
    assert.match(user, /## Task CAS-4672/, "the named task is given in full");
    await tools.find((t) => t.name === "ask").execute({ task: "CAS-4672", question: "要验证 int 吗？", why: "merged, not verified" });
    return "CAS-4672 的 PR #949 已合并，int 上还没验证。";
  };
  const result = await chat(h.ctx, new Judge(h.ctx, runner, () => ({ provider: "anthropic", modelId: "claude-haiku-4-5" })), "CAS-4672 到哪了");
  assert.equal(result.reply, "CAS-4672 的 PR #949 已合并，int 上还没验证。");
  assert.equal(result.actions[0].action, "ask");
  assert.deepEqual(result.cites.map((c) => c.task), ["CAS-4672", "CAS-4672"]);
});
