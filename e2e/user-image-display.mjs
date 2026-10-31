import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

// Real memoized MessageView, updated in place like optimistic -> SSE -> history.
// No model/API calls and no writes to the user's sessions.
const out = "test-results/user-image-display";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/user-image-display.fixture.tsx"], bundle: true, platform: "browser", format: "iife", outfile: `${out}/fixture.js`, define: { "process.env.NODE_ENV": '"production"' }, jsx: "automatic", logLevel: "warning" });
const js = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"].map((p) => readFile(p, "utf8")))).map((text) => text.replace(/^@import[^;]*;/gm, "")).join("\n");
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); res.end("{}"); return; }
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/style.css" ? "text/css" : "text/html; charset=utf-8");
  res.end(req.url === "/fixture.js" ? js : req.url === "/style.css" ? css : '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const bubble = page.locator(".message-user-bubble");
  await bubble.waitFor();
  for (const action of [null, "Deliver normalized event", "Load history"]) {
    if (action) await page.getByRole("button", { name: action, exact: true }).click();
    assert.equal((await bubble.textContent()).trim(), "describe");
    assert.equal(await bubble.locator("img").count(), 1);
  }
  const composer = page.locator("textarea").first();
  const edit = page.getByTitle("Edit from here — branches within this session", { exact: true });
  await composer.fill("existing draft");
  await edit.click({ force: true });
  assert.equal(await page.locator("#admitted").textContent(), "blocked");
  assert.equal(await composer.inputValue(), "existing draft");
  assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).count(), 0);
  await composer.fill("");
  await edit.click({ force: true });
  assert.equal(await page.locator("#admitted").textContent(), "accepted");
  assert.equal(await composer.inputValue(), "describe");
  // Cancel keeps restored input/attachments. Clearing only text must still
  // reject another restoration while the restored image remains attached.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await composer.fill("");
  await edit.click({ force: true });
  assert.equal(await page.locator("#admitted").textContent(), "blocked");
  await page.getByRole("button", { name: "Clear text and attachments", exact: true }).click();
  await edit.click({ force: true });
  assert.equal(await page.locator("#admitted").textContent(), "accepted");
  // The real clear action leaves edit mode and removes both text and images.
  await page.getByRole("button", { name: "Clear text and attachments", exact: true }).click();
  assert.equal(await composer.inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Clear text and attachments", exact: true }).count(), 0);
  await edit.click({ force: true });
  const draft = JSON.parse(await page.locator("#draft").textContent());
  assert.equal(draft.content[0].text, "describe");
  assert.equal(draft.content[1].type, "image");
  assert.match(await page.locator("#stored").textContent(), /Multiply coordinates/);
  await page.getByRole("button", { name: "Resend edit", exact: true }).click();
  assert.equal((await bubble.textContent()).trim(), "describe");
  assert.deepEqual(errors, []);
  console.log("PASS: live MessageView optimistic/delivered/history/edit/resend, attachments preserved, stored input untouched");
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
