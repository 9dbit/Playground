'use strict';
const assert=require('node:assert/strict'),C=require('../engine/security-crypto');
module.exports=async({pool,ok,req,creds,password,base,browser,game})=>{
 const path='/api/admin/agency/studio/'+game.slug;
 async function until(fn){for(let n=0;n<150;n++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,200));}throw Error('Studio runtime confirmation timeout');}
 await until(async()=>{const t=(await ok(path)).target;return t.seen_at&&t.runtime;});
 const master=creds.get('master'),ctx=await browser.newContext({viewport:{width:393,height:852}});
 await ctx.addCookies([{name:'gameops_session',value:master.cookie.split('=')[1],url:base}]);
 const page=await ctx.newPage();await page.route('https://chatvice.app/**',r=>r.fulfill({body:'',contentType:'application/javascript'}));
 await page.goto(base+'/native-studio?game='+game.slug);await page.getByRole('button',{name:'Edit tampilan & audio',exact:true}).click();
 await page.locator('#studio-modal [name=name]').fill('Native Studio QA '+game.name);
 await page.locator('#studio-modal [name='+(game.python?'animation_speed':'master')+']').fill(game.python?'1.1':'40');
 await page.getByRole('button',{name:'Simpan & validasi',exact:true}).click();await page.locator('#studio-modal').waitFor({state:'hidden'});
 const release=await until(async()=>{const d=await ok(path);return d.packages.find(x=>x.name==='Native Studio QA '+game.name&&x.state==='validated');});
 const original=(await ok(path)).target;
 assert.equal(original.desired,null,'validation alone must not activate');
 assert.equal((await req(path+'/activate','POST',{release:release.id,expected_generation:original.generation,reason:'wrong password',current_password:'bad'})).status,401);
 assert.equal((await req(path+'/activate','POST',{release:release.id,expected_generation:original.generation+1,reason:'stale',current_password:password})).status,409);
 // Native validation must reject malformed payloads without replacing active config.
 const good=await ok(path+'/package/'+release.id),bad=structuredClone(good);bad.name='Rejected QA';
 if(game.python)bad.payload.config.presentation.animation_speed=-1;else bad.payload.project.layers=[];
 const rejected=await ok(path+'/packages','POST',bad);
 await until(async()=>{const d=await ok(path);return d.packages.find(x=>x.id===rejected.id&&x.state==='rejected');});
 await pool.query('UPDATE gameops_admin_accounts SET mfa_last_step=-1 WHERE id=$1',[master.id]);
 assert.equal((await req(path+'/activate','POST',{release:rejected.id,expected_generation:original.generation,reason:'invalid',current_password:password,code:C.totp(master.mfa,Math.floor(Date.now()/30000))})).status,409);
 await pool.query('UPDATE gameops_admin_accounts SET mfa_last_step=-1 WHERE id=$1',[master.id]);
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 const row=page.locator('tr').filter({hasText:'Native Studio QA '+game.name});await row.getByRole('button').click();
 await page.locator('[name=reason]').fill('QA presentation publication');await page.locator('[name=current_password]').fill(password);await page.locator('[name=code]').fill(C.totp(master.mfa,Math.floor(Date.now()/30000)));
 await page.getByRole('button',{name:'Terbitkan ke sandbox',exact:true}).click();await page.locator('#studio-modal').waitFor({state:'hidden'});
 await until(async()=>{const d=await ok(path);return d.target.observed===release.id&&d.target.observed_generation===d.target.generation;});
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Sudah diterapkan',{exact:true}).waitFor();
 await page.screenshot({path:require('node:path').join(__dirname,'../test-results/'+game.slug+'-studio-mobile.png'),fullPage:true});
 return {studioRelease:release.id,async rollbackStudio(){
  await pool.query('UPDATE gameops_admin_accounts SET mfa_last_step=-1 WHERE id=$1',[master.id]);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Kembali ke konfigurasi bawaan',exact:true}).click();
  await page.locator('[name=reason]').fill('QA rollback');await page.locator('[name=current_password]').fill(password);await page.locator('[name=code]').fill(C.totp(master.mfa,Math.floor(Date.now()/30000)));
  await page.getByRole('button',{name:'Terbitkan ke sandbox',exact:true}).click();await page.locator('#studio-modal').waitFor({state:'hidden'});
  await until(async()=>{const d=await ok(path);return d.target.desired===null&&d.target.observed===null&&d.target.observed_generation===d.target.generation;});
 },closeStudio:()=>ctx.close()};
};
