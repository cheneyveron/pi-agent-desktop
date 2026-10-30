import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const out = "test-results/terminal-theme";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/terminal-theme.fixture.tsx"], bundle: true, platform: "browser",
  outfile: `${out}/fixture.js`, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "inspect-real-terminal", setup(bundler) {
    bundler.onLoad({ filter: /components[/\\]TerminalPanel\.tsx$/ }, async ({ path }) => ({ loader: "tsx",
      contents: (await readFile(path, "utf8")).replace("terminalRef.current = terminal;", "terminalRef.current = terminal; window.testTerminal = terminal;") }));
  } }],
});
const js = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css", "node_modules/@xterm/xterm/css/xterm.css"]
  .map(p => readFile(p, "utf8")))).map(s => s.replace(/^@import[^;]*;/gm, "")).join("\n");
let creations = 0;
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(js); return; }
  if (req.url?.includes("/api/terminal")) {
    if (req.url === "/api/terminal") creations++;
    if (req.method === "GET" && !req.url.endsWith("/events")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Terminal session no longer exists" })); return;
    }
    if (req.url.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`data: ${JSON.stringify({type:"output",data:"Terminal ready / 终端就绪\r\n\x1b[31mError\x1b[0m \x1b[32mSuccess\x1b[0m\r\n> ",offset:100})}\n\n`);
      return;
    }
    res.setHeader("Content-Type", "application/json"); res.end("{}"); return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(`<html><head><style>${css}\nhtml,body,#root{margin:0;height:100%;width:100%;}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(creations,0,"opening the app must not start a shell");
  await page.getByRole("button",{name:"Open terminal",exact:true}).click();
  await page.locator(".is-ready").waitFor();
  await page.waitForFunction(() => window.testTerminal.buffer.active.getLine(0)?.translateToString().includes("Terminal ready"));
  await page.evaluate(() => { window.initialTerminal = window.testTerminal; });
  for (const width of [900, 320]) {
    await page.setViewportSize({width, height:650});
    for (const dark of [false,true,false]) {
      await page.evaluate(dark => document.documentElement.classList.toggle("dark",dark),dark);
      await page.waitForFunction(() => window.testTerminal.options.theme.background === getComputedStyle(document.querySelector(".terminal-panel")).getPropertyValue("--surface").trim());
      const state = await page.evaluate(() => ({
        same: window.testTerminal === window.initialTerminal,
        text: window.testTerminal.buffer.active.getLine(0)?.translateToString(),
        background: window.testTerminal.options.theme.background,
        panel: getComputedStyle(document.querySelector(".terminal-panel")).backgroundColor,
        header: getComputedStyle(document.querySelector(".terminal-panel-header")).backgroundColor,
        overflow: document.documentElement.scrollWidth > innerWidth,
        bottom: document.querySelector(".terminal-panel").getBoundingClientRect().bottom,
        viewport: innerHeight,
        slot: document.querySelector("[data-terminal-slot]").getBoundingClientRect().bottom,
        screen: document.querySelector(".xterm-screen").getBoundingClientRect().bottom,
      }));
      assert.ok(state.same); assert.match(state.text,/Terminal ready/); assert.ok(!state.overflow);
      assert.equal(state.bottom,state.slot,"terminal height must follow its containing panel");
      assert.ok(state.screen <= state.slot + 1,"terminal rows must fit below the workspace toolbar");
      assert.equal(state.panel,state.header);
      if (!dark) assert.equal(state.background,"#ffffff");
      else assert.notEqual(state.background,"#ffffff");
      await page.screenshot({path:`${out}/${width}-${dark?'dark':'light'}.png`});
    }
  }
  assert.equal(creations,1,"theme and width changes must not recreate the terminal");
  await page.reload();
  await page.getByRole("button",{name:"Preload renderer",exact:true}).click();
  await page.getByRole("button",{name:"Renderer preloaded",exact:true}).waitFor();
  assert.equal(creations,1,"preloading renderer code must not start a shell");
  await page.getByRole("button",{name:"Open terminal",exact:true}).click();
  await page.locator(".is-ready").waitFor();
  assert.equal(creations,2,"opening a preloaded renderer starts exactly one shell");
  await page.goto(`http://127.0.0.1:${server.address().port}/?restored`);
  await page.getByRole("button",{name:"Open terminal",exact:true}).click();
  await page.getByRole("alert").filter({hasText:"Terminal session no longer exists"}).waitFor();
  assert.equal(creations,2,"restoring a missing session must not silently replace it");
  await page.getByRole("button",{name:"Reconnect terminal",exact:true}).click();
  await page.locator(".is-ready").waitFor();
  assert.equal(creations,3,"explicit reconnect creates one replacement for a missing session");
  assert.deepEqual(errors,[]);
  console.log("PASS: terminal cold/preloaded opening, explicit reconnect, light/dark surfaces, panel sizing, narrow layouts and preserved session/output");
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
