'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const root=path.join(__dirname,'../public'),host='https://accounts.test';
 try{
  for(const width of [1440,393]){
   const ctx=await browser.newContext({viewport:{width,height:900}});
   let scenario='',failures=0,authenticated=false;
   const errors=[],requests=[];
   const tenant={id:'11111111-1111-4111-8111-111111111111',slug:'qa',name:'QA workspace'};
   await ctx.route('**/*',async route=>{
    const url=new URL(route.request().url());requests.push(url.pathname);
    assert.equal(url.origin,host,'Navigation must stay on the same origin');
    if(url.pathname.startsWith('/assets/')){
     const name=path.basename(url.pathname);
     if(name==='agency-chatvice.js')return route.fulfill({contentType:'text/javascript',body:''});
     return route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(path.join(root,name))});
    }
    if(url.pathname==='/api/auth/login'){authenticated=true;return route.fulfill({json:{setupRequired:scenario==='setup'}});}
    if(url.pathname==='/api/auth/recovery-options')return route.fulfill({json:{environmentCredentials:false}});
    if(url.pathname.startsWith('/api/')){
     assert.equal(route.request().method(),'GET','Only synthetic auth POST is allowed');
     if(scenario==='outage'&&url.pathname==='/api/agency/me'&&failures++===0)return route.fulfill({status:503,json:{error:'Layanan sementara tidak tersedia'}});
     if((scenario==='expired'&&url.pathname==='/api/agency/staff')||(scenario==='return'&&url.pathname==='/api/auth/session'&&!authenticated))return route.fulfill({status:401,json:{code:'LOGIN_REQUIRED',error:'Login diperlukan'}});
     const data=url.pathname==='/api/agency/me'?{csrf:'fixture',tenant,display_name:'QA',role:'owner',permissions:['team','audit']}
       :url.pathname==='/api/auth/session'?{csrf:'fixture',role:scenario==='denied'?'viewer':'owner',setupRequired:scenario==='setup'}
       :url.pathname==='/api/admin/agency/tenants'?{items:[tenant]}
       :url.pathname.endsWith('/help')?{chatvice:null}:{items:[]};
     return route.fulfill({json:data});
    }
    if(url.pathname==='/engine'||url.pathname==='/security')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Destination</title><h1>Destination</h1>'});
    return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,url.pathname==='/login'?'login.html':'agency.html'))});
   });
   const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
   scenario='outage';await page.goto(host+'/agency#team');
   await page.getByText('Workspace belum dapat dibuka',{exact:true}).waitFor();
   assert.equal(await page.locator('#login-form').count(),0);
   await page.locator('#retry-workspace').click();await page.locator('#page-title').filter({hasText:'Staff & IP'}).waitFor();
   // Previously entered dialog data must disappear when the session expires.
   await page.getByRole('button',{name:'Tambah staff',exact:true}).click();
   await page.locator('#modal [name=password]').fill('Synthetic private field value');
   await page.locator('#close-dialog').click();scenario='expired';await page.locator('#refresh').click();
   await page.locator('#login-form').waitFor();assert.equal(await page.locator('#login-form [name=tenant]').inputValue(),'qa');
   assert.equal(await page.locator('#modal input').count(),0);assert.equal(await page.locator('.sidebar').count(),0);
   scenario='denied';requests.length=0;await page.goto(host+'/agents#team');
   await page.getByRole('alert').filter({hasText:'master Owner'}).waitFor();
   assert.ok(!requests.includes('/api/admin/agency/tenants'));
   scenario='setup';await page.goto(host+'/agents?case=setup#team');await page.waitForURL('**/security');
   scenario='return';authenticated=false;await page.goto(host+'/agents?tenant_id='+tenant.id+'#team');
   await page.waitForURL('**/login?*');
   assert.equal(new URL(page.url()).searchParams.get('return_to'),'/agents?tenant_id='+tenant.id+'#team');
   await page.locator('[name=username]').fill('fixture');await page.locator('[name=password]').fill('Synthetic login field');
   await page.getByRole('button',{name:/Sign in/}).click();
   await page.locator('#page-title').filter({hasText:'Staff & IP'}).waitFor();assert.equal(new URL(page.url()).searchParams.get('tenant_id'),tenant.id);
   scenario='';
   for(const unsafe of ['https://outside.example/agents','//outside.example/agents','javascript:alert(1)','/agency']){
    await page.goto(host+'/login?return_to='+encodeURIComponent(unsafe));
    await page.locator('[name=username]').fill('fixture');await page.locator('[name=password]').fill('Synthetic login field');
    await page.getByRole('button',{name:/Sign in/}).click();await page.waitForURL(host+'/engine');
   }
   assert.deepEqual(errors,[]);await ctx.close();
  }
  console.log('PASS account UI: desktop/mobile outage retry, expired-session clearing, owner guard, setup redirect, preserved deep link, blocked external return targets');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
