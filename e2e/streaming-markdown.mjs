import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";

const out = "test-results/streaming-markdown";
await mkdir(out, { recursive: true });
const buildOptions = {
  entryPoints: ["e2e/streaming-markdown.fixture.tsx"], bundle: true, platform: "browser", format: "iife",
  jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
};
await build({ ...buildOptions, outfile: `${out}/current.js` });
await build({
  ...buildOptions, outfile: `${out}/baseline.js`,
  // Reproduce the previous 120ms/full-document strategy with the same Pi
  // plugins/widgets. This remains a baseline after the change is committed.
  plugins: [{ name: "previous-renderer", setup(bundler) {
    bundler.onLoad({ filter: /components[/\\]StreamingMarkdown\.tsx$/ }, () => ({ loader: "tsx", contents: `
      import ReactMarkdown from 'react-markdown';
      import {memo} from 'react';
      export const StreamingMarkdown=memo(({isStreaming,...props})=><ReactMarkdown {...props}/>);
    ` }));
    bundler.onLoad({ filter: /hooks[/\\]useStreamingMarkdown\.ts$/ }, () => ({ loader: "ts", contents: `
      import {useState,useRef,useEffect} from 'react';
      export function useStreamingMarkdownText(value,active){
        const [shown,setShown]=useState(value),last=useRef(0);
        useEffect(()=>{if(!active)return;const publish=()=>{last.current=Date.now();setShown(value);};
          const wait=last.current+120-Date.now();if(wait<=0){publish();return;}
          const timer=setTimeout(publish,wait);return()=>clearTimeout(timer);
        },[value,active]);return active?shown:value;
      }
    ` }));
  } }],
});
const [current, baseline, ...styles] = await Promise.all([
  readFile(`${out}/current.js`), readFile(`${out}/baseline.js`),
  ...["app/globals.css", "app/settings.css", "app/native-theme.css", "node_modules/katex/dist/katex.min.css"].map((path) => readFile(path, "utf8")),
]);
const css = styles.map((text) => text.replace(/^@import[^;]*;/gm, "")).join("\n")
  + '\nbody{margin:0;font:14px/1.6 "Segoe UI",sans-serif;background:var(--bg);color:var(--text)} input{font:inherit;color:var(--text);background:var(--bg-panel);border:1px solid var(--border);border-radius:6px;padding:6px}';
const server = createServer((req, res) => {
  if (req.url === "/current.js" || req.url === "/baseline.js") {
    res.setHeader("Content-Type", "text/javascript"); res.end(req.url === "/current.js" ? current : baseline);
  } else if (req.url === "/style.css") {
    res.setHeader("Content-Type", "text/css"); res.end(css);
  } else if (req.url.startsWith("/fonts/")) {
    readFile(`node_modules/katex/dist${req.url}`).then((font) => res.end(font)).catch(() => { res.statusCode = 404; res.end(); });
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/${req.url.includes("baseline") ? "baseline" : "current"}.js"></script></body></html>`);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined), headless: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const prefix = Array.from({ length: 90 }, (_, i) => `## Stable section ${i}\n\n中文段落，包含 **重点**、[文档](https://example.com) 和普通内容。 ${"A completed paragraph stays on screen. ".repeat(5)}\n\n`).join("");
const results = [];
async function pageFor(mode = "current", reducedMotion = "no-preference", width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 850 }, reducedMotion });
  await page.addInitScript(() => { localStorage.setItem("pi-locale", "en"); });
  await page.goto(`${base}/${mode}`);
  await page.waitForFunction(() => window.markdownFixture);
  return page;
}
const set = (page, text, streaming = true) => page.evaluate(({ text, streaming }) => window.markdownFixture.set(text, streaming), { text, streaming });
try {
  for (const mode of ["baseline", "current"]) {
    const page = await pageFor(mode);
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await set(page, prefix + "Live tail: ");
    await delay(700);
    // Settle the initial blocks' one-time fade cleanup before measuring how
    // later deltas affect them. Both strategies receive the same warmup.
    await set(page, prefix + "Live tail: warmup. ");
    await delay(300);
    await page.evaluate(() => {
      window.stableHeading = document.querySelector(".markdown-body h2");
      window.markdownFixture.resetMetrics();
    });
    let text = prefix + "Live tail: warmup. ";
    for (let i = 0; i < 65; i++) {
      text += `增量${i}，streaming content. `;
      await set(page, text);
      if (i === 25) {
        await page.locator("#draft").fill("可以同时输入，不会被回复覆盖");
        await page.mouse.wheel(0, 350);
      }
      await delay(20);
    }
    await delay(550);
    const measured = await page.evaluate(() => ({ ...window.markdownFixture.metrics,
      stableHeading: window.stableHeading === document.querySelector(".markdown-body h2"),
      draft: document.querySelector("#draft").value,
    }));
    assert.equal(measured.stableHeading, true, `${mode}: completed nodes stay mounted`);
    assert.equal(measured.draft, "可以同时输入，不会被回复覆盖");
    results.push({ mode, characters: text.length, ...measured });
    await set(page, text + " 最终正文。", false);
    assert.ok((await page.locator(".markdown-body").textContent()).endsWith("最终正文。"));
    assert.equal(await page.locator(".streamdown-animated").count(), 0, "completion flushes immediately");
    assert.equal(await page.locator(".markdown-body h2").count(), 90);
    assert.deepEqual(errors, []);
    await page.close();
  }
  await writeFile(`${out}/metrics.json`, JSON.stringify(results, null, 2));
  assert.ok(results[1].parsedChars < results[0].parsedChars * 0.25, JSON.stringify(results));
  assert.ok(results[1].stableParses <= 1, `new text must not reparse completed sections: ${JSON.stringify(results)}`);

  for (const theme of ["dark", "light"]) for (const width of [1280, 390]) {
    const page = await pageFor("current", "no-preference", width);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
    }, theme);
    const text = "## 流式 Markdown\n\n已完成的段落，包含 **重点** 和 [本地文件](src/main.ts)。\n\n- 第一项\n- 第二项\n\n| 功能 | 状态 |\n| --- | --- |\n| 中文流式 | 正常 |\n\n正在继续回复";
    await set(page, text); await delay(250);
    assert.equal(await page.locator(".streamdown-animated").count(), 1);
    const geometry = () => page.locator(".markdown-body").evaluate((body) => {
      const box = body.getBoundingClientRect();
      return [...body.querySelectorAll("h2,p,ul,table")].map((node) => {
        const rect = node.getBoundingClientRect();
        return { tag: node.tagName, top: rect.top - box.top, height: rect.height };
      });
    });
    const streamingGeometry = await geometry();
    await set(page, text, false);
    assert.deepEqual(await geometry(), streamingGeometry, "stream completion must preserve Markdown spacing");
    await set(page, text, true); await delay(250);
    await set(page, text + "，**强调文字还在生成"); await delay(250);
    assert.ok((await page.locator(".markdown-body").textContent()).includes("强调文字"));
    await page.getByRole("link", { name: "本地文件" }).click();
    assert.equal(await page.locator("html").getAttribute("data-opened-file"), "/project/src/main.ts");
    await page.screenshot({ path: `${out}/${theme}-${width}.png` });
    // Replacement/reconnection must not show text from the previous response.
    await set(page, "替换后的回复。", true);
    assert.ok((await page.locator(".markdown-body").textContent()).includes("替换后的回复"));
    await set(page, "替换后的回复，立即停止。", false);
    assert.equal(await page.locator(".markdown-body").textContent(), "替换后的回复，立即停止。");
    await set(page, "替换后的回复，立即停止。开始下一轮。", true);
    assert.ok((await page.locator(".markdown-body").textContent()).endsWith("开始下一轮。"), "a restarted stream flushes its first snapshot");
    await page.close();
  }

  const page = await pageFor();
  for (const text of [
    "[manual][ref]\n\n[ref]: https://example.com",
    "Note[^1]\n\n[^1]: Footnote text",
    "Before\n\n$$\nx = y\n$$\n\nAfter",
    '<div>\n\n**HTML text**\n\n</div><img src="x" onerror="window.markdownPwned=1"><script>window.markdownPwned=1</script>',
  ]) {
    await set(page, text); await delay(120);
    assert.equal(await page.locator(".streamdown-animated").count(), 0, "document-scoped syntax uses one tree");
  }
  assert.equal(await page.evaluate(() => window.markdownPwned), undefined);
  await set(page, "```js\nconst answer = 42;\n```"); await delay(120);
  assert.ok((await page.locator(".markdown-code-block").textContent()).includes("const answer = 42;"));
  assert.equal(await page.locator(".markdown-code-block .linenumber").count(), 0, "streaming keeps Pi's lightweight code view");
  await set(page, "```js\nconst answer = 42;\n```", false);
  assert.ok((await page.locator(".markdown-code-block").textContent()).includes("const answer = 42;"));
  await set(page, ':::artifact{identifier="sample" type="code" title="Sample"}\n```js\nconst answer = 42;\n```\n:::'); await delay(120);
  assert.ok((await page.locator(".markdown-body").textContent()).includes("42"), "artifact content survives the adapter");
  assert.ok(!(await page.locator(".markdown-body").textContent()).includes(":::artifact"));
  await set(page, "[manual][ref]\n\n[ref]: https://example.com"); await delay(120);
  assert.equal(await page.getByRole("link", { name: "manual" }).getAttribute("href"), "https://example.com");
  await set(page, "$$\nx = y\n$$"); await delay(120);
  assert.equal(await page.locator(".katex-display").count(), 1);
  await set(page, "Normal text streaming"); await delay(120);
  assert.equal(await page.locator(".streamdown-animated").count(), 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => !document.querySelector(".streamdown-animated"));
  await set(page, "完整显示，尊重减少动画设置。", false);
  assert.equal(await page.locator(".markdown-body").textContent(), "完整显示，尊重减少动画设置。");
  await delay(200);
  const settled = await page.evaluate(() => window.markdownFixture.metrics.parses);
  await delay(250);
  assert.equal(await page.evaluate(() => window.markdownFixture.metrics.parses), settled, "finished messages stop parsing");
  await page.close();
  await writeFile(`${out}/metrics.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ results, checks: "streaming, completion, replacement, reduced motion, references, math, sanitization, file links, desktop/mobile themes" }, null, 2));
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve));
}
