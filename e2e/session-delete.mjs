import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const out = "test-results/session-delete";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/session-delete.fixture.jsx"], bundle: true, platform: "browser",
  outfile: `${out}/fixture.js`, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "actual-sidebar-row", setup(bundler) {
    bundler.onLoad({ filter: /components[/\\]SessionSidebar\.tsx$/ }, async ({ path }) => ({ loader: "tsx",
      contents: `${await readFile(path,"utf8")}\nexport { SessionItem as SidebarSessionFixture };` }));
  } }], logLevel: "warning",
});
const js = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"]
  .map(path => readFile(path,"utf8")))).map(text => text.replace(/^@import[^;]*;/gm, "")).join("\n");
const requests = [];
let pending;
const server = createServer((req,res) => {
  if (req.method === "DELETE") { requests.push(req.url); pending = res; return; }
  if (req.url.startsWith("/api/")) { res.setHeader("Content-Type","application/json"); res.end("{}"); return; }
  if (req.url === "/fixture.js") { res.setHeader("Content-Type","text/javascript"); res.end(js); return; }
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
    html,body,#root{margin:0;width:100%;height:100%}button{font:inherit}
    </style><script>document.documentElement.classList.toggle("dark",localStorage.getItem("pi-theme")==="dark");document.documentElement.dataset.background="meadow";</script></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const results = [];
const reply = (status=200) => {
  assert.ok(pending,"a real delete request must be pending");
  pending.writeHead(status,{"Content-Type":"application/json"});
  pending.end(JSON.stringify(status===200?{success:true}:{error:"Fixture delete failed"})); pending=undefined;
};
async function checkMoreGeometry(row) {
  await row.page().waitForFunction(()=>{
    const paint=document.querySelector('.session-item-more-icon');
    if(!paint)return false;
    const style=getComputedStyle(paint),normalized=document.createElement('span');
    normalized.style.backgroundColor=style.getPropertyValue('--bg-selected').trim();
    return style.backgroundColor===normalized.style.backgroundColor;
  });
  const metrics = await row.evaluate(element=>{
    const row=element.getBoundingClientRect();
    const button=element.querySelector('.session-item-more');
    const paint=button.querySelector('.session-item-more-icon');
    const highlight=paint.getBoundingClientRect();
    const icon=paint.querySelector('svg').getBoundingClientRect();
    const hit=button.getBoundingClientRect();
    return {top:highlight.top-row.top,bottom:row.bottom-highlight.bottom,right:row.right-highlight.right,
      centerY:(highlight.top+highlight.bottom-row.top-row.bottom)/2,
      iconX:(icon.left+icon.right-highlight.left-highlight.right)/2,
      iconY:(icon.top+icon.bottom-highlight.top-highlight.bottom)/2,
      hitWidth:hit.width,hitHeight:hit.height,width:highlight.width,height:highlight.height,
      radius:parseFloat(getComputedStyle(paint).borderRadius),rowRadius:parseFloat(getComputedStyle(element).borderRadius),
      background:getComputedStyle(paint).backgroundColor,
      font:getComputedStyle(element).fontFamily};
  });
  for(const side of ['top','bottom','right'])assert.equal(metrics[side],4,`${side} highlight clearance`);
  for(const axis of ['centerY','iconX','iconY'])assert.equal(metrics[axis],0,`${axis} must be centered`);
  assert.equal(metrics.width,20); assert.equal(metrics.height,20);
  assert.equal(metrics.hitWidth,28); assert.equal(metrics.hitHeight,28);
  assert.equal(metrics.radius+metrics.right,metrics.rowRadius,'nested highlight radius follows its inset');
  assert.notEqual(metrics.background,'rgba(0, 0, 0, 0)','active action highlight must remain visible');
  return metrics;
}
try {
  for (const theme of ["light","dark"]) for (const locale of ["zh-CN","en"]) for (const width of [1280,390,320]) {
    const page = await browser.newPage({ viewport: {width,height:720}, colorScheme:theme });
    const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.addInitScript(({theme,locale})=>{
      localStorage.setItem("pi-locale",locale);
      localStorage.setItem("pi-theme",theme);
    },{theme,locale});
    await page.goto(base);
    await page.waitForFunction(locale=>document.documentElement.lang===locale,locale);
    const row=page.getByRole("treeitem");
    const initial=await row.boundingBox();
    const actionStates=[];
    for(const font of ['system-ui, sans-serif','SimSun, serif','Consolas, monospace']) {
      await row.evaluate((element,font)=>{element.style.fontFamily=font;},font);
      await row.hover();
      const more=row.locator('.session-item-more');
      await more.waitFor();
      await more.hover();
      actionStates.push({state:'hover',...await checkMoreGeometry(row)});
      await page.locator('main').hover();
      await row.focus(); await page.keyboard.press('Tab');
      assert.ok(await more.evaluate(element=>element===document.activeElement));
      actionStates.push({state:'focus',...await checkMoreGeometry(row)});
      await page.keyboard.press('Enter');
      await page.getByRole('menu').waitFor();
      actionStates.push({state:'open',...await checkMoreGeometry(row)});
      await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({state:'detached'});
    }
    await row.evaluate(element=>{element.style.fontFamily='';});
    await page.locator('main button').focus();
    await row.hover();
    await row.locator('.session-item-more').hover();
    if(width===1280 && locale==='zh-CN')await row.screenshot({path:`${out}/more-${theme}.png`});
    await row.focus(); await page.keyboard.press("Delete");
    const dialog=page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(await page.locator(".chat-confirm-subject").innerText(),"查看 YMS 的报表导出与合并策略");
    assert.equal(await row.locator("button").count(),1,"row must retain its original more menu, without inline confirm buttons");
    assert.deepEqual(await row.boundingBox(),initial,"confirming must not resize or replace the session row");
    const metrics=await dialog.evaluate(element=>{
      const panel=element.getBoundingClientRect();
      const buttons=[...element.querySelectorAll(".project-trust-footer button")].map(button=>{
        const box=button.getBoundingClientRect();return {x:box.x,y:box.y,right:box.right,bottom:box.bottom,height:box.height};
      });
      return {width:panel.width,x:panel.x,right:panel.right,bottom:panel.bottom,viewport:innerWidth,
        gap:buttons[1].x-buttons[0].right,buttons,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.ok(!metrics.overflow && metrics.x>=15 && metrics.right<=width-15 && metrics.bottom<=720-15,JSON.stringify(metrics));
    assert.equal(metrics.gap,8);
    assert.equal(metrics.buttons[0].y,metrics.buttons[1].y);
    assert.ok(metrics.buttons.every(button=>button.height>=32));
    const contrast=await dialog.locator(".is-danger").evaluate(button=>{
      const style=getComputedStyle(button);
      const canvas=document.createElement("canvas"); canvas.width=canvas.height=1;
      const context=canvas.getContext("2d");
      const luminance=color=>{
        context.clearRect(0,0,1,1); context.fillStyle=color; context.fillRect(0,0,1,1);
        const rgb=[...context.getImageData(0,0,1,1).data].slice(0,3).map(value=>{
          const v=value/255; return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;
        });
        return rgb.reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
      };
      const foreground=luminance(style.color),background=luminance(style.backgroundColor);
      return (Math.max(foreground,background)+0.05)/(Math.min(foreground,background)+0.05);
    });
    assert.ok(contrast>=4.5,`danger text contrast: ${contrast}`);
    await page.keyboard.press("Tab");
    const cancel=dialog.getByRole("button",{name:locale==="en"?"Cancel":"取消",exact:true});
    const confirm=dialog.getByRole("button",{name:locale==="en"?"Delete":"删除",exact:true});
    assert.ok(await cancel.evaluate(el=>el===document.activeElement));
    await page.keyboard.press("Shift+Tab");
    assert.ok(await confirm.evaluate(el=>el===document.activeElement));
    await page.keyboard.press("Tab");
    assert.ok(await cancel.evaluate(el=>el===document.activeElement));
    await page.keyboard.press("Escape"); await dialog.waitFor({state:"detached"});
    assert.ok(await row.evaluate(el=>el===document.activeElement));
    const before=requests.length;
    await row.hover(); await row.getByRole("button").click();
    await page.getByRole("menuitem",{name:locale==="en"?"Delete":"删除",exact:true}).click();
    await dialog.waitFor();
    await dialog.screenshot({path:`${out}/${theme}-${locale}-${width}.png`});
    if (theme==="light" && locale==="zh-CN" && width===1280) {
      await page.screenshot({path:`${out}/light-context.png`});
    }
    await confirm.click();
    await page.waitForFunction(()=>document.querySelector('.chat-confirm-dialog [aria-busy="true"]'));
    assert.ok(await cancel.isDisabled()); assert.ok(await confirm.isDisabled());
    await page.keyboard.press("Escape"); assert.ok(await dialog.isVisible());
    assert.equal(requests.length,before+1);
    reply(500); await dialog.getByRole("alert").filter({hasText:"Fixture delete failed"}).waitFor();
    assert.ok(await confirm.isEnabled());
    await confirm.click();
    await page.waitForFunction(()=>document.querySelector('.chat-confirm-dialog [aria-busy="true"]'));
    assert.equal(requests.length,before+2); reply();
    await dialog.waitFor({state:"detached"}); await row.waitFor({state:"detached"});
    assert.equal(await page.locator("[data-activated]").innerText(),"0","dialog actions must not activate the conversation");
    assert.deepEqual(errors,[]);
    results.push({theme,locale,width,contrast,...metrics,actionStates});
    await page.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:720}});
  await page.addInitScript(()=>localStorage.setItem("pi-locale","zh-CN"));
  await page.goto(`${base}/?long&folder`);
  const row=page.getByRole("treeitem"); await row.focus(); await page.keyboard.press("Delete");
  const dialog=page.getByRole("dialog"); await dialog.waitFor();
  assert.ok((await dialog.locator(".chat-confirm-subject").innerText()).length>200);
  assert.equal(await dialog.locator(".chat-confirm-subject file").count(),0,"markup-like titles must stay text");
  await dialog.screenshot({path:`${out}/long-title-folder.png`});
  const checkbox=dialog.getByRole("checkbox"); assert.ok(await checkbox.isChecked());
  await checkbox.uncheck(); await dialog.getByRole("button",{name:"删除",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-busy="true"]'));
  assert.equal(requests.at(-1),"/api/sessions/fixture-session"); reply(); await dialog.waitFor({state:"detached"});
  await page.goto(`${base}/?folder`); await row.focus(); await page.keyboard.press("Delete"); await dialog.waitFor();
  await dialog.getByRole("button",{name:"删除",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-busy="true"]'));
  assert.equal(requests.at(-1),"/api/sessions/fixture-session?chatFolder=trash"); reply(); await dialog.waitFor({state:"detached"});
  await page.goto(base); await row.hover(); await row.getByRole("button").click();
  await page.getByRole("menuitem",{name:"删除",exact:true}).click({modifiers:["Shift"]});
  await row.getByRole("button").waitFor({state:"visible"});
  assert.equal(await dialog.count(),0,"Shift-click keeps its explicit bypass");
  await page.waitForFunction(()=>document.querySelector('.session-item')?.style.opacity==='0.5');
  reply(); await row.waitFor({state:"detached"});
  await page.close();
  await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
  console.log("PASS: real sidebar Delete/menu/Shift paths, stable row geometry, shared dialog spacing, focus/Escape, busy/error/retry, folder checkbox, long names; light/dark x Chinese/English x 1280/390/320");
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
}
