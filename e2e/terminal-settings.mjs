import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const out = "test-results/terminal-settings";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/terminal-settings.fixture.tsx"], bundle: true, platform: "browser", jsx: "automatic",
  outfile: `${out}/fixture.js`, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
const js = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"].map(path => readFile(path, "utf8"))))
  .map(source => source.replace(/^@import[^;]*;/gm, "")).join("\n");
const server = createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    const data = req.url.startsWith("/api/chat-settings") ? { model: null, thinkingLevel: null, instructions: "", allowedTools: [], confirmSave: false, instructionsMaxChars: 8000 }
      : req.url.startsWith("/api/updates") ? { components: [], updates: [] } : {};
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); return;
  }
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/html; charset=utf-8");
  res.end(req.url === "/fixture.js" ? js : `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch();
const results = [];
try {
  for (const platform of ["windows", "macos"]) for (const locale of ["en", "zh-CN"]) for (const theme of ["light", "dark"]) for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 820 }, reducedMotion: "reduce" });
    const options = platform === "windows" ? [
      { value: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", label: "PowerShell 7" },
      { value: "C:\\Windows\\System32\\cmd.exe", label: "CMD" },
    ] : [{ value: "/bin/zsh", label: "Zsh" }, { value: "/bin/bash", label: "Bash" }];
    let shell = "auto", failLoad = false, failSave = false, creates = 0;
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", req => { if (req.method() === "POST" && new URL(req.url()).pathname === "/api/terminal") creates++; });
    await page.route("**/api/terminal/settings", async route => {
      const put = route.request().method() === "PUT";
      if ((!put && failLoad) || (put && failSave)) { await route.fulfill({ status: 500, json: { error: "fixture" } }); return; }
      if (put) shell = route.request().postDataJSON().shell;
      await route.fulfill({ json: { shell, options, defaultShell: options[0].label, unavailable: shell !== "auto" && !options.some(option => option.value === shell) } });
    });
    await page.addInitScript(({ locale, theme }) => { localStorage.setItem("pi-locale", locale); localStorage.setItem("pi-theme", theme); }, { locale, theme });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const section = page.locator(".settings-terminal-section");
    const picker = section.getByRole("combobox");
    await picker.waitFor(); await picker.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.querySelector(".settings-terminal-section [role=combobox]").disabled);
    assert.match(await picker.innerText(), new RegExp(options[0].label));
    await picker.click(); await page.getByRole("option", { name: options[1].label, exact: true }).click();
    await page.waitForFunction(value => document.querySelector(".settings-terminal-section [role=combobox]").textContent.includes(value), options[1].label);
    assert.equal(shell, options[1].value);
    await page.reload(); await picker.scrollIntoViewIfNeeded();
    await page.waitForFunction(value => document.querySelector(".settings-terminal-section [role=combobox]")?.textContent.includes(value), options[1].label);
    const geometry = await section.evaluate(el => {
      const row = el.querySelector(".settings-terminal-option").getBoundingClientRect();
      const picker = el.querySelector("[role=combobox]").getBoundingClientRect();
      const hint = el.querySelector("#settings-terminal-hint");
      const heading = el.querySelector(".settings-general-heading").getBoundingClientRect();
      return { fits: picker.left >= row.left && picker.right <= row.right + 1, width: document.documentElement.scrollWidth, viewport: innerWidth,
        descriptionBetween: hint.getBoundingClientRect().top >= heading.bottom && hint.getBoundingClientRect().bottom <= row.top,
        hintHeight: hint.getBoundingClientRect().height, hintLine: parseFloat(getComputedStyle(hint).lineHeight) };
    });
    assert.ok(geometry.fits); assert.ok(geometry.width <= geometry.viewport);
    assert.ok(geometry.descriptionBetween, "The description must sit between the section heading and option row");
    if (width === 1280) assert.ok(geometry.hintHeight <= geometry.hintLine + 1, "The brief desktop hint must fit on one line");
    if (width === 1280) {
      failSave = true; await picker.click();
      await page.getByRole("option", { name: options[0].label, exact: true }).click();
      await section.getByRole("alert").waitFor();
      assert.equal(shell, options[1].value); assert.match(await picker.innerText(), new RegExp(options[1].label));
      failSave = false; shell = "/removed/shell";
      await page.reload(); await section.getByRole("status").waitFor(); await picker.scrollIntoViewIfNeeded();
      await picker.focus(); await page.keyboard.press("ArrowDown");
      await page.getByRole("option", { name: options[0].label, exact: true }).click();
      await section.getByRole("status").waitFor({ state: "detached" });
      assert.equal(shell, options[0].value);
      failLoad = true; await page.reload(); await section.getByRole("alert").waitFor();
      failLoad = false; await section.getByRole("button", { name: locale === "en" ? "Retry" : "重试", exact: true }).click();
      await section.getByRole("alert").waitFor({ state: "detached" });
      await picker.scrollIntoViewIfNeeded();
    }
    await picker.click();
    await page.screenshot({ path: `${out}/${platform}-${locale}-${theme}-${width}.png` });
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []); assert.equal(creates, 0, "changing the preference must not create a terminal");
    results.push({ platform, locale, theme, width, geometry });
    await page.close();
  }
  await writeFile(`${out}/browser-results.json`, JSON.stringify(results, null, 2));
  console.log("PASS: terminal picker, Windows/macOS options, light/dark, English/Chinese, responsive layout, keyboard, persistence, load retry, failed save and removed shells");
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
