import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createJiti } from "jiti";
import { chromium } from "playwright";

// The main-session UI (docs/proposals/2026-11-06-main-session-v1.md §6, §7) against a
// stub service that speaks the HTTP contract from the fixture backend. No model calls,
// no pi sessions: /api/agent/new is recorded, not executed.
const out = "test-results/main-session";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["e2e/main-session.fixture.jsx"], bundle: true, platform: "browser", format: "iife",
  outfile: `${out}/fixture.js`, jsx: "automatic", logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_MAIN_SESSION_FIXTURE": '"0"' },
});
const js = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"].map((p) => readFile(p, "utf8"))))
  .map((text) => text.replace(/^@import[^;]*;/gm, "")).join("\n");
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const { createFixtureBackend } = await jiti.import("../lib/main-session-fixture.ts");

const E2E_MODELS = [
  { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { provider: "openai-codex", id: "gpt-6", name: "GPT-6" },
];
let backend = createFixtureBackend();
let serviceDown = false;
const agentRequests = [];
const closeouts = [];
const body = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (chunk) => { data += chunk; });
  req.on("end", () => resolve(data ? JSON.parse(data) : {}));
});
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

async function service(req, res, path, query) {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const send = (value) => json(res, 200, value);
  if (req.method === "GET" && path === "/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(": open\n\n");
    return;
  }
  // The proxy's answer while the service is unreachable (contract §1: no errors).
  if (serviceDown) return path === "/health" ? send({ ok: false }) : json(res, 503, { error: "main session not running" });
  if (req.method === "GET" && path === "/health") return send(await backend.health());
  if (req.method === "GET" && path === "/tasks") return send(await backend.listTasks(query.get("status")));
  if (req.method === "GET" && parts[0] === "tasks" && parts.length === 2) return send(await backend.getTask(parts[1]));
  if (req.method === "GET" && path === "/digest") return send(await backend.digest(query.get("date") ?? undefined));
  const payload = req.method === "POST" ? await body(req) : {};
  if (parts[0] === "tasks" && parts[2] === "answer") return send(await backend.answer(parts[1], payload.word, payload.eventId));
  if (parts[0] === "tasks" && parts[2] === "archive") return send(await backend.archive(parts[1]));
  if (parts[0] === "tasks" && parts[2] === "undo") return send(await backend.undo(parts[1], payload.eventId));
  if (path === "/seen") return send(await backend.seen(payload.segment));
  if (path === "/model") return send(await backend.setModel(payload.model ?? null));
  if (path === "/chat") return send(req.method === "GET" ? await backend.chatHistory() : await backend.chat(payload.text));
  if (parts[0] === "sessions" && parts[2] === "started") return send(await backend.sessionStarted(parts[1], payload.task) ?? {});
  if (path === "/closeouts") {
    closeouts.push(payload);
    return send(await backend.postCloseout(payload));
  }
  return json(res, 404, { error: `no route ${req.method} ${path}` });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/__reset") {
      backend = createFixtureBackend(url.searchParams.has("nomodel") ? { model: null } : {});
      serviceDown = url.searchParams.has("down");
      agentRequests.length = 0;
      closeouts.length = 0;
      return json(res, 200, {});
    }
    if (url.pathname.startsWith("/api/main-session")) return await service(req, res, url.pathname.slice("/api/main-session".length) || "/", url.searchParams);
    if (url.pathname === "/api/agent/new") {
      agentRequests.push(await body(req));
      return json(res, 200, { success: true, sessionId: "e2e-session" });
    }
    // The main session's model picker lists the models the app offers, scoped by the chat
    // workspace folder (an allowed root; the home folder itself is refused by /api/models).
    if (url.pathname === "/api/chat-workspace") return json(res, 200, { cwd: "/home/e2e/.pi/agent/chat-workspace" });
    if (url.pathname === "/api/models") return json(res, 200, { modelList: E2E_MODELS });
    if (url.pathname.startsWith("/api/")) return json(res, 200, {});
    res.setHeader("Content-Type", url.pathname === "/fixture.js" ? "text/javascript" : "text/html; charset=utf-8");
    res.end(url.pathname === "/fixture.js" ? js : `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
      html,body,#root{margin:0;width:100%;height:100%}button{font:inherit}</style>
      <script>document.documentElement.classList.toggle("dark",localStorage.getItem("pi-theme")==="dark");</script></head>
      <body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  } catch (error) {
    json(res, error.status ?? 500, { error: error.message });
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });

async function open({ theme = "light", locale = "zh-CN", width = 1280, height = 820, search = "", down = false, noModel = false } = {}) {
  await fetch(`${base}/__reset${down ? "?down" : noModel ? "?nomodel" : ""}`);
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.addInitScript(({ theme, locale }) => {
    if (!sessionStorage.getItem("e2e-init")) {
      localStorage.clear();
      localStorage.setItem("pi-locale", locale);
      localStorage.setItem("pi-theme", theme);
      sessionStorage.setItem("e2e-init", "1");
    }
  }, { theme, locale });
  await page.goto(`${base}/${search}`);
  return { page, errors };
}

const segmentCount = (page, segment) => page.locator(`.ms-segment--${segment} .ms-segment-count`).textContent();
const row = (page, id) => page.locator(`.ms-row[data-row-id="${id}"]`);

try {
  // 1. Sidebar → main page → answer → counts change → undo. A decision goes on to the task's
  //    session, so its card stays to show what comes of it; a snooze is the service's own and
  //    slides its row out.
  {
    const { page, errors } = await open({ search: "?view=session" });
    const section = page.locator(".ms-sidebar-section");
    await section.waitFor();
    assert.equal((await section.locator(".ms-sidebar-count").textContent()).trim(), "14");
    assert.equal(await section.locator(".ms-sidebar-row").count(), 14, "outside the page the group lists every open question");

    await page.locator(".sidebar-main-session-row").click();
    await page.locator(".main-session-view .ms-row").first().waitFor();
    assert.equal(await section.locator(".ms-sidebar-row").count(), 0, "on the page the group folds to its header");
    assert.equal(await page.locator(".sidebar-main-session-dot").count(), 1, "unread dot while new items need the user");
    assert.deepEqual([await segmentCount(page, "need"), await segmentCount(page, "watch"), await segmentCount(page, "done")], ["14", "3", "17"]);
    await page.screenshot({ path: `${out}/main-light-1280.png` });

    // Cards: the task's title, the whole question, a reply box where there is a session.
    const card = row(page, "CAS-4764");
    assert.match(await card.getAttribute("class"), /\bms-card\b/);
    assert.equal(await card.locator(".ms-card-title").textContent(), "P1 PCT-121470 根因修复");
    assert.match(await card.locator(".ms-card-text").textContent(), /^a58e342 在本地分支 .*推还是放弃？$/);
    assert.equal(await card.locator(".ms-card-state").textContent(), "等你");
    assert.equal(await card.locator(".ms-reply input").getAttribute("placeholder"), "回复这个会话…");

    await card.getByRole("button", { name: "推", exact: true }).click();
    const undo = page.locator(".ms-undo");
    await undo.waitFor();
    assert.equal(await segmentCount(page, "need"), "13");
    assert.equal(await segmentCount(page, "watch"), "4");
    assert.match(await undo.textContent(), /CAS-4764 回「推」→ 移到在盯的/);
    assert.equal(await card.count(), 1, "a decision keeps its card in the list");
    assert.equal(await card.locator(".ms-card-state").textContent(), "在盯");
    assert.equal(await card.locator(".ms-answered").textContent(), "已转给会话：推");
    assert.equal(await page.locator(".main-session-view .ms-row").first().getAttribute("data-row-id"), "CAS-4764", "held cards come first");
    assert.match(await section.locator(".ms-sidebar-last").textContent(), /刚才：CAS-4764 回「推」/);
    await page.screenshot({ path: `${out}/main-answered-undo.png` });
    await undo.getByRole("button", { name: "撤销" }).click();
    await page.waitForFunction(() => document.querySelector(".ms-segment--need .ms-segment-count")?.textContent === "14");
    assert.equal(await undo.count(), 0);
    await card.getByRole("button", { name: "知道了" }).click();
    assert.equal(await card.locator(".ms-card-state").textContent(), "等你");

    // "等" is the service's own word (snooze): nothing goes to a session, the row slides out.
    await row(page, "CAS-4766").getByRole("button", { name: "等", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.ms-row[data-row-id="CAS-4766"]'));
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.rowId), "memory:weekly", "focus moves to the next row");
    await undo.getByRole("button", { name: "撤销" }).click();
    await row(page, "CAS-4766").waitFor();
    assert.equal(await segmentCount(page, "need"), "14");

    // 2. Keyboard: j to the first row, 2 answers with its second chip (放弃 → handled), Esc clears.
    await page.locator(".ms-list-header").click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("j");
    const firstRow = await page.locator(".main-session-view .ms-row").first().getAttribute("data-row-id");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.rowId), firstRow);
    await page.keyboard.press("k");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.rowId), firstRow, "k stops at the first row");
    await row(page, "CAS-4764").locator(".ms-card-text").click();
    await page.keyboard.press("Enter");
    await row(page, "CAS-4764").locator(".ms-details").waitFor();
    await page.keyboard.press("2");
    await page.waitForFunction(() => !document.querySelector('.ms-row[data-row-id="CAS-4764"]'));
    await page.waitForFunction(() => document.querySelector(".ms-segment--done .ms-segment-count")?.textContent === "18");
    await page.locator(".ms-undo").getByRole("button", { name: "撤销" }).click();
    await row(page, "CAS-4764").waitFor();
    await row(page, "CAS-4764").locator(".ms-card-text").click();
    await page.keyboard.press("e");
    await page.waitForFunction(() => document.querySelector(".ms-segment--done .ms-segment-count")?.textContent === "18");
    await page.locator(".ms-undo").getByRole("button", { name: "撤销" }).click();
    await page.waitForFunction(() => document.querySelector(".ms-segment--need .ms-segment-count")?.textContent === "14");
    await page.keyboard.press("j");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".ms-row.is-focused").count(), 0);

    // 3. The active segment folds/unfolds the list; another segment switches.
    const needTab = page.locator(".ms-segment--need .ms-segment-main");
    await needTab.click();
    assert.equal(await page.locator("#main-session-list").count(), 0);
    assert.equal(await needTab.getAttribute("aria-expanded"), "false");
    await needTab.click();
    await page.locator("#main-session-list").waitFor();
    await page.locator(".ms-segment--done .ms-segment-main").click();
    assert.equal(await page.locator(".ms-row").count(), 17);
    await needTab.click();

    // 4. The drag handle resizes the list and the height survives a reload.
    const handle = page.locator(".ms-resizer");
    const box = await handle.boundingBox();
    const before = (await page.locator("#main-session-list").boundingBox()).height;
    await page.mouse.move(box.x + box.width / 2, box.y + 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 80, { steps: 4 });
    await page.mouse.up();
    const after = (await page.locator("#main-session-list").boundingBox()).height;
    assert.ok(Math.abs(after - (before - 83)) <= 2, `list follows the drag (${before} → ${after})`);
    const stored = await page.evaluate(() => localStorage.getItem("pi-web:main-session-list-height"));
    assert.equal(Number(stored), Math.round(after));

    // 5. The "…" menu is the shared app-menu surface; Escape closes it.
    await row(page, "PCT-120665").getByRole("button", { name: "更多" }).click();
    const menu = page.locator(".main-session-row-menu");
    await menu.waitFor();
    assert.match(await menu.getAttribute("class"), /\bapp-menu\b/);
    assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["回复自己写", "归档e", "详情Enter"]);
    const surface = await menu.evaluate((el) => getComputedStyle(el).borderRadius);
    assert.equal(surface, "14px", "menu radius comes from the shared --menu-radius");
    await page.screenshot({ path: `${out}/main-menu.png` });
    await page.keyboard.press("Escape");
    assert.equal(await menu.count(), 0);
    await row(page, "PCT-120665").getByRole("button", { name: "更多" }).click();
    await menu.getByRole("menuitem", { name: /回复/ }).click();
    await row(page, "PCT-120665").locator(".ms-reply input").fill("下周再查");
    await row(page, "PCT-120665").locator(".ms-reply input").press("Enter");
    await page.waitForFunction(() => !document.querySelector('.ms-row[data-row-id="PCT-120665"]'));
    await page.locator(".ms-undo").getByRole("button", { name: "撤销" }).click();
    await row(page, "PCT-120665").waitFor();

    // 6. Conversation: the reply cites its basis; the task link locates the row.
    await page.locator(".ms-composer-input").fill("CAS-4685 卡在哪");
    await page.locator(".ms-composer-input").press("Enter");
    const cite = page.locator(".ms-message--main .ms-cite").last();
    await cite.waitFor();
    assert.match(await cite.textContent(), /^依据：交接会话 · 任务 CAS-4685/);
    await cite.getByRole("button", { name: "任务 CAS-4685" }).click();
    await page.waitForFunction(() => document.activeElement?.dataset?.rowId === "CAS-4685");
    assert.equal(await page.evaluate(() => {
      const list = document.querySelector("#main-session-list");
      const r = document.querySelector('.ms-row[data-row-id="CAS-4685"]').getBoundingClientRect();
      const p = list.getBoundingClientRect();
      return r.top >= p.top - 1 && r.bottom <= p.bottom + 1;
    }), true, "the located row is scrolled into the list");
    const conversation = page.locator(".ms-conversation");
    assert.equal(await conversation.evaluate((el) => getComputedStyle(el).overflowY), "auto");
    await page.screenshot({ path: `${out}/main-conversation.png` });

    // 7. Open a session from a task: the context goes in the first message, the service hears of it.
    await row(page, "PCT-120665").getByRole("button", { name: "开会话", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#opened")?.textContent === "e2e-session");
    assert.equal(agentRequests.length, 1);
    assert.equal(agentRequests[0].cwd, "/fixture/project");
    assert.equal(agentRequests[0].type, "prompt");
    assert.match(agentRequests[0].message, /任务 PCT-120665/);
    assert.match(agentRequests[0].message, /约好 10-29 复查 CECP Pro 续期/);
    assert.deepEqual(backend.calls.find((c) => c.method === "sessionStarted").args, ["e2e-session", "PCT-120665"]);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // 8. Inside a session: the note folds and its task opens the page; the close-out card edits and re-posts.
  {
    const { page, errors } = await open({ search: "?view=session" });
    const note = page.locator(".ms-note");
    await note.waitFor();
    await page.locator(".ms-closeout").waitFor();
    await page.screenshot({ path: `${out}/session-entries-light.png` });
    await note.locator(".ms-note-head").click();
    assert.equal(await note.locator(".ms-note-body").count(), 0);
    await note.locator(".ms-note-head").click();
    const stands = page.locator('.ms-closeout textarea[aria-label="stands"]');
    assert.equal(await stands.inputValue(), "PR #<n> 开到 dev，未合。");
    await stands.fill("PR #12 已合进 dev。");
    await page.locator(".ms-closeout").getByRole("button", { name: "交接" }).click();
    await page.locator(".ms-closeout").getByText("已交接").waitFor();
    assert.equal(closeouts.length, 1);
    assert.equal(closeouts[0].stands, "PR #12 已合进 dev。");
    assert.equal(closeouts[0].id, "co-cas-1", "the re-post carries the close-out id, so it revises that close-out");
    assert.equal(closeouts[0].trigger, "idle");
    assert.deepEqual(closeouts[0].learned[0].anchors, [{ path: "dao/entitlement.js" }], "structured parts survive the edit");
    // Sidebar row actions: reply with a word from the 需要你 group.
    const item = page.locator(".ms-sidebar-item").filter({ hasText: "CAS-4766" });
    await item.hover();
    await item.getByRole("button", { name: "回复" }).click();
    await item.locator(".ms-sidebar-reply").getByRole("button", { name: "等", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ms-sidebar-count")?.textContent === "13");
    await note.getByRole("button", { name: "任务 CAS-4764 ›" }).click();
    await page.waitForFunction(() => document.activeElement?.dataset?.rowId === "CAS-4764");
    assert.deepEqual(errors, []);
    await page.close();
  }

  // 9. Service down: one quiet probe, "not running", no needs-you group, no failed requests.
  {
    const { page, errors } = await open({ down: true });
    await page.locator(".ms-offline").waitFor();
    assert.match(await page.locator(".ms-offline").textContent(), /主会话未运行/);
    assert.equal(await page.locator(".ms-sidebar-section").count(), 0);
    assert.equal(await page.locator(".sidebar-main-session-row").count(), 1, "the pinned row stays so the page is reachable");
    await page.screenshot({ path: `${out}/main-offline.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }

  // 9b. No model chosen: a notice with the picker; choosing one moves the picker into the band.
  {
    const { page, errors } = await open({ noModel: true });
    await page.locator(".ms-model-bar").waitFor();
    assert.match(await page.locator(".ms-model-bar-text").textContent(), /给主会话选一个模型/);
    assert.equal(await page.locator(".ms-band .ms-model").count(), 0);
    await page.screenshot({ path: `${out}/main-needs-model.png` });
    await page.locator(".ms-model-bar .ms-model-select").click();
    await page.getByRole("option", { name: "GPT-6 · openai-codex" }).click();
    await page.locator(".ms-band .ms-model").waitFor();
    assert.equal(await page.locator(".ms-model-bar").count(), 0);
    assert.match(await page.locator(".ms-band .ms-model-select").textContent(), /GPT-6/);
    assert.deepEqual(backend.calls.filter((c) => c.method === "setModel").map((c) => c.args[0]), ["openai-codex/gpt-6"]);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // 10. Dark theme, English, and a narrow window keep the layout.
  for (const variant of [
    { theme: "dark", locale: "zh-CN", width: 1280, name: "main-dark-1280" },
    { theme: "light", locale: "en", width: 1100, name: "main-light-en-1100" },
    { theme: "light", locale: "zh-CN", width: 720, height: 760, name: "main-light-720" },
  ]) {
    const { page, errors } = await open({ ...variant, search: "" });
    await page.locator(".main-session-view .ms-row").first().waitFor();
    const overflow = await page.evaluate(() => {
      const view = document.querySelector(".main-session-view");
      return [...view.querySelectorAll(".ms-row")].some((el) => el.getBoundingClientRect().right > view.getBoundingClientRect().right + 1);
    });
    assert.equal(overflow, false, `${variant.name}: rows stay inside the column`);
    assert.match(await page.locator(".ms-segment--need .ms-since").textContent(), /\+7/, `${variant.name}: opened directly, the page still counts what is new`);
    if (variant.locale === "en") assert.equal(await page.locator(".ms-segment--need .ms-segment-main span").first().textContent(), "Needs me");
    await page.screenshot({ path: `${out}/${variant.name}.png` });
    if (variant.theme === "dark") {
      await page.locator(".sidebar-header-row").filter({ hasText: "PCT-121470" }).click();
      await page.locator(".ms-closeout").waitFor();
      await page.screenshot({ path: `${out}/session-entries-dark.png` });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`main-session e2e passed; screenshots in ${out}/`);
} finally {
  await browser.close();
  server.closeAllConnections?.();
  server.close();
}
