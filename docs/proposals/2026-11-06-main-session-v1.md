# 主会话 v1：实现合同（2026-11-06）

设计来源（只读，在仓库外）：
- `~/workspaces/experiments/2026-11-memory/ARCH-2026-11-03.md`（架构、动作集、第一版范围、§7 界面位置）
- `~/workspaces/experiments/2026-11-memory/WHOLE-2026-11-03.md`（目标与四个过程）
- `~/workspaces/experiments/2026-11-memory/examples/proto2-5b-dashboard.html` + `.md`（用户选定的主会话页面原型，像素级参照）
- `~/workspaces/experiments/2026-11-memory/examples/02-seg-case.md`、`01-forgotten-fix.md`（交互剧本）
- 交接提示的原型：`~/workspaces/experiments/2026-11-memory/closeout/prompt.md`，锚点版 `learned-anchors/scripts/anchored_closeout_prompt.md`
- 真实等待项（回放用）：`~/workspaces/experiments/2026-11-memory/mine-dropped-followups/{items.json,verdicts.json,CASES.md}`

本文件是三个并行实现之间的合同。改合同先改这里，再改代码。

## 0. 范围与不做的

v1 做：交接扩展；主会话服务（任务状态、交接入口、分支/PR 检查器、每日 tick、判断回合、摘要、insert、schedule）；桌面界面（侧栏"需要你"分组、置顶"主会话"、主会话页面）；memhana **只写不读**（写不通就落文件，不阻塞）。

v1 不做：会话内按处境回想与投递（第二版）；kb 导入；代码图；Claude Code 侧；Tauri sidecar 打包（v1 由 `npm run dev` / `npm run main-session` 启动，桌面打包接入是后续）。

模型约束（硬）：一切经 rdsec 的调用只用 `claude-haiku-5-5` 或 `gpt-6-luna`；默认 haiku；不配置 opus/sonnet/fable。

## 1. 进程与端口

- 主会话服务：仓库内新目录 `main-session/`，独立 Node 进程（`node main-session/server.mjs`），监听 `127.0.0.1:30180`（可用 `MAIN_SESSION_PORT` 覆盖），只绑本地。状态落盘 `~/.pi/agent/main/`（`tasks.json`、`events.jsonl`、`closeouts/<sessionId>.json`、`schedules.json`、`seen.json`）。
- 与 Next 服务的关系：Next 侧只提供代理路由 `app/api/main-session/[...path]/route.ts`，把请求原样转发到 `127.0.0.1:30180`（含 SSE），不在 Next 里放业务逻辑。UI 只调 `/api/main-session/*`。
- 启动：`package.json` 加 `"main-session": "node main-session/server.mjs"`；`npm run dev` 用 `concurrently`（已是依赖则用，否则用 `npm-run-all` 或简单的 `node scripts/dev-with-main-session.mjs` 同时起两个）。服务不在时 UI 显示"主会话未运行"，不报错。
- 服务用 pi SDK 开判断回合（和 `lib/rpc-manager.ts` 同一套 `createAgentSessionFromServices`，但不进 `globalThis.__piSessions` 注册表），模型 haiku，工具只有 §5 的动作集，无 bash/文件工具。

## 2. 数据模型（`main-session/types.ts`）

```ts
type TaskStatus = 'need' | 'watch' | 'done' | 'archived';
interface Task {
  id: string;                // 主键：首个看到的 ticket id（CAS-4764 / PCT-121470 / EAI-370），没有 ticket 时用 'org:<guid>' 或 'repo:<name>:<branch>'
  aliases: string[];         // 其它 id：PCT/CAS/TM/biz/org/group、分支名、PR 号 '#752'
  title: string;
  status: TaskStatus;
  repo?: string; branch?: string;
  stands: string;            // 一段，最近一次交接的 stands
  next: NextItem[];          // {text, run:'me'|'agent'|'notify'|'checker', on?:string, done?:boolean}
  waits: Wait[];             // {who, what, since, until?, closed?:boolean, evidence?:string}
  artifacts: string[];       // 'branch:…' 'commit:…' 'pr:#…' 'file:…'
  sessions: string[];        // pi session ids（最新在前）
  open: OpenQ[];             // {question, who, answerGoesTo:'task'|'session'|'memory', then?:string}
  log: LogRef[];             // 指向 events.jsonl 的 event id
  createdAt: string; updatedAt: string; lastSeenAt?: string;
}
interface Event { id:string; t:string; task?:string; action:'assign'|'update'|'dispatch_readonly'|'ask'|'archive'|'remember'|'digest'|'insert'|'schedule'|'checker'|'closeout'|'answer'; auto:boolean; why:string; data:any }
interface Closeout { sessionId:string; cwd:string; t:string; thread:string|'new:<slug>'|'none'; stands:string; next:NextItem[]; produced:string[]; learned:{text:string, anchors?:{path:string,symbol?:string}[]}[]; user_said:{text:string, kind:'correction'|'preference'|'instruction'}[]; open:OpenQ[]; next_time?:string[] }
interface DigestLine { kind:'need'|'did'|'archive'; task:string; text:string; chips?:string[]; eventId:string }
```

`seen.json` 记每段（need/watch/done）用户上次查看的时间，用于"自上次以来 +N"。

## 3. HTTP 合同（服务直连 `http://127.0.0.1:30180`，UI 经 `/api/main-session`）

| 方法 路径 | 作用 | 请求 / 响应 |
|---|---|---|
| GET `/health` | 服务在不在 | `{ok:true, since:ISO, version}` |
| GET `/tasks?status=need\|watch\|done` | 列表 | `{tasks:Task[], seen:{need,watch,done}}` |
| GET `/tasks/:id` | 详情（含 events 展开） | `{task, events:Event[], closeouts:Closeout[]}` |
| POST `/tasks/:id/answer` | 回答一条（chip 或一句话） | `{word:string, eventId?:string}` → `{task, event}`；写操作的回答不执行，只记 approval |
| POST `/tasks/:id/archive` | 归档（建议 48h 自动生效由服务定时器做；此接口是立即） | `{}` → `{task}` |
| POST `/tasks/:id/undo` | 撤销最近一次 answer/archive（5 分钟内） | `{eventId}` → `{task}` |
| POST `/closeouts` | 交接入口（扩展调用） | `Closeout` → `{task, event}`；服务做 assign（别名表匹配）、update、remember |
| POST `/seen` | 标记看过 | `{segment:'need'\|'watch'\|'done'}` → `{seen}` |
| GET `/digest?date=YYYY-MM-DD` | 当日摘要（≤5 行） | `{date, lines:DigestLine[], narrative:string}` |
| POST `/chat` | 问主会话 | `{text}` → `{reply:string, cites:{task?:string, sessionId?:string, eventId?:string}[], actions:Event[]}`；"提醒我…"→ schedule，"以后…"→ remember，其它从任务状态回答 |
| GET `/events?since=ISO` | 后台日志 | `{events:Event[]}` |
| GET `/stream` | SSE：`task`（任务变化）、`digest`、`insert`（{sessionId,text,task}）、`event` | |
| POST `/sessions/:sessionId/started` | UI 开了挂到任务的会话时通知 | `{task}` |
| POST `/replay` | 回放（测试用）：喂历史等待项和事件，返回会生成的 ask/schedule | `{items:[], events:[]}` → `{digests:[], asks:[]}` |

错误：JSON `{error:string}` + 4xx/5xx。所有写接口幂等（带 `eventId` 的重复提交返回同一结果）。

## 4. 交接扩展（`lib/closeout-extension.ts`，注册为 `builtin:closeout`）

- 触发：会话空闲 5 分钟且本次有工具活动；`session_shutdown`；`compaction_start`。每次增量：只总结上次交接之后的消息。
- 做法：用会话自己的模型（用户日常是 haiku）跑一个隐藏回合（不进会话文件的对话主线，作为 custom entry `closeout` 记录），提示基于 `closeout/prompt.md` + 锚点版：`learned` 每条尽量带 `{path, symbol}` 但不强制（K3 的教训：强制会减半条目）；`open` 必须结构化；看到 PR 号就写 `on: pr #N`。
- 输出 POST 到 `/closeouts`；服务不在就写到 `~/.pi/agent/main/outbox/`，服务起来后补投。
- 会话里显示收尾卡（custom entry，`type:'closeout'`，前端 `MessageView` 渲染为卡片，字段可编辑，"交接"按钮重新 POST）。
- `insert`：服务通过 SSE `insert` 事件请求向某个**正在运行或空闲但打开**的会话插一条消息。实现：`rpc-manager` 暴露 `injectMainSessionNote(sessionId, text, task)`：若会话正在运行用 `session.steer()`，否则 `session.queue()`/下一轮前置；同时写 custom entry `type:'main-session-note'` 供前端渲染为"主会话"消息（可折叠、可点任务）。模型看到的文本前缀固定：`[主会话提醒] …`。
- 规则：不改 `agent.state.systemPrompt`（硬规则）；遵守 `AgentSessionWrapper.isRunning()` 语义；不新增第二条 exact prompt 路径。

## 5. 判断回合（`main-session/judge.ts`）

- 何时跑：收到交接；检查器状态变化（分支推了、PR 开/合、CI 结果）；每日 tick（默认 09:00 本地，`seen` 之后）；用户 `/chat`。
- 输入：事件 + 涉及任务的全文 + 近期任务一行板（30 天内有活动的）+ 固定提示（`main-session/prompts/judge.md`，从 `main-session-sim/prompt_main.md` 演化）。
- 工具 = 动作集（全部是服务内函数，不是 bash）：`assign` `update` `dispatch_readonly` `ask` `archive` `remember` `digest` `insert` `schedule`。每次调用都写 Event，带 `why`。
- 权限：`dispatch_readonly` 只能派只读会话：工具白名单 `read,grep,find,ls,bash`，bash 只允许白名单命令前缀（`git log/show/status/diff/ls-remote`、`gh pr view/checks/list`、`curl -s GET`、`wisp` 的 SELECT 包装），其它 bash 一律拒绝并记事件。写操作永远走 `ask`。
- `ask` 的归宿：立即（P1、prod org、验证失败）→ SSE `event` + 桌面通知；否则攒进当日摘要。
- 摘要规则：每天 ≤5 行，优先级 = 立即项 > 合并/部署后做不了的验证 > 等人 >3 天且没变化 > 结果改变决定的"替你做了" > 建议归档（每天 ≤1 行，批量）> 积压（上线当天可占满，之后每天 ≤2 行）。未回答的项状态变了才重提，否则 5 个工作日后提一次。
- 归档：`archive` 是建议，48 小时无异议生效；有未推提交或关联 P1 的任务不自动归档。
- 检查器（`main-session/checkers/*.ts`，每 10 分钟）：`branch`（`git ls-remote` 本地仓库的远端）、`pr`（`gh pr view --json state,mergedAt,reviewDecision,statusCheckRollup`）、`date`、`manual`（到期提醒）。只读。

## 6. 界面（`components/main-session/*`，`hooks/useMainSession.ts`，`lib/main-session-client.ts`）

按 `proto2-5b-dashboard.html` 实现，差异只在接真实 API：
- 侧栏（`components/SessionSidebar.tsx`）：顶部置顶行"主会话"（未读点 = 自上次以来有新的 need）；其下"需要你 (N)"分组，行 = 任务 + 天数，行内 开会话 / 回复 / 归档；主会话页显示时分组收成标题。项目树不动。
- 主会话页（替换中栏内容，路由状态与现有 AppShell 的 URL 状态一致）：分段控件（need/watch/done + 自上次以来 +N + 只看新的）；点当前段收起/展开（无单独按钮）；列表区与对话区之间可拖动分隔条（高度存 localStorage，用 `lib/app-prefs.ts` 的 key 机制）；行 = 两行 + chip + 小"开会话" + "…"菜单（回复 / 归档 / 详情），菜单用 `.app-menu`（硬规则：所有菜单走共享面）；答后行滑出 + 5 秒撤销条（in-flow）+ 计数即时更新 + 焦点下一行；键盘 j/k 1/2/3 o e Enter Esc；对话区显示全部消息可滚动，第一条是服务给的 `narrative`，回答带"依据：…"链接。
- 开会话：`POST /api/agent/new` 带 cwd（任务的 repo）和首条消息（任务上下文包：stands + open + next 前三条，由服务 `GET /tasks/:id` 的 `contextPack` 字段提供），成功后 `POST /sessions/:id/started`。
- 会话内：`MessageView` 渲染 `closeout` 卡和 `main-session-note` 消息（折叠、点任务跳主会话页定位到该任务）。
- 通知：每日摘要到达 → `lib/desktop-notify.ts` 一条，点击落到主会话页。
- 样式只进 `app/native-theme.css`（硬规则）；`app/globals.css`、`app/settings.css` 不动。

## 7. 测试与验收

- 单测：`node --test`，文件命名 `*.test.mjs` 与现有一致。服务：别名匹配、摘要优先级与 5 行上限、归档 48h 规则、答案幂等、检查器解析（用固定的 gh/git 输出 fixture）。扩展：交接触发条件、outbox 补投、insert 的 steer/queue 分支。UI：分段/收起/拖动/撤销/键盘的组件测试（现有 `components/*.test.mjs` 的方式）。
- e2e：`e2e/main-session.mjs` 加进 `test:e2e`：起服务（fixture 数据）→ 侧栏有"需要你"→ 打开主会话 → 回答一条 → 行离开、计数变 → 撤销 → 开会话带上下文。
- 回放验收（我来跑）：`POST /replay` 喂 `mine-dropped-followups/items.json` 的 70 项和它们的真实事件时间，期望 17 个 dropped 里至少 15 个在其事件后 3 天内出现在摘要或立即项里；全周摘要行数 ≤ 5/天。
- 完成定义：三条分支各自 `npm test`、`npm run lint`、`npx tsc --noEmit` 通过；UI 分支过 `npm run test:e2e`；`npm run drift` 不报 CSS 基线变化；AGENTS.md 文件图和 Topic Notes 更新（新增 `docs/agents/main-session.md`）。不要推 main，开 PR 由我验收。

## 8. 分工（三个并行会话，文件不重叠）

| 会话 | 目录 | 不碰 |
|---|---|---|
| A 服务 | `main-session/**`、`app/api/main-session/**`、`package.json` 脚本、`docs/agents/main-session.md` | components、hooks、lib/rpc-manager.ts、lib/builtin-extensions.ts |
| B 扩展 | `lib/closeout-extension.ts`、`lib/closeout-prompt.md`、`lib/builtin-extensions.ts`（注册）、`lib/rpc-manager.ts`（仅 `injectMainSessionNote` 和 custom entry 写入）、`lib/session-reader.ts`（读 custom entry） | main-session/**、components |
| C 界面 | `components/main-session/**`、`components/SessionSidebar.tsx`、`components/MessageView.tsx`（两种新条目的渲染）、`components/AppShell.tsx`（页面挂载）、`hooks/useMainSession.ts`、`lib/main-session-client.ts`、`app/native-theme.css`、`e2e/main-session.mjs` | main-session/**、lib/rpc-manager.ts |

C 在 A 没就绪时用 `lib/main-session-client.ts` 里的 fixture 模式（`?mainSessionFixture=1` 或环境变量）开发；fixture 数据取自 `proto2-5b-dashboard.html` 里的数据。B 的 custom entry 形状以 §4 为准，C 按同一形状渲染。
