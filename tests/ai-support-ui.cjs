'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');
const support = require('../engine/ai-support');

(async()=>{
  const app=express();
  app.use((req,res,next)=>{res.set('Content-Security-Policy',support.contentSecurityPolicy(req.path));next()});
  app.use('/assets',express.static(path.join(__dirname,'../public')));
  app.get('/engine',(req,res)=>res.type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/ai-support.css"><h1>Playground QA</h1><p>Synthetic admin page. No live data.</p><button data-action="logout">Sign out</button><script src="/assets/ai-support.js" defer></script>'));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  let browser;
  try {
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    let authorized=true,requests=0,configReads=0;
    const errors=[];
    const page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/api/admin/ai-support',async route=>{
      configReads++;
      await route.fulfill({status:authorized?200:401,contentType:'application/json',body:JSON.stringify(authorized?{enabled:true,url:support.WIDGET_URL,validUntil:Date.now()+600000}:{error:'Login required'})});
    });
    await context.route('https://chatvice.app/**',async route=>{
      requests++;
      assert.equal(new URL(route.request().url()).pathname,'/widget/m_36f76fcbe11167ed');
      assert.equal(route.request().headers().referer,base+'/');
      await route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:20px;background:#17171e;color:white;font:16px system-ui}input{max-width:100%}</style><h2>Playground AI Support</h2><p>Chatvice frame QA fixture</p><input aria-label="Message" placeholder="Type a question"><script>parent.postMessage({type:"chatvice-ready"},"*")</script>'});
    });
    await page.goto(base+'/engine');
    const trigger=page.getByRole('button',{name:'AI Support',exact:false});
    await trigger.waitFor();
    assert.equal(requests,0,'No request to Chatvice before opening');
    await trigger.click();
    await page.frameLocator('iframe').getByRole('heading',{name:'Playground AI Support'}).waitFor();
    await page.locator('.ai-support-status').waitFor({state:'hidden'});
    assert.equal(requests,1);
    assert.match(await page.locator('iframe').getAttribute('sandbox'),/allow-scripts/);
    assert.equal((await page.locator('iframe').getAttribute('sandbox')).includes('allow-top-navigation'),false);
    // A same-page or forged origin message must not control the embedded panel.
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:'https://evil.example',data:{type:'chatvice-close'},source:window})));
    assert.equal(await page.getByRole('dialog').isVisible(),true);
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:'https://chatvice.app',data:{type:'chatvice-close'},source:window})));
    assert.equal(await page.getByRole('dialog').isVisible(),true);
    await fs.mkdir(path.join(__dirname,'../test-results'),{recursive:true});
    await page.screenshot({path:path.join(__dirname,'../test-results/ai-support-desktop.png')});
    await page.getByRole('button',{name:'Tutup AI Support'}).click();
    assert.equal(await trigger.getAttribute('aria-expanded'),'false');
    await trigger.click();
    assert.equal(requests,1,'Reopening preserves the existing frame');
    assert.ok(configReads>=3,'Each opening rechecks admin authorization');
    await page.setViewportSize({width:390,height:844});
    const bounds=await page.getByRole('dialog').boundingBox();
    assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=390&&bounds.y+bounds.height<=844);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(__dirname,'../test-results/ai-support-mobile.png')});
    await page.keyboard.press('Escape');
    authorized=false;
    await trigger.click();
    await page.locator('#playground-ai-support').waitFor({state:'detached'});
    assert.equal(await page.locator('iframe').count(),0);
    authorized=true;
    await page.reload();
    await trigger.waitFor();
    await trigger.click();
    await page.getByRole('button',{name:'Tutup AI Support'}).click();
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    assert.equal(await page.locator('#playground-ai-support').count(),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: lazy loading, isolated iframe, origin/source checks, mobile fit, auth recheck, logout cleanup');
  } finally {
    await browser?.close();
    await new Promise(r=>server.close(r));
  }
})().catch(error=>{console.error(error);process.exitCode=1});
