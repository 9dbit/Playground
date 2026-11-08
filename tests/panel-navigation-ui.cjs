'use strict';
// Navigation-only fixtures: no transaction actions or production accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');
const tenant = {id:'11111111-1111-4111-8111-111111111111',name:'QA Workspace',slug:'qa-workspace'};
(async () => {
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  let checks = 0;
  try {
    for (const width of [1440,393,320]) {
      const context = await browser.newContext({viewport:{width,height:900}});
      fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
      const errors = [];
      const requests = [];
      await context.route('**/*', async route => {
        const u = new URL(route.request().url());
        requests.push(u.pathname);
        if (u.hostname !== 'navigation.test') return route.fulfill({body:''});
        if (u.pathname.startsWith('/assets/')) {
          const filename = path.basename(u.pathname);
          if (filename === 'agency-chatvice.js') return route.fulfill({contentType:'text/javascript',body:''});
          const file = path.join(root,'public',filename);
          return route.fulfill({contentType:filename.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
        }
        if (u.pathname.startsWith('/api/')) {
          if (new URL(route.request().headers().referer || 'https://navigation.test').searchParams.has('logged-out')) return route.fulfill({status:401,json:{error:'Login required'}});
          assert.equal(route.request().method(),'GET');
          const data = u.pathname === '/api/auth/session' ? {csrf:'fixture',role:'owner'}
            : u.pathname === '/api/agency/me' ? {csrf:'fixture',tenant,display_name:'QA Staff',role:'support',permissions:['team','audit']}
            : u.pathname === '/api/admin/agency/tenants' ? {items:[tenant,{...tenant,id:'22222222-2222-4222-8222-222222222222',name:'QA Workspace B'}]}
            : u.pathname.endsWith('/help') ? {chatvice:null}
            : {items:[]};
          return route.fulfill({json:data});
        }
        return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'public/agency.html'))});
      });
      const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
      await page.goto('https://navigation.test/agents/#team');
      await page.locator('.pg-panel-context').filter({hasText:'Staff & IP'}).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('tenant_id'),tenant.id);
      assert.equal(await page.locator('.sidebar [aria-current=page]').textContent(),'Staff & IP');
      assert.match(await page.title(),/Staff & IP · Master/);
      assert.match(await page.locator('[data-pg-back]').getAttribute('href'),/#network$/);
      assert.equal(await page.locator('.pg-navigation').count(),1);
      if (width < 680) assert.equal(await page.locator('.sidebar nav').isVisible(),false);
      for (let count=0;count<3;count++) {
        await page.locator('[data-pg-menu]').click();
        await page.locator('#pg-main-menu[open]').waitFor();
        assert.equal(await page.locator('#pg-main-menu h3').filter({hasText:'QA Workspace'}).count(),1);
        assert.equal(await page.locator('#pg-main-menu a[aria-current=page]').count(),1);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('[data-pg-menu]').evaluate(el=>el===document.activeElement),true);
      }
      await page.locator('[data-pg-menu]').click();
      await page.locator('#pg-main-menu a').filter({hasText:/^Audit$/}).click();
      await page.locator('#page-title').filter({hasText:/^Audit$/}).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('tenant_id'),tenant.id);
      assert.equal(await page.locator('#pg-main-menu').isVisible(),false);
      await page.reload();
      await page.locator('.pg-panel-context').filter({hasText:'Audit'}).waitFor();
      assert.equal(new URL(page.url()).hash,'#audit');
      await page.locator('#tenant-select').selectOption('22222222-2222-4222-8222-222222222222');
      await page.locator('.pg-panel-context').filter({hasText:'QA Workspace B / Audit'}).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('tenant_id'),'22222222-2222-4222-8222-222222222222');
      await page.locator('[data-pg-back]').click();
      await page.locator('#page-title').filter({hasText:/^Semua agen$/}).waitFor();
      assert.equal(await page.locator('[data-pg-back]').getAttribute('href'),'/engine#/dashboard');
      await page.screenshot({path:path.join(root,`test-results/panel-master-${width}.png`),fullPage:true});
      // Restricted staff only gets its own links; an unknown deep link resolves safely.
      await page.goto('https://navigation.test/agency#not-a-menu');
      await page.locator('.pg-panel-context').filter({hasText:'Panel agen'}).waitFor();
      assert.equal(new URL(page.url()).hash,'#team');
      await page.locator('[data-pg-menu]').click();
      assert.equal(await page.locator('#pg-main-menu a[href^="/engine"],#pg-main-menu a[href^="/agents"]').count(),0);
      assert.equal(await page.locator('#pg-main-menu a').count(),2);
      await page.locator('#pg-main-menu a').filter({hasText:/^Audit$/}).click();
      await page.locator('#page-title').filter({hasText:/^Audit$/}).waitFor();
      await page.locator('[data-pg-back]').click();
      await page.locator('#page-title').filter({hasText:/^Staff & IP$/}).waitFor();
      assert.equal(new URL(page.url()).pathname,'/agency');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      assert.equal(await page.locator('.pg-navigation').count(),1);
      assert.deepEqual(errors,[]);
      fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
      await page.screenshot({path:path.join(root,`test-results/panel-navigation-${width}.png`),fullPage:true});
      await page.goto('https://navigation.test/agency?logged-out=1');
      await page.locator('#login-form').waitFor();
      assert.equal(await page.locator('.pg-navigation').count(),0);
      checks++;
      await context.close();
    }
    console.log(JSON.stringify({passed:checks,viewports:[1440,393,320],scope:'navigation-only browser fixtures',assertions:['role-scoped menus','tenant context','trailing slash','unknown route','active page','menu reopen','Escape focus','no overflow','back link','reload deep link','tenant switch','login screen']}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
