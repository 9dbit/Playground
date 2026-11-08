'use strict';
// Real UI assets with deterministic API fixtures; HTTP/database behavior is tested separately.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const root=path.join(__dirname,'..'),tenant={id:'11111111-1111-4111-8111-111111111111',name:'QA Operations',slug:'qa'};
 try{for(const width of [1440,393,320]){
  const ctx=await browser.newContext({viewport:{width,height:900}}),errors=[],writes=[],queries=[];
  let tries=0;
  await ctx.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());
   if(u.hostname!=='operations.test')return route.fulfill({body:''});
   if(u.pathname.startsWith('/assets/')){const name=path.basename(u.pathname);return route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',body:name==='agency-chatvice.js'?'':fs.readFileSync(path.join(root,'public',name))});}
   if(u.pathname.startsWith('/api/')){
    queries.push(u);
    if(r.method()!=='GET'){
     writes.push({path:u.pathname,body:r.postDataJSON()});
     if(u.pathname.endsWith('/coins')&&tries++===0)return route.fulfill({status:503,json:{error:'Coba ulang request yang sama'}});
     return route.fulfill({json:{ok:true}});
    }
    const data=u.pathname==='/api/auth/session'?{csrf:'fixture',role:'owner'}
     :u.pathname==='/api/agency/me'?{csrf:'fixture',tenant,display_name:'Finance QA',role:'finance',permissions:['overview','finance.read','coins.request','reports']}
     :u.pathname==='/api/admin/agency/tenants'?{items:[tenant]}
     :u.pathname.endsWith('/help')?{chatvice:null}
     :u.pathname.endsWith('/coins')?{items:[{id:'22222222-2222-4222-8222-222222222222',source:'manual',amount:'100000000',status:'requested',reason:'Client demo <script>unsafe</script>',requested_by:'qa',created_at:'2026-11-08T04:00:00Z'}],stock:[{code:'stock:available',amount:'5000000'}],totals:[{period:'2026-11-08',requests:1,approved:'0',pending:'100000000'}],batch:'100000000',has_more:false,settings:{mode:'off',last_status:'disabled',threshold:'0',daily_limit:'100000000',monthly_limit:'300000000',version:0}}
     :u.pathname.endsWith('/reports')?{items:[],cashflow:[],notice:'QA report',cash_currency:'IDR'}:{items:[]};
    return route.fulfill({json:data});
   }
   return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'public/agency.html'))});
  });
  const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto('https://operations.test/agents#coins');await p.getByRole('heading',{name:'Stok & auto refill',exact:true}).waitFor();
  assert.equal(await p.locator('#body script').count(),0);
  await p.locator('[name=from]').fill('2026-11-01');await p.locator('[name=to]').fill('2026-11-08');await p.locator('[name=period]').selectOption('weekly');
  await p.getByRole('button',{name:'Terapkan filter'}).click();
  await p.waitForResponse(r=>r.url().includes('period=weekly'));
  await p.getByRole('heading',{name:'Stok & auto refill',exact:true}).waitFor();
  assert.ok(queries.some(u=>u.searchParams.get('from')==='2026-11-01'&&u.searchParams.get('to')==='2026-11-08'));
  await p.getByRole('button',{name:'Request coin',exact:true}).click();await p.locator('#modal [name=reason]').fill('UI retry test');
  await p.getByRole('button',{name:'Kirim request',exact:true}).click();await p.locator('#modal .error').filter({hasText:'Coba ulang'}).waitFor();
  await p.getByRole('button',{name:'Kirim request',exact:true}).click();await p.locator('#modal').waitFor({state:'hidden'});
  assert.ok(writes[0].body.idempotency_key);assert.equal(writes[0].body.idempotency_key,writes[1].body.idempotency_key);
  await p.getByRole('button',{name:'Atur auto refill'}).click();assert.equal(await p.locator('[name=mode] option[value=auto]').count(),1);
  await p.locator('[name=current_password]').fill('Synthetic UI fixture');await p.locator('#modal [name=mode]').selectOption('auto');
  await p.getByRole('button',{name:'Simpan',exact:true}).click();await p.locator('#modal').waitFor({state:'hidden'});
  assert.equal(writes.at(-1).body.version,0);assert.equal(writes.at(-1).body.current_password,'Synthetic UI fixture');
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});await p.evaluate(async()=>{scrollTo(0,0);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});await p.screenshot({path:path.join(root,`test-results/operations-coins-${width}.png`),fullPage:true});
  await p.goto('https://operations.test/agency#coins');await p.getByRole('heading',{name:'Stok & auto refill',exact:true}).waitFor();
  assert.equal(await p.getByRole('button',{name:'Review',exact:true}).count(),0);
  await p.getByRole('button',{name:'Atur auto refill'}).click();assert.equal(await p.locator('[name=mode] option[value=auto]').count(),0);assert.equal(await p.locator('[name=current_password]').count(),0);
  await p.locator('#close-dialog').click();await p.goto('https://operations.test/agency#reports');await p.getByRole('heading',{name:/Penjualan & penarikan/}).waitFor();
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await p.goto('https://operations.test/agency#transactions');await p.locator('#history-filter').waitFor();
  assert.equal(await p.locator('#history-filter [name=period]').count(),0);assert.equal(await p.locator('#history-filter [name=search]').count(),1);
  assert.deepEqual(errors,[]);await ctx.close();
 }
 console.log('PASS operations UI: 1440/393/320 px, date filters, retry key, master authorization fields, agent restrictions, no script injection or overflow');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
