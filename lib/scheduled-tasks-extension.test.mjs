import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createScheduledTasksExtension } = await jiti.import("./scheduled-tasks-extension.ts");
const { executeScheduleAction, parseScheduleCommand, resolveTask } = await jiti.import("./scheduled-tasks/manage.ts");
const store = await jiti.import("./scheduled-tasks/store.ts");

function setup(t, { entries = [], hasUI = true, answer = true } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-sched-ext-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-sched-cwd-"));
  t.after(() => { rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });
  const events = [];
  const runs = [];
  const notices = [];
  const asked = [];
  const sentMessages = [];
  const tools = new Map();
  const commands = new Map();
  const extension = createScheduledTasksExtension({
    agentDir,
    emit: (event) => events.push(event),
    runTask: async (taskId) => { runs.push(taskId); return { runId: "r", taskId, sessionId: "s-1", status: "running", trigger: "manual" }; },
  });
  extension.factory({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, options) => commands.set(name, options),
    sendUserMessage: (content) => sentMessages.push(content),
  });
  const ctx = {
    cwd,
    hasUI,
    sessionManager: { getEntries: () => entries },
    ui: {
      confirm: async (title, message) => { asked.push({ title, message }); return answer; },
      notify: (message, type) => notices.push({ message, type }),
    },
  };
  const call = async (params) => tools.get("scheduled_tasks").execute("id", params, undefined, undefined, ctx);
  const command = (args) => commands.get("schedule").handler(args, ctx);
  return { agentDir, cwd, events, runs, notices, asked, sentMessages, tools, commands, call, command };
}

const daily = { kind: "cron", expr: "0 9 * * *", timezone: "UTC" };
const text = (result) => result.content[0].text;

test("the extension registers the tool and the command", (t) => {
  const { tools, commands } = setup(t);
  assert.deepEqual([...tools.keys()], ["scheduled_tasks"]);
  assert.equal(tools.get("scheduled_tasks").exposure, "model-only");
  assert.deepEqual([...commands.keys()], ["schedule"]);
});

test("create validates like the API, defaults to the session directory and the default tools, and announces the change", async (t) => {
  const { call, cwd, agentDir, events, asked } = setup(t);
  const result = await call({ action: "create", name: "Morning digest", prompt: "Summarize the repo", schedule: daily });
  assert.equal(result.isError, undefined);
  const [task] = store.listTasks(agentDir);
  assert.equal(task.cwd, cwd);
  assert.equal(task.toolPreset, "default");
  assert.equal(asked.length, 1, "the default preset can write, so the user is asked");
  assert.deepEqual(events, [{ type: "task_changed", taskId: task.id }]);
  assert.match(text(result), /Morning digest/);
  assert.match(text(result), /next run/);

  const bad = await call({ action: "create", name: "Too often", prompt: "p", schedule: { kind: "cron", expr: "* * * * *", timezone: "UTC" } });
  assert.equal(bad.isError, true);
  const duplicate = await call({ action: "create", name: "morning digest", prompt: "p", schedule: daily });
  assert.equal(duplicate.isError, true);
  assert.equal(store.listTasks(agentDir).length, 1);
});

test("a preset that can write needs the user's approval", async (t) => {
  const denied = setup(t, { answer: false });
  const refused = await denied.call({ action: "create", name: "w", prompt: "p", schedule: daily, toolPreset: "full" });
  assert.equal(refused.isError, true);
  assert.equal(denied.asked.length, 1);
  assert.deepEqual(store.listTasks(denied.agentDir), []);

  const noUi = setup(t, { hasUI: false });
  assert.equal((await noUi.call({ action: "create", name: "w", prompt: "p", schedule: daily, toolPreset: "default" })).isError, true);

  const readOnly = setup(t, { answer: false });
  assert.equal((await readOnly.call({ action: "create", name: "r", prompt: "p", schedule: daily, toolPreset: "read-only" })).isError, undefined);
  assert.equal(readOnly.asked.length, 0, "read-only needs no approval");

  const allowed = setup(t);
  const created = await allowed.call({ action: "create", name: "w", prompt: "p", schedule: daily, toolPreset: "full" });
  assert.equal(created.isError, undefined);
  assert.equal(store.listTasks(allowed.agentDir)[0].toolPreset, "full");
});

test("update, pause, resume and run find the task by name", async (t) => {
  const { call, agentDir, runs } = setup(t);
  await call({ action: "create", name: "Weekly report", prompt: "p", schedule: daily });
  const id = store.listTasks(agentDir)[0].id;

  assert.equal((await call({ action: "update", task: "weekly", maxDurationMin: 10 })).isError, undefined);
  assert.equal(store.getTask(id, agentDir).maxDurationMin, 10);
  assert.equal((await call({ action: "update", task: "weekly" })).isError, true);

  await call({ action: "pause", task: "Weekly report" });
  assert.equal(store.getTask(id, agentDir).enabled, false);
  await call({ action: "resume", task: id });
  assert.equal(store.getTask(id, agentDir).enabled, true);

  assert.match(text(await call({ action: "run", task: "weekly" })), /Started "Weekly report" in session s-1/);
  assert.deepEqual(runs, [id]);
  assert.equal((await call({ action: "run", task: "nothing-like-it" })).isError, true);
});

test("delete asks first and removes the task", async (t) => {
  const no = setup(t, { answer: false });
  await no.call({ action: "create", name: "Temp", prompt: "p", schedule: daily, toolPreset: "read-only" });
  assert.equal((await no.call({ action: "delete", task: "Temp" })).isError, true);
  assert.equal(store.listTasks(no.agentDir).length, 1);

  const yes = setup(t);
  await yes.call({ action: "create", name: "Temp", prompt: "p", schedule: daily });
  assert.match(text(await yes.call({ action: "delete", task: "Temp" })), /Deleted "Temp"/);
  assert.deepEqual(store.listTasks(yes.agentDir), []);
});

test("list, get and runs are read-only and work without a UI", async (t) => {
  const { call } = setup(t, { hasUI: false });
  assert.equal(text(await call({ action: "list" })), "No scheduled tasks.");
  assert.equal((await call({ action: "get", task: "x" })).isError, true);
});

test("a read-only session can look at tasks but not change them", async (t) => {
  const entries = [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools: ["read", "grep"] } }];
  const { call, command, notices, agentDir } = setup(t, { entries });
  assert.equal((await call({ action: "list" })).isError, undefined);
  const blocked = await call({ action: "create", name: "x", prompt: "p", schedule: daily });
  assert.equal(blocked.isError, true);
  assert.match(text(blocked), /read-only/);
  await command("pause something");
  assert.equal(notices.at(-1).type, "warning");
  assert.deepEqual(store.listTasks(agentDir), []);
});

test("a scheduled run cannot change tasks", async (t) => {
  const entries = [{ type: "custom", customType: "pi-web:scheduled-run", data: { version: 1, taskId: "t", runId: "r" } }];
  const { call } = setup(t, { entries });
  const result = await call({ action: "create", name: "Spawn", prompt: "p", schedule: daily });
  assert.equal(result.isError, true);
  assert.match(text(result), /unattended/);
  assert.equal((await call({ action: "list" })).isError, undefined);
});

test("/schedule runs quick actions itself and hands free text to the model", async (t) => {
  const { call, command, notices, sentMessages, runs, agentDir } = setup(t);
  await command("");
  assert.equal(notices.at(-1).message, "No scheduled tasks.");

  await call({ action: "create", name: "Digest", prompt: "p", schedule: daily });
  await command("list");
  assert.match(notices.at(-1).message, /Digest/);
  await command("pause digest");
  assert.equal(store.listTasks(agentDir)[0].enabled, false);
  await command("run digest");
  assert.equal(runs.length, 1);
  await command("show nope");
  assert.equal(notices.at(-1).type, "error");

  await command("help");
  assert.match(notices.at(-1).message, /\/schedule new/);

  assert.deepEqual(sentMessages, []);
  await command("new every monday at 9 summarize open issues");
  await command("remind me tomorrow to rebase");
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[0], /scheduled_tasks tool.*every monday at 9 summarize open issues$/);
  assert.doesNotMatch(sentMessages[0], /^.*new every/);
});

test("task references: id, exact name, then a part that only one task contains", () => {
  const task = (id, name) => ({ id, name });
  const tasks = [task("aaaaaaaa-0000-4000-8000-000000000001", "Daily digest"), task("bbbbbbbb-0000-4000-8000-000000000002", "Daily backup check"), task("cccccccc-0000-4000-8000-000000000003", "Release notes")];
  assert.equal(resolveTask(tasks, "cccccccc-0000-4000-8000-000000000003").name, "Release notes");
  assert.equal(resolveTask(tasks, "daily digest").name, "Daily digest");
  assert.equal(resolveTask(tasks, "backup").name, "Daily backup check");
  assert.throws(() => resolveTask(tasks, "daily"), /several tasks/);
  assert.throws(() => resolveTask(tasks, "zzz"), /No scheduled task/);
  assert.throws(() => resolveTask(tasks, " "), /task is required/);
});

test("command parsing", () => {
  assert.deepEqual(parseScheduleCommand(""), { action: "list", rest: "" });
  assert.deepEqual(parseScheduleCommand("PAUSE my task"), { action: "pause", rest: "my task" });
  assert.deepEqual(parseScheduleCommand("rm  x"), { action: "delete", rest: "x" });
  assert.deepEqual(parseScheduleCommand("new daily at 9"), { freeText: "daily at 9" });
  assert.deepEqual(parseScheduleCommand("every day"), { freeText: "every day" });
});

test("executeScheduleAction rejects an unknown action", async (t) => {
  const { agentDir } = setup(t);
  await assert.rejects(
    executeScheduleAction({ action: "explode" }, { cwd: "/", unattended: false, confirm: async () => true }, { agentDir }),
    /action must be one of/,
  );
});
