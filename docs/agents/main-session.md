# Main session (service)

Contract: [docs/proposals/2026-11-06-main-session-v1.md](../proposals/2026-11-06-main-session-v1.md).
This note covers part A, the service in `main-session/`; where it differs from the contract it says
so under "Deviations".

## Process
- A separate Node process: `npm run main-session` (`node main-session/server.mjs`), or
  `npm run dev:all` for `next dev` plus the service (an already running service is reused;
  `MAIN_SESSION=off` starts Next alone). Binds `127.0.0.1:30180` only (`MAIN_SESSION_PORT`).
- **Desktop app**: the packaged server starts it by default. `desktop/server-launcher.cjs` calls
  `desktop/main-session-launcher.cjs` right after requiring Next's `server.js`; it spawns
  `main-session/server.mjs` on the bundled Node (`process.execPath`) as a child of the server,
  unless `MAIN_SESSION=off`, or a service already answers `/health` with `ok: true` on the port
  (reused, like dev:all). Output goes to `main-session.log` in `PI_DESKTOP_LOG_DIR` (the app log
  dir beside `server.log`, passed by `src-tauri/src/lib.rs`), else to the server's own output. No
  orphan: on Unix the child shares the server's process group, which the shell SIGTERMs on quit;
  on every platform it holds an IPC channel to the server and `server.mjs` stops when that
  channel closes (server crash or SIGKILL, `taskkill`, the launcher's parent watchdog). A failed
  start is logged to `server.log` and the UI just shows offline. `scripts/stage-main-session.mjs`
  (from `desktop:prepare`) stages the runtime files (no tests or fixtures) at
  `resources/server/main-session/` — outside `node_modules`, where Node does not strip types —
  plus the files they import from outside the folder (`lib/exact-system-prompt.ts`, with a
  `lib/package.json` marking it ESM) and the closure of their bare imports (`typebox`; the Pi
  scope is already overlaid). A new runtime import is picked up automatically, but a new
  *computed* path is not. `scripts/verify-packaged-main-session.mjs` (part of `desktop:verify`)
  imports the lazily loaded modules from the staged tree, starts the staged server on free ports
  with a temp HOME and checks `/api/main-session/health` through the proxy and that the service
  exits when the server is SIGKILLed.
- No build step: the modules are `.ts` with explicit `.ts` imports, run by Node's native type
  stripping (Node ≥ 22.18). `main-session/package.json` marks the folder as ESM. Keep to
  strippable TypeScript (no enums, namespaces or parameter properties) and keep the `.ts`
  extensions on relative imports.
- The Next app only proxies: `app/api/main-session/[...path]/route.ts` forwards method, query,
  `content-type`/`accept` and body, and streams the response back (SSE included). Writes go
  through the same `isApiRequestAllowed` / JSON content-type guard as the other write routes.
  Service down → GET `/health` answers `200 {ok: false, running: false}` (the UI's probe), every
  other path `503 {error, running: false}`.
- Env: `MAIN_SESSION_DIR` (state dir), `MAIN_SESSION_MODEL` (`provider/modelId`; overrides and locks the
  choice made in the UI; a value without a provider refuses to start; unset by default),
  `MAIN_SESSION_JUDGE=off` (no model turns, the deterministic parts still run),
  `MAIN_SESSION_DISPATCH=off`, `MAIN_SESSION_TICK=HH:MM` (09:00),
  `MAIN_SESSION_FIXTURE=<file>` (seed an empty state dir, e.g. `main-session/fixtures/demo-state.json`),
  `MEMHANA_URL` / `MEMHANA_BANK` / `MAIN_SESSION_MEMHANA=off`, `MAIN_SESSION_TICKET_PREFIXES`.

## Settings › Main session (off by default)
The Settings dialog has a 主会话 / Main session tab (`components/main-session/MainSessionSettingsSection.tsx`).
Its three settings live in Pi Web's settings file under `mainSession`
(`<agentDir>/pi-web/settings.json`, read with `lib/main-session-settings.ts`, written by
`GET/PUT /api/main-session-settings` — not under `/api/main-session/`, which proxies to the
service, so they save while the service is down). Both processes read the file on every use, so a
change applies without a restart.
- `enabled` (default **false**): the whole feature. Off: the close-out extension writes no
  close-outs (`defaultEnabled()`), the service keeps its state but its loop does nothing (no
  checks, archives or digest; a missed tick runs once turned on), no judgment turns run
  (`Judge`'s `on`), dispatches and answer forwarding stop, the app's stream client drops
  `insert` / `continue` events and holds the close-out outbox, and the UI hides the sidebar row, 需要你 and the digest
  notification; `?view=main` shows a "turned off" notice with a link to the tab. The model
  picker shows only while it is on. `PI_WEB_DISABLE_MAIN_SESSION` still turns everything off.
- `autoContinue` (default **false**): the main session's own `continue` steps. Off: the judge
  is not offered the `continue` tool (its input says so), `continueSession({origin: "main"})`
  refuses, and the app refuses a `continue` event with `origin: "main"`. The user's own
  answers (`origin: "user"`) still go to the work session.
- `takeoverMinutes` (default 5; the tab offers 1–60): the idle delay after a run before the
  session's close-out goes to the service, read when each run settles.

`startServer()` passes the file reader; a `MainSessionService` built without `settings` (tests,
replay) has everything on. `/health` reports `settings: {enabled, autoContinue}`.

## Model choice (no default)
- The model for judgment turns and read-only dispatches is the user's: there is no built-in default
  and no provider allowlist. Until one is chosen the service runs **no model turns**: triggers are
  dropped (`Judge.available` is false), `/chat` answers from the store, and a dispatch finishes at
  once with "no model is chosen…" as its result; intake, digest, checkers, schedules and the archive
  rule are deterministic and keep working.
- Chosen in the UI with `components/main-session/MainSessionModelPicker.tsx` (an `AppSelect`):
  under the band of the 主会话 page with a notice while none is chosen or the last turn failed, in
  the band once one is, and in Settings › Main session (`MainSessionSettingsSection.tsx`). It lists `GET /api/models?cwd=<chat workspace>`'s `modelList` (the home folder the turns run in is not on the file-access allow-list, so the route refuses it; the chat workspace is an allowed root with the same global model scope) — the
  same enabledModels-scoped set the composer offers, for the folder the turns run in — plus "none".
- `POST /model {model: "provider/modelId" | null}` (through the proxy and its write guards) checks
  the ref against the Pi registry (`checkConfiguredModel()`: the model exists and
  `getAvailable(provider)` lists it, i.e. the provider is signed in; offline runtime, no extensions)
  and saves it in `settings.json` in the state dir. The service holds it in memory, so the next turn
  uses it without a restart; a restart reads it back. 409 while `MAIN_SESSION_MODEL` is set; 400
  with the reason for a malformed or unusable ref. Saving clears `judge.lastError`.
- The reasoning level (`POST /model {thinkingLevel}`, "off" by default, kept when the model
  changes) is picked beside the model with `MainSessionThinkingPicker`, from the levels
  `/api/models` reports for the chosen model (`thinkingLevels`), all of them when it reports none.
  It is not validated against the model at save time; an unsupported level is the SDK's to clamp.
- Every turn resolves the ref again through the session services' `modelRuntime.getModel()`
  (`lookupModel()`); a model that has since left models.json or the catalog fails the turn with
  "… is not configured in Pi any more …; choose another model", which `/health` reports as
  `judge.lastError` and the page shows with the picker. The service loads no extensions, so a
  provider only an extension registers cannot be used (the save is refused).

## State (`~/.pi/agent/main/`, `store.ts`)
`tasks.json` (`{version: 1, tasks}`, atomic write), `events.jsonl` (append-only; an event that
changes later, such as an ask being answered, is appended again with the same id and the last copy
wins on load), `closeouts/<sessionId>.json` (every close-out of the session, revisions included),
`schedules.json`, `seen.json`, `state.json` (launch time, last tick day, last network check),
`settings.json` (`{model, modelSetAt, thinkingLevel?}`, the user's model and reasoning choices), `chat.jsonl`, `memory-outbox.jsonl`. A `Store(null)` keeps all of it in memory (tests, replay).

## Pieces
- `intake.ts` — POST /closeouts. Deterministic so a close-out is never lost when the model is down:
  assign through the alias table (`aliases.ts`), replace stands/next/open with the newest
  close-out, merge waits (keeping the original `since`), add artifacts, branch, repo (= the
  close-out's cwd), P1 flag; **one** ask per close-out from its open questions to the user (a P1
  or production one first, then a write, then an either/or, else the first; `others` counts the
  rest, which stay in `task.open`; an earlier close-out's ask that is no longer the one raised is
  cancelled); `user_said` and `learned` to memory. Idempotency key = the close-out `id` when present (the extension's outbox replays it),
  else `sessionId@t`. Same key and same content → the first result; same key, changed content
  (the card's "交接" button) → applied again with `revisionOf`.
- `aliases.ts` — strong ids (tickets, labelled org/group guids, branches) match on their own; a
  bare PR number only counts inside the same repository and never alone. Order: the task that
  already holds the session, the declared thread, then shared ids (ticket/guid 3, branch 2, PR 1;
  ties to the most recently updated, reported as `ties`). A declared ticket nobody tracks is a
  new task even if a related tracked ticket is mentioned. A related ticket another task already
  owns is never added as an alias.
- `actions.ts` — the ten actions plus answer/undo. Every call writes one event with `why`.
  `archive` from the judge is a suggestion (`state: pending`, `effectiveAt` +48 h);
  `processPendingArchives` applies it unless the task saw activity since (cancelled), has unpushed
  commits or is P1 (blocked). Answers: archive words archive (all tasks of a batched archive ask),
  keep words cancel suggestions, done words tick the step the ask was about, snooze words leave it
  for the re-raise rule, "派人查" starts a read-only dispatch, anything else is recorded — as an
  `approval` when the ask was a write — and passed on to the task's work session (see "Continue").
  The service itself runs nothing on the user's behalf. Undo works for answers and immediate
  archives for 5 minutes and restores the saved task snapshots. A failed read-only check raises
  its immediate ask with the finding (`failureFinding()`), not with the step it was given.
- `digest.ts` — the rules live in code; the model can only reword. Max 5 lines, one per task.
  Order: immediate > post-merge/deploy verification > fresh (see Deviations) > waits on a person
  on the third calendar day without change, or past their `until` > read-only results of the
  last 24 h > archive suggestions (one batched line) > backlog (fills the launch digest, ≤ 2 a day
  after). A line already shown or answered comes back only when its task changed since, or after
  five working days. Every `need`/`archive` line has an ask event to answer.
- `checkers/` — `branch` (`git ls-remote --heads origin <b>` in the task's repo), `pr`
  (`gh pr view … --json state,mergedAt,reviewDecision,statusCheckRollup`), `date` (due waits and
  `on: date …` steps), `manual` (schedules). `execFile`, never a shell; a failing command reports
  nothing. Parsers are pure and tested on fixtures in `main-session/fixtures/`. A merged PR closes
  the task's `pr` waits and is not polled again.
- `service.ts` — a 60 s loop: pending archives, schedules and date checks every minute, git/gh
  every 10 minutes, the daily tick once per day after 09:00 (a missed tick runs on the first loop
  after start). Checker changes, close-outs, dispatch results and the tick each start a judgment
  turn.
- `judge.ts` + `prompts/judge.md` — one turn at a time. Input: the event, the involved tasks in
  full (with open asks and recent events), a board of tasks active in 30 days with last-activity
  dates, and what the service already did. Tools: exactly the ten actions; tool errors are
  returned to the model as text. `digest` is refused outside the daily tick.
- `pi-runtime.ts` — Pi SDK sessions outside the Next registry: no extensions, skills or context
  files; exact system prompt through `lib/exact-system-prompt.ts` (do not add another path);
  the reasoning level is the chosen one (`settings.thinkingLevel`, default off); the model is the
  chosen `provider/modelId`, resolved through the registry on every turn (see "Model choice").
  `onText` receives assistant text deltas (the SDK's `message_update` / `text_delta` events) for
  live display of chat replies.
- `dispatch.ts` + `readonly-guard.ts` — read-only sessions get `read, grep, find, ls, bash`; a
  `tool_call` hook checks every bash command: one simple command, no shell operators outside
  quotes (and no `$`, backtick or backslash inside double quotes), only `git log/show/status/diff/ls-remote`
  (no `--output`, `--ext-diff`, `--textconv`), `gh pr view/checks/list`, `curl -s` GET without
  body/output flags, `wisp` SELECT without write keywords. Refusals are blocked, told to the
  model, and listed in the result event. The answer starts with PASS/FAIL/UNKNOWN; FAIL raises an
  immediate ask. Dispatched sessions are persisted so "替你做了" can link to them.
- `chat.ts` — "提醒我…" → schedule (`parseWhen`: 明天/后天/N天后/N小时后/周X/下周X/M月D日/ISO,
  上午/下午/晚上 and H点/H:MM; default tomorrow 09:00), "以后…" → remember, otherwise the judge
  answers (fallback: from the store). A chat turn carries the stored conversation before it
  (`RECENT_CHAT_TURNS` = 10 messages): the judge input gets a "Recent conversation" section and
  the tasks the recent replies cited are given in full, so a follow-up ("那下一步呢") resolves;
  "提醒我…" without a ticket targets the task the last reply cited. The reply streams to
  `/stream` as `chat` events (`{t, delta}`, `t` = the user message's time) while it is produced;
  the HTTP response carries the final text.
- `view.ts` — derived row fields for the UI: `task.ask` (open ask: eventId, short, text, why,
  ifNot, chips, at, immediate, source), `task.last` (latest automatic action), `task.answered`.
  Computed on every response and `task` stream event, never stored.
- `replay.ts` — POST /replay; see below.

## Continue: work goes on in the task's session
The main session's job is to move work forward, not to restate it. `continueSession()`
(`actions.ts`; the judge's `continue` tool, and `MainSessionService.answer()` for the user's own
answers) emits a `continue` stream event `{eventId, task, text, origin, sessionId?, cwd?}`. The
app server listens (`lib/main-session-insert-client.ts`) and `continueFromMainSession()`
(`lib/rpc-manager.ts`) sends the text as a prompt into the task's latest session (reopened when
it is not live; a follow-up when it is running), or starts a session in the task's repo when it
has none, then reports back with `POST /continues/:eventId/delivered {sessionId | error}`.

- `origin: "main"` (the judge chose the step; only with Settings › Main session's automatic continue on): the prompt is prefixed `[主会话续做] ` and carries
  `mainSession: true`, which turns the **write gate** on for that session. The service refuses
  the same step twice for a task (`key` = hash of the text) and more than
  `CONTINUE_DAILY_CAP` (3) a day per task; the judge sees the refusal as text.
- `origin: "user"` (an answer that is not one of the service's own words): prefixed `[主会话] `,
  not gated, not limited. It is sent `ANSWER_FORWARD_DELAY_MS` (6 s) after the answer, so an
  answer undone in the UI's 5 second window never reaches the session.
- Delivery is at-most-once: with no app server on the stream the event is lost, and the
  `continue` event never gets `deliveredAt`.

### The write gate (`lib/main-session-gate.ts`)
Registered on every project session, inert unless the wrapper's `mainSessionGate.gated` is true.
`AgentSessionWrapper.send()` sets it from the latest `prompt` / `steer` / `follow_up`: true only
for `mainSession: true`, false for any message of the user's — never cleared on `agent_end`, so
a retry of a gated turn stays gated. While gated, a tool call runs without asking only if it is
`read` / `grep` / `find` / `ls`; `edit` / `write` inside the session's folder (`~` and `@` paths,
odd spaces and links out of the folder count as outside); or one simple bash command the
read-only guard allows or that is on the local list (`git add/commit`, `npm test`,
`npm run test|lint|typecheck|check`, `npx tsc --noEmit`, `node --test`, `cargo test`, …; no shell
operators). Everything else — push, merge, deploy, `kubectl`, installs, sub-agents, MCP tools,
PowerShell — waits on `ctx.ui.confirm("主会话续做：需要你批准", <command>)`, which the session
shows and the task's card answers; a no (or no UI) blocks the call with the reason. It is a guard
against a well-meaning agent, not a sandbox: an allowed test command runs the repo's scripts.
Do not add a path that clears the flag on anything but a user message, and keep the list
default-deny.

## The page
- **Cards.** Need and watch rows are cards (`MainSessionRow.tsx`): id, title, a state tag, the
  full text (four lines, all of it when expanded), chips, a reply box, "打开会话". The done list
  keeps its two-line rows. `useSessionActivity()` polls `/api/agent/tasks` every 2 s and
  `cardStateOf()` picks what the task's sessions show: a waiting dialog (允许 / 拒绝 answer a
  confirm through `extension_ui_response`; other dialogs link to the session), else a run (step,
  elapsed, 停止), else a run that ended after `task.updatedAt` (its `lastRun.summary`, the last
  600 characters of the reply) — the stand-in until the close-out, which is written five idle
  minutes later, updates the task. An answer that goes on to a session (`goesToSession()`, the
  service's word lists copied verbatim and pinned by a test) keeps its card in the need list
  ("held") instead of sliding it out; so does a watch task whose session waits for an approval.
- **Open session** shows the task's existing session (`openTaskSession()`: `task.sessions[0]`)
  with a temporary card above its composer (`lib/main-session-arrival.ts`, `ArrivalCard.tsx`):
  the question, next steps, the chips, "put the background in the composer". It lives in client
  memory only and goes on send, on close, or when another session is opened. A new session is
  created only when the task has none, or from the row menu's "再开一个新会话".
- **Close-out cards in a session.** `CloseoutCard` draws nothing for an `idle` close-out (it is
  still written to the session file and posted); compaction and shutdown close-outs show theirs.
- **The conversation** holds only what the user and the main session said to each other, with
  a separator per calendar day. The digest is not posted into it (it restates the list above);
  it still drives the daily notification.

## HTTP (service; the UI calls the same paths under `/api/main-session`)
| | |
|---|---|
| GET `/health` | `{ok, since, version, model: {ref, source, setAt?, thinkingLevel}, judge: {enabled, available, turns, lastError?}}`; `ref` null = no model chosen, `source` `env` \| `settings` |
| GET `/model` / POST `/model` | `{ref, source, setAt?, thinkingLevel}` / `{model?: "provider/modelId" \| null, thinkingLevel?: off…max}` → the same; see "Model choice" |
| GET `/tasks?status=need,watch` | `{tasks: TaskView[], seen, newSince: {need, watch, done}}` (default need+watch+done) |
| GET `/tasks/:id` | `{task, events, closeouts, openAsks, contextPack}` (id URL-encoded; aliases work) |
| POST `/tasks/:id/answer` | `{word, eventId?}` → `{task, event}`; without eventId answers the oldest open ask |
| POST `/tasks/:id/archive` | `{why?}` → `{task, event?}`; archiving an archived task is a no-op |
| POST `/tasks/:id/undo` | `{eventId}` → `{task}`; 409 after 5 minutes |
| POST `/closeouts` | Closeout (+ `id`, `trigger`) → 201 `{task\|null, event}`; repeat → 200 `{…, duplicate: true}` |
| POST `/seen` | `{segment}` → `{seen}` |
| GET `/digest?date=` | `{date, lines, narrative, eventId}`; today before the tick time → `{lines: [], pending: true}` |
| POST `/chat` / GET `/chat` | `{text}` → `{reply, cites, actions}` / `{messages}` |
| GET `/events?since=` | `{events}` |
| GET `/stream` | SSE `hello`, `task` ({task: TaskView}), `digest`, `insert` ({sessionId, text, task, eventId}), `continue` ({eventId, task, text, origin, sessionId?, cwd?}), `event`, `chat` ({t, delta}: a reply being produced) |
| POST `/sessions/:id/started` | `{task}` → `{ok, task, event}` |
| POST `/continues/:eventId/delivered` | `{sessionId?, error?}` → `{ok, event}`; a newly started session joins the task |
| POST `/replay` | see below |

Errors are `{error}` with 4xx/5xx. The `insert` text has no prefix; the close-out extension adds
`[主会话提醒] ` when it injects it.

## Replay
`POST /replay {items, events?, from?, to?, tickHourUtc?, derivePickups?}` runs a throwaway
in-memory store day by day (UTC days, tick 13:00Z ≈ 09:00 ET), no model. Items are rows of
`mine-dropped-followups/items.json` or `pickups.json` (`t0`, or `t`, or `date`). Mapping: PR → wait
on the PR (closed by its merge, never a line); deploy → verification step, due after a merge on
the task, else owed now; person → wait on the user when the text names the user, else on a third
party; date → wait until the date in the text; other → verification when it reads like one, else a
third-party wait. Events: `pr_merged`, `pickup` (resolves the item), `activity`. PR states with
`mergedAt` inside an item become merge events. `pickup_ts` from pickups.json is ignored unless
`derivePickups: true`: it is the miner's automatic guess and verdicts.json overrules it for most
dropped items. Output: `digests`, `asks`, `surfaced[itemId] = {date, category, lagDays,
lagFromEventDays}` (event = the merge for post-merge verifications, the date for date waits,
else t0), and a summary.

Result on the 70 real items (pickups.json, t0 from it): all 17 dropped items surface within 3
days of their event (C09/C11 count from their task's merge: 9 and 4 days after t0), never more
than 5 lines a day over 154 days.

## Deviations from the contract
- **"fresh" digest slot.** Things the user owes that appeared since the last digest rank after
  post-merge verification and before waits; older ones are backlog. With the contract's order
  alone, user-owed items arriving on a busy day (C25, S15, S16) sat behind third-party waits for
  4–5 days (replay: 14/17 within 3 days instead of 17/17).
- **"等人 >3 天"** is measured in calendar days: a wait from Monday surfaces on Thursday's digest.
- **`npm run dev` is unchanged**; `npm run dev:all` starts both. `lib/browser-open.test.mjs`
  pins `scripts.dev` and Tauri's `beforeDevCommand` runs it.
- Additive fields: `Task.priority`, `Task.checks`, `Closeout.id/trigger`, `DigestLine.tasks`
  (batched archive line), `newSince` on GET /tasks, `openAsks`/`contextPack` on GET /tasks/:id,
  `GET /chat`, derived `task.ask/last/answered`.
- `Task.repo` holds the close-out's cwd (a path), which is what the checkers and "开会话" need.
- Date-due waits share the "waiting" slot; reminders the user set fire as immediate asks, the
  judge's go to the digest.
