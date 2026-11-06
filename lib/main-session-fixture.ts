/**
 * Fixture backend for the main-session page, seeded with the data of the
 * prototype the user picked (proto2-5b-dashboard.html, 2026-11-03 state).
 * It implements the HTTP contract's semantics in memory so the UI can be
 * developed and tested before the service lands; e2e/main-session.mjs serves
 * the same backend over HTTP.
 */
import type {
  ChatReply, Digest, EventAction, MainEvent, MainSessionApi, NextItem, SeenMap, Segment, Task, TaskDetail,
} from "./main-session-client";

const YEAR = 2026;
/** "11-03 09:00" → local ISO-ish timestamp (no zone: parsed as local time). */
export function fixtureTime(short: string): string {
  const [md, hm = "00:00"] = short.split(" ");
  return `${YEAR}-${md}T${hm}:00`;
}

export const FIXTURE_SEEN = fixtureTime("10-16 18:12");

interface Row {
  id: string;
  short: string;
  text: string;
  why: string;
  ifNot?: string;
  chips?: string[];
  act: EventAction;
  at: string;
  source: string;
  title?: string;
  aliases?: string[];
  sessions?: string[];
  immediate?: boolean;
}

const NEED: Row[] = [
  { id: "CAS-4764", aliases: ["PCT-121470"], title: "P1 PCT-121470 根因修复", short: "4 天没推：推还是放弃", text: "CAS-4764（P1 PCT-121470 根因修复）：a58e342 在本地分支 cheney/bug/CAS-4764-entitlement-merge-by-group，4 天没推，没有 PR。推还是放弃？", chips: ["推", "放弃"], act: "ask", at: "11-03 09:00", source: "11-03 摘要 #1", sessions: ["fixture-day0", "fixture-cas"],
    why: "10-30 收尾后，检查器每 10 分钟查分支、PR、CI、部署标签；状态没变就不发事件，不跑判断回合，不花 token。前三天不列：唯一的 wait 是\"等你批准\"，是在等人，不是出错；PCT-121470 已由 ops force-sync 缓解。超期门槛取 >3 天，11-03 满 4 天进摘要。",
    ifNot: "主会话不会替你 push，任务就停在\"等你批准\"。N 天后会被归档，修复仍在本地。" },
  { id: "PCT-120665", short: "约好的复查过了 5 天", text: "PCT-120665：约好 10-29 复查 CECP Pro 续期是否还 Pending，过了 5 天没人查。还跟吗？", chips: ["跟", "关"], act: "ask", at: "11-03 09:00", source: "11-03 摘要 #2", why: "约定的复查日过了 5 天，没人查（例 01 · 11-03 摘要原文）。" },
  { id: "CAS-4766", short: "PR #51 待 review 第 4 天", text: "CAS-4766：cas-credit PR #51 待 review 第 4 天；dev 验证没做（工作站连不上 dev）。继续等？", chips: ["等", "换人"], act: "ask", at: "11-03 09:00", source: "11-03 摘要 #3", sessions: ["fixture-c4766"], why: "PR 检查器：#51 第 4 天没有 review；dev 验证卡在工作站连不上 dev（例 01 · 11-03 摘要原文）。" },
  { id: "CAS-4685", aliases: ["CAS-4687"], title: "CAS-4685 / CAS-4687", short: "dev 验证都卡在你这边", text: "CAS-4685 和 CAS-4687 的 dev 验证都卡在你这边（Horus 认可的组合；VPN 或办公网）。明天在办公网一起验？", chips: ["验", "不"], act: "ask", at: "10-19 17:30", source: "10-19 摘要 #1", sessions: ["fixture-h490", "fixture-c4687"], why: "21:19Z CAS-4687 交接：#940、#753 已开，dev 已部署，pod 检查和 Horus 卡死复现要 VPN；同一会话里你说\"CAS-4685 早就上 int\"并合进 dev → update 两个任务；两条阻塞都在你、都在 dev，合成一行。" },
  { id: "EAI-370", short: "GATE 2：CECP 上 int 了吗", text: "EAI-370 #260 等 GATE 2（CECP 后端上 int）4 天了，也没人 review。CECP 上 int 了吗？", chips: ["上了", "没上", "我去问"], act: "ask", at: "10-19 17:30", source: "10-19 摘要 #2", sessions: ["fixture-e370"], why: "S10 等了 4.3 天，过 3 天阈值；CECP 是别的团队部署，没有事件源；探测不安全（反馈接口是写）→ ask。" },
  { id: "org:773e0cdf", title: "org 773e0cdf", short: "type 13 仍是 B", text: "org 773e0cdf（prod-eu，没有 ticket）CECP 里 type 13 任务仍是 B†，周五给你的 reset curl 清不掉它。开 PCT 找 CECP owner 做 retry，还是放下？", chips: ["开 PCT", "放下"], act: "ask", at: "10-19 17:30", source: "10-19 摘要 #3", why: "C07 过 3 天；dispatch_readonly 用 wisp 只读查 CECP DB（结果†）；下一步要找人 → ask。" },
  { id: "EAI-264", short: "int 复测要写操作", text: "EAI-264 的 int 复测（重放 PCT-100152 保存 sensor target=all）6-30 起没做，是写操作。补测还是归档？", chips: ["补测", "归档"], act: "ask", at: "10-13 17:30", source: "10-13 摘要 #1", why: "引导导入 S01，tracker \"Live test on int\" 未勾 105 天；复测要保存配置，属写，needs-me。" },
  { id: "PCT-108871", short: "Confluence 页待更新", text: "PCT-108871 在 int-us 只读复测分页接口，通过†。Confluence 页还没更新，我起草？", chips: ["起草", "不"], act: "ask", at: "10-13 17:30", source: "10-13 摘要 #2", why: "PR #440 7-03 已合；只读复测是它自己派的（见处理掉的）；wiki 是写，留给你。" },
  { id: "CAS-4575", short: "结论写进 Jira 待你点头", text: "CAS-4575 的结论写进 Jira，9-04 起等你点头。发／不发？", chips: ["发", "不发"], act: "ask", at: "10-13 17:30", source: "10-13 摘要 #3", why: "导入 T04，tracker 唯一未勾项就是\"等你同意\"；ask，needs-me。" },
  { id: "EAI-331", short: "等 dulce_li、Erin", text: "EAI-331 还差 dulce_li 切 Smart Match、通知 Erin、Jira 转 Done，9-11 起没动。催还是关？", chips: ["催", "关"], act: "ask", at: "10-13 17:30", source: "10-13 摘要 #4", why: "导入 S06、S07，assign 合成一个 EAI-331 任务；等两个外部的人；ask，needs-me。" },
  { id: "EAI-317", short: "stg 逐 CECP 写验证待确认", text: "EAI-317 在 stg 上逐个 CECP 验证需要一次写操作，8-27 起等你确认。做还是归档？", chips: ["做", "归档"], act: "ask", at: "10-14 17:30", source: "10-14 摘要 #1", why: "导入 S03，9-01 之后只在 PR 列表里出现过；写操作，ask，needs-me。" },
  { id: "PCT ×3", aliases: ["PCT-114041", "PCT-119954", "PCT-115418"], short: "等外部 owner（3 件）", text: "3 个 PCT 在等外部 owner：114041（Abdalla，8-28 起）、119954（V1 credit，9-29 起）、115418（审计 owner，9-29 起）。逐个催还是归档？", chips: ["逐个催", "归档"], act: "ask", at: "10-15 17:30", source: "10-15 摘要 #1", why: "P02–P04 阻塞同类，合成一行；PCT 的 Jira 一律不写，只能问你；needs-me。" },
  { id: "EAI-340", short: "Confluence 403 + fixVersion", text: "EAI-340 9-15 已合 int，Confluence API 16 加 403、Jira fixVersion 还没改。我起草，你来改？", chips: ["起草"], act: "ask", at: "10-15 17:30", source: "10-15 摘要 #2", why: "导入 T11；Confluence 和 Jira 都是写；ask，needs-me。" },
  { id: "memory:weekly", title: "记忆", short: "每周整理：4 项待你批", text: "每周整理 · 11-03：新 2 · 修订 1 · 建议忘 1 · 建议提升 2 · 待你确认 1。其中 4 项要你回一个词。", chips: ["批准", "不"], act: "remember", at: "11-03 09:00", source: "11-03 每周整理", why: "例 04 的整理报告；不需要回答的 3 项（新 2、修订 1）只列在记忆页。" },
];

const WATCH: Row[] = [
  { id: "EAI-370 #260", aliases: ["EAI-370", "#260"], short: "#260 第 19 天没人 review", text: "EAI-370：PR #260 仍 OPEN、REVIEW_REQUIRED，第 19 天，卡在 CECP live test。", act: "update", at: "11-03 09:00", source: "11-03 摘要 #4", sessions: ["fixture-e370"], why: "替你做了：PR 检查器每 10 分钟查 #260，结果写进摘要，不要求回答。GATE 2（CECP 上 int）没有事件源，只能问你，见需要我的 10-19 那一行。" },
  { id: "CAS-4483", short: "建议归档，48 小时无异议生效", text: "CAS-4483：提交已在 origin/prod，tracker 还写 review。建议归档，48 小时无异议生效。", chips: ["归"], act: "archive", at: "11-03 09:00", source: "11-03 摘要 #5", why: "条件都关了 → archive 提议，自治。48 小时自动生效：ARCH §5 说\"建议\"，WHOLE §7 说自动，两处冲突，待你定。" },
  { id: "PCT-115072", aliases: ["T-0412", "CAS-4560", "TM-04049447"], short: "会话「看一下 PCT-115072」进行中，还没交接", text: "（T-0412 = CAS-4560）会话「看一下 PCT-115072」进行中，还没交接。close-out 到了才更新状态。", act: "update", at: "11-03 15:40", source: "例 02", sessions: ["fixture-pct"], why: "它只在交接时更新任务；会话还开着，就在这里盯着。" },
];

const DONE: Array<{ id: string; t: string; act: EventAction; x: string; why: string; sess?: string }> = [
  { id: "h-871", t: "10-13 17:30", act: "dispatch_readonly", x: "派只读会话：PCT-108871 在 int-us 复测分页接口，通过†", why: "PR #440 7-03 已合；复测只读，自治。Confluence 页是写，留给你（需要我的里那一行）。" },
  { id: "h-a13", t: "10-13 17:31", act: "archive", x: "提议归档 CAS-4560、EAI-310、EAI-360：git、gh pr view、tracker 显示三项条件已关（10-13 摘要 #5）", why: "只读核对后提议，48 小时无异议生效。" },
  { id: "h-a14", t: "10-14 17:30", act: "archive", x: "提议归档 EAI-165、EAI-347（已在 origin/int）和 CAS-4312、CAS-4315（6 月起没有会话）（10-14 摘要 #2）", why: "T08、T12 的提交在 origin/int，tracker 停在 review / in-progress；T01、T02 的源会话不在库里。回\"补验\"它才会开会话。" },
  { id: "h-370", t: "10-14 20:54", act: "update", x: "EAI-370：你 14:44 要 CEGP/GTOC 的人确认并批设计，20:54 自己接着做了 → 只 update，不出声", why: "你自己推进了，没有要问你的。", sess: "fixture-e370" },
  { id: "h-752", t: "10-16 15:30", act: "update", x: "PR 检查器：#752 MERGED（CAS-4685）→ 关掉\"等合并\"，生成\"合并后验证\"子任务", why: "条件变化 → 判断回合。10-15 交接写明 dev 组合都返回 490，只读做不了 → 转成问你。", sess: "fixture-h490" },
  { id: "h-mc", t: "10-16 15:40", act: "remember", x: "交接里的纠正记进 memhana：exchangeStage Done ≠ 已 provision", why: "你在会话里纠正\"provision 根本不是 done\"，纠正前那一轮 51 次工具调用；11-03 整理里成为 A08 修订。", sess: "fixture-a08" },
  { id: "h-267", t: "10-16 17:30", act: "archive", x: "提议归档 EAI-267：两条后续（SP_URL 标废弃、清 stuck org）是 agent 自己提的，你没接过（10-16 摘要 #2）", why: "S04 没有明确的等待；48 小时无异议生效。" },
  { id: "h-seg", t: "10-17 01:13", act: "update", x: "分支检查器：SEG skill 本地领先的 1 个提交已推上去 → 等待静默关掉", why: "20:48Z 第 0 天只记下；条件自己关了，不需要你。" },
  { id: "h-773", t: "10-19 12:00", act: "dispatch_readonly", x: "派只读会话：wisp 只读查 CECP DB，org 773e0cdf 的 type 13 任务仍是 B†", why: "C07 过 3 天；只读，自治；下一步要找人 → 转成问你。" },
  { id: "h-mb", t: "10-19 12:01", act: "remember", x: "交接里的纠正记进 memhana：prod / dev / stg 本机直连不通，经 eai-int 跳", why: "你在会话里纠正\"是要把 eai-int 做跳板，ssh 到 prod-wu\"；14 个会话里说过（K06）。", sess: "fixture-k06" },
  { id: "h-4687", t: "10-19 21:19", act: "update", x: "交接归到 CAS-4687，同时 update CAS-4685 → 两条阻塞合成一行重提", why: "周五那条 CAS-4685 没答；状态变了才重提，不每天重复。", sess: "fixture-c4687" },
  { id: "h-new", t: "10-30 18:00", act: "assign", x: "新建任务 CAS-4764，挂关联 id PCT-121470（取自 tracker related_cases）", why: "交接 POST 给主会话，主会话归任务。", sess: "fixture-day0" },
  { id: "h-m30", t: "10-30 18:01", act: "remember", x: "CAS-4764 收尾：两条 user_said 进 a（push 和合 dev 先经你批准；修复用 option 1），learned 进 b（clp_entitlement 旧行挡刷新）", why: "照收尾卡写；处境记 cas-auth / entitlement / PCT-121470。", sess: "fixture-day0" },
  { id: "h-s30", t: "10-30 18:02", act: "schedule", x: "会话「CAS-4764 修 entitlement merge 的 bug」收尾后：next 2（dev force-sync 验证，run: agent）挂到条件 on: pod-tag cas-auth 上，条件成立时派只读会话", why: "收尾卡 next 2 写的是 run: agent。条件没到不跑、不花 token，所以 10-31 到 11-02 没有任何记录。", sess: "fixture-day0" },
  { id: "h-tick", t: "11-03 08:55", act: "update", x: "每日 tick：CAS-4764 分支 4 天没推、没有 PR，过 >3 天门槛 → 进摘要", why: "前三天不列：唯一的 wait 是\"等你批准\"，是在等人，不是出错。" },
  { id: "h-dg3", t: "11-03 09:00", act: "digest", x: "生成 11-03 摘要（5 条）：分进上面三块里标\"11-03 摘要\"的行；桌面通知一条", why: "每天一次，最多五条。" },
  { id: "h-fu", t: "11-03 10:21", act: "insert", x: "在你开着的会话「PCT-121470 客户又报了」里插入一条主会话消息：这个 case 上次的根因在 CAS-4764，修复还没推", why: "扩展报告会话提到 PCT-121470 → 命中 CAS-4764 的关联 id；摘要第 1 条还没回；客户复发正是修复没上线的后果。", sess: "fixture-cas" },
];

/** Answers that close the task (moved to 处理掉的); the rest keep it in 在盯的. */
const CLOSING = new Set(["放弃", "归", "归档", "关", "放下", "看过了", "撤销", "不发"]);
/** Answers the service records but cannot execute (write operations): the task waits for the user's session. */
export const WRITE_ANSWERS = new Set(["推", "补测", "做", "补验", "起草", "发", "逐个催", "催", "开 PCT", "换人"]);

function baseTask(row: Row, status: Task["status"]): Task {
  const at = fixtureTime(row.at);
  const next: NextItem[] = row.chips?.length ? [{ text: row.short, run: "me" }] : [];
  return {
    id: row.id,
    aliases: row.aliases ?? [],
    title: row.title ?? row.id,
    status,
    stands: row.text,
    next,
    waits: [],
    artifacts: [],
    sessions: row.sessions ?? [],
    open: row.chips?.length ? [{ question: row.text, who: "你", answerGoesTo: "task" }] : [],
    log: [],
    createdAt: at,
    updatedAt: at,
  };
}

export function fixtureTasks(): Task[] {
  const tasks: Task[] = [];
  for (const row of NEED) {
    tasks.push({
      ...baseTask(row, "need"),
      ask: { eventId: `ask-${row.id}`, short: row.short, text: row.text, why: row.why, ifNot: row.ifNot, chips: row.chips ?? [], act: row.act, at: fixtureTime(row.at), immediate: row.immediate, source: row.source },
    });
  }
  for (const row of WATCH) {
    const task = baseTask(row, "watch");
    task.last = { eventId: `ev-${row.id}`, action: row.act, short: row.short, text: row.text, why: row.why, at: fixtureTime(row.at), sessionId: row.sessions?.[0] };
    if (row.chips?.length) task.ask = { eventId: `ask-${row.id}`, short: row.short, text: row.text, why: row.why, chips: row.chips, act: row.act, at: fixtureTime(row.at), source: row.source };
    tasks.push(task);
  }
  for (const entry of DONE) {
    const at = fixtureTime(entry.t);
    const ticket = entry.x.match(/\b(?:CAS|EAI|PCT)-\d{3,6}\b/)?.[0];
    tasks.push({
      id: entry.id, aliases: ticket ? [ticket] : [], title: ticket ?? entry.x, status: "done", stands: entry.x,
      next: [], waits: [], artifacts: [], sessions: entry.sess ? [entry.sess] : [], open: [], log: [entry.id],
      createdAt: at, updatedAt: at,
      last: { eventId: entry.id, action: entry.act, text: entry.x, why: entry.why, at, sessionId: entry.sess },
    });
  }
  return tasks;
}

const TICKET = /\b(?:CAS|EAI|PCT)-\d{3,6}\b|#\d+/g;

function age(iso: string, now: number): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "今天" : `${days} 天`;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface FixtureBackend extends Omit<MainSessionApi, "stream" | "fixture"> {
  /** Requests recorded for tests. */
  readonly calls: Array<{ method: string; args: unknown[] }>;
  snapshot(): Task[];
}

export function createFixtureBackend(options: { now?: () => number } = {}): FixtureBackend {
  const now = options.now ?? (() => Date.now());
  const tasks = new Map(fixtureTasks().map((task) => [task.id, task]));
  const seen: SeenMap = { need: FIXTURE_SEEN, watch: FIXTURE_SEEN, done: FIXTURE_SEEN };
  const events: MainEvent[] = [];
  const undo = new Map<string, Task>();
  const replies = new Map<string, MainEvent>();
  const calls: FixtureBackend["calls"] = [];
  let seq = 0;

  const find = (id: string): Task => {
    const task = tasks.get(id) ?? [...tasks.values()].find((t) => t.aliases.includes(id));
    if (!task) throw Object.assign(new Error(`unknown task ${id}`), { status: 404 });
    return task;
  };
  const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }); };
  const event = (task: string, action: EventAction, why: string, data: unknown): MainEvent => {
    const e: MainEvent = { id: `fx-${++seq}`, t: new Date(now()).toISOString(), task, action, auto: action !== "answer", why, data };
    events.unshift(e);
    return e;
  };
  const segmentOf = (task: Task): Segment => (task.status === "archived" ? "done" : task.status);

  return {
    calls,
    snapshot: () => [...tasks.values()].map((t) => structuredClone(t)),
    async health() { record("health"); return { ok: true, since: FIXTURE_SEEN, version: "fixture" }; },
    async listTasks(status) {
      record("listTasks", status);
      const list = [...tasks.values()].filter((t) => segmentOf(t) === status).map((t) => structuredClone(t));
      return { tasks: list, seen: { ...seen } };
    },
    async getTask(id) {
      record("getTask", id);
      const task = find(id);
      const detail: TaskDetail = {
        task: structuredClone(task),
        events: events.filter((e) => e.task === task.id),
        closeouts: [],
      };
      return detail;
    },
    async answer(id, word, eventId) {
      record("answer", id, word, eventId);
      const key = `${id}\u0000${eventId ?? ""}\u0000${word}`;
      const prior = eventId ? replies.get(key) : undefined;
      if (prior) return { task: structuredClone(find(id)), event: prior };
      const task = find(id);
      undo.set(task.id, structuredClone(task));
      const at = new Date(now()).toISOString();
      const closing = CLOSING.has(word);
      const write = WRITE_ANSWERS.has(word);
      const e = event(task.id, "answer", `你回了「${word}」`, { word, eventId });
      task.status = closing ? "done" : "watch";
      task.answered = { word, at };
      task.ask = undefined;
      task.open = [];
      task.updatedAt = at;
      task.last = {
        eventId: e.id,
        action: closing ? "archive" : "update",
        short: closing ? `你回了「${word}」，已归档` : write ? `等你在会话里执行「${word}」` : `你回了「${word}」`,
        text: closing ? `${task.id} 归档（你回了「${word}」）` : write ? `「${word}」是写操作：主会话只记下回答，开一个带好上下文的会话给你执行。` : `记下你的回答「${word}」，按它改状态。`,
        why: `你回了「${word}」（主会话页）。`,
        at,
      };
      if (eventId) replies.set(key, e);
      return { task: structuredClone(task), event: e };
    },
    async archive(id) {
      record("archive", id);
      const task = find(id);
      undo.set(task.id, structuredClone(task));
      const at = new Date(now()).toISOString();
      const e = event(task.id, "archive", "你点了归档", {});
      task.status = "done";
      task.ask = undefined;
      task.updatedAt = at;
      task.last = { eventId: e.id, action: "archive", short: "已归档", text: `${task.id} 归档，连同文件夹`, why: "你在主会话页点了归档。", at };
      return { task: structuredClone(task), event: e };
    },
    async undo(id) {
      record("undo", id);
      const before = undo.get(id) ?? undo.get(find(id).id);
      if (!before) throw Object.assign(new Error("nothing to undo"), { status: 409 });
      tasks.set(before.id, before);
      undo.delete(before.id);
      return { task: structuredClone(before) };
    },
    async seen(segment) {
      record("seen", segment);
      seen[segment] = new Date(now()).toISOString();
      return { seen: { ...seen } };
    },
    async digest(date) {
      record("digest", date);
      const t = now();
      const need = [...tasks.values()].filter((x) => x.status === "need");
      const isNew = (x: Task, segment: Segment) => (x.ask?.at ?? x.last?.at ?? x.updatedAt) > seen[segment];
      const newNeed = need.filter((x) => isNew(x, "need")).length;
      const newDone = [...tasks.values()].filter((x) => segmentOf(x) === "done" && isNew(x, "done")).length;
      const oldest = need.slice().sort((a, b) => (a.ask?.at ?? a.updatedAt).localeCompare(b.ask?.at ?? b.updatedAt))[0];
      const parts = [`你上次看是 ${shortTime(seen.need)}；之后 ${newNeed} 件新的要你定，它处理掉 ${newDone} 件`];
      if (oldest) parts[0] += `，最老的是 ${oldest.id}，问了你 ${age(oldest.ask?.at ?? oldest.updatedAt, t)}`;
      const digest: Digest = {
        date: date ?? new Date(t).toISOString().slice(0, 10),
        lines: need.slice(0, 5).map((x) => ({ kind: "need" as const, task: x.id, text: x.ask?.short ?? x.title, chips: x.ask?.chips, eventId: x.ask?.eventId ?? x.id })),
        narrative: `${parts[0]}。\n你可以问某件事卡在哪、等谁，或者给我指导。`,
      };
      return digest;
    },
    async chat(text) {
      record("chat", text);
      const ids = [...new Set((text.match(TICKET) ?? []))];
      const reply = (body: string, cites: ChatReply["cites"], actions: MainEvent[] = []): ChatReply => ({ reply: body, cites, actions });
      if (/提醒/.test(text)) {
        if (!ids.length) return reply("提醒哪个任务？给我任务号或 PR 号，比如「明天提醒我看 #260」。", []);
        const target = ids[0] === "#260" ? "EAI-370" : ids[0];
        const e = event(target, "schedule", `你在对话里说「${text}」`, { at: "tomorrow 09:00" });
        return reply(`好。明天 09:00 把「看 ${ids[0]}${ids[0] === "#260" ? "（EAI-370）" : ""}」放进「需要我的」，提醒前不打扰。`, [{ task: target, eventId: e.id }], [e]);
      }
      if (/以后|记住|下次/.test(text)) {
        const rule = text.replace(/^(以后|记住|下次)[，,：: ]*/, "");
        const e = event("memory:weekly", "remember", "你直接给的指导", { rule });
        return reply(`记下了，进 a（关于你）：「${rule}」。之后挂到相关任务的会话开头会带上。`, [{ eventId: e.id }], [e]);
      }
      if (ids.length) {
        const answers = ids.map((id) => {
          const task = tasks.get(id) ?? [...tasks.values()].find((t) => t.aliases.includes(id));
          if (!task) return `${id}：我没有这个任务。`;
          const where = { need: "需要我的", watch: "在盯的", done: "处理掉的", archived: "处理掉的" }[task.status];
          return `${task.id}${task.title !== task.id ? ` · ${task.title}` : ""}\n现在：${task.stands}\n${task.ask ? `我在 ${task.ask.source ?? "摘要"} 问过你：「${task.ask.short}」还没回，在「${where}」里。` : `它现在在「${where}」里。`}`;
        }).join("\n\n");
        const cites = ids.flatMap((id) => {
          const task = tasks.get(id) ?? [...tasks.values()].find((t) => t.aliases.includes(id));
          return task ? [{ task: task.id, ...(task.sessions[0] ? { sessionId: task.sessions[0] } : {}) }] : [];
        });
        return reply(answers, cites);
      }
      if (/做了什么|处理|替我|干了/.test(text)) {
        const done = [...tasks.values()].filter((x) => segmentOf(x) === "done");
        return reply(`都在上面「处理掉的」里：一共 ${done.length} 条。问我某一条为什么，或者某个任务。`, []);
      }
      return reply("这一句我在 fixture 里接不住。fixture 认得：任务号或 PR 号（卡在哪、等谁）、\"提醒\"、\"以后 / 记住\"、\"替我做了什么\"。", []);
    },
    async sessionStarted(sessionId, task) { record("sessionStarted", sessionId, task); },
    async postCloseout(closeout) {
      record("postCloseout", closeout);
      const task = [...tasks.values()].find((t) => t.sessions.includes(closeout.sessionId)) ?? find("CAS-4764");
      const e = event(task.id, "closeout", "交接", closeout);
      task.stands = closeout.stands || task.stands;
      task.updatedAt = e.t;
      return { task: structuredClone(task), event: e };
    },
  };
}

export function createFixtureApi(): MainSessionApi {
  const backend = createFixtureBackend();
  const latency = <T>(value: Promise<T>) => new Promise<T>((resolve, reject) => {
    setTimeout(() => value.then(resolve, reject), 60);
  });
  const wrap = <K extends keyof FixtureBackend>(key: K) => ((...args: unknown[]) =>
    latency((backend[key] as (...a: unknown[]) => Promise<unknown>)(...args))) as unknown as MainSessionApi[Extract<K, keyof MainSessionApi>];
  return {
    fixture: true,
    health: wrap("health"),
    listTasks: wrap("listTasks"),
    getTask: wrap("getTask"),
    answer: wrap("answer"),
    archive: wrap("archive"),
    undo: wrap("undo"),
    seen: wrap("seen"),
    digest: wrap("digest"),
    chat: wrap("chat"),
    sessionStarted: wrap("sessionStarted"),
    postCloseout: wrap("postCloseout"),
    stream: () => () => undefined,
  };
}
