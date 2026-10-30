import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright';

const out='test-results/appearance';await mkdir(out,{recursive:true});
await build({entryPoints:['e2e/appearance.fixture.jsx'],bundle:true,platform:'browser',format:'iife',
  outfile:out+'/preview.js',define:{'process.env':'{"NODE_ENV":"production"}'},jsx:'automatic',logLevel:'warning'});
const js=await readFile(out+'/preview.js');
const css=(await Promise.all(['app/globals.css','app/settings.css','app/native-theme.css'].map(p=>readFile(p,'utf8'))))
  .map(s=>s.replace(/^@import[^;]*;/gm,'')).join('\n');
const serve=async(req,res)=>{
  if(req.url.startsWith('/api/')){
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url.startsWith('/api/chat-settings')
      ?{model:null,thinkingLevel:null,instructions:'',allowedTools:[],confirmSave:false,instructionsMaxChars:8000}:{}));return;
  }
  res.setHeader('Content-Type',req.url==='/preview.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html; charset=utf-8');
  res.end(req.url==='/preview.js'?js:req.url==='/style.css'?css:
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style></head><body><div id="root"></div><script src="/preview.js"></script></body></html>');
};
const server=createServer(serve);
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch();
try{
  for(const theme of ['light','dark'])for(const width of [1464,1280,1024,800,640,390,320]){
    const page=await browser.newPage({viewport:{width,height:820},colorScheme:theme,reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(theme=>{localStorage.setItem('pi-theme',theme);localStorage.setItem('pi-locale','en');},theme);
    await page.goto(url);await page.locator('.settings-font-section').waitFor();
    // Appearance offers colour mode only: no background washes, one flat neutral canvas.
    assert.equal(await page.locator('input[name="background"]').count(),0,'Background choices were removed');
    assert.equal(await page.locator('html').getAttribute('data-background'),null,'No background attribute is set');
    const canvas=await page.locator('.settings-dialog-surface').evaluate(el=>{const cs=getComputedStyle(el);return {image:cs.backgroundImage,color:cs.backgroundColor};});
    assert.equal(canvas.image,'none','The canvas must be a flat colour, not a gradient');
    const [r,g,b]=canvas.color.match(/\d+(\.\d+)?/g).map(Number);
    assert.ok(Math.max(r,g,b)-Math.min(r,g,b)<=3,`The canvas must be neutral, got ${canvas.color}`);
    await page.getByRole('radio',{name:theme==='light'?'Dark':'Light',exact:true}).locator('..').click();
    await page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme==='light'?'dark':'light');
    await page.getByRole('radio',{name:theme==='light'?'Light':'Dark',exact:true}).locator('..').click();
    await page.screenshot({path:`${out}/${theme}-${width}.png`});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator('.settings-theme-options').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'Mode labels must fit without clipping');
    assert.deepEqual(errors,[]);await page.close();
  }
  await writeFile(out+'/results.json',JSON.stringify({themes:['light','dark'],widths:[1464,1280,1024,800,640,390,320]},null,2));
  console.log('PASS: colour mode only, flat neutral canvas, light/dark, desktop and narrow widths');
}finally{await browser.close();await new Promise(r=>server.close(r));}
