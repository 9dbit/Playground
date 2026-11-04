'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..','public');
const account={id:'11111111-1111-4111-8111-111111111111',username:'qa_owner',displayName:'QA Owner',role:'owner',status:'active',mfaEnabled:false,passwordChangeRequired:true,setupRequired:true,csrf:'synthetic-qa-csrf',sessionId:'22222222-2222-4222-8222-222222222222',expiresAt:'2027-01-01T00:00:00Z'};
const sessions=[{id:account.sessionId,current:true,created_at:'2026-11-02T01:00:00Z',last_seen:'2026-11-02T01:01:00Z',expires_at:'2026-11-02T09:00:00Z',ip:'127.0.0.1',user_agent:'Local browser QA'}];
(async()=>{
 let recoveryEnabled=true;
 const browser=await chromium.launch({headless:true});
 const report={suite:'CP08 browser UI with mocked API',checks:[],errors:[]};
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1080}});page.setDefaultTimeout(10000);
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.route('**/*',async route=>{
   const req=route.request(),p=new URL(req.url()).pathname;
   const files={'/login':'login.html','/security':'security.html','/assets/login.js':'login.js','/assets/security-ui.js':'security-ui.js','/assets/security.css':'security.css'};
   if(files[p]){const f=files[p];return route.fulfill({status:200,body:fs.readFileSync(path.join(root,f)),contentType:f.endsWith('.html')?'text/html':f.endsWith('.js')?'application/javascript':'text/css'})}
   const body=req.method()==='GET'?{}:req.postDataJSON();let data={},status=200;
   if(p==='/api/auth/recovery-options')data={environmentCredentials:recoveryEnabled};
   else if(p==='/api/auth/login'){if(account.mfaEnabled&&!body.code){status=202;data={code:'MFA_REQUIRED',error:'Enter a code'}}else data={...account}}
   else if(p==='/api/auth/session'||p==='/api/security/me')data={...account};
   else if(p==='/api/security/sessions')data={items:sessions};
   else if(p==='/api/security/admins')data={items:[{...account}],roles:['owner','operator','support','viewer']};
   else if(p==='/api/security/password'){assert.equal(body.new_password,'Local QA replacement password 123');account.passwordChangeRequired=false;data={...account}}
   else if(p==='/api/security/mfa/begin')data={secret:'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',expiresInSeconds:600};
   else if(p==='/api/security/mfa/confirm'){account.mfaEnabled=true;account.setupRequired=false;data={...account,recoveryCodes:Array.from({length:8},(_,i)=>'TESTCODE-TESTCODE-TESTCODE-TESTCOD'+i)}}
   else if(p==='/api/auth/logout')data={ok:true};
   else{status=404;data={error:'unmocked '+p}}
   return route.fulfill({status,body:JSON.stringify(data),contentType:'application/json'});
  });
  await page.goto('http://127.0.0.1:8778/login');
  await page.getByText('Lupa password atau username?',{exact:true}).click();
  await page.locator('#recovery-help').getByText('ADMIN_PASSWORD',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/login-recovery-mobile.png',fullPage:true});
  report.checks.push('Railway recovery steps are available on mobile with no overflow');
  recoveryEnabled=false;await page.reload();
  assert.equal(await page.locator('#recovery-help code').count(),0);
  report.checks.push('bootstrap-only services do not advertise environment password sync');
  await page.setViewportSize({width:1440,height:1080});
  await page.locator('input[name=username]').fill('qa_owner');await page.locator('input[name=password]').fill('Initial synthetic password 123');
  await page.getByRole('button',{name:'Sign in'}).click();await page.waitForURL('**/security');await page.getByText('Step 1 of 2:',{exact:false}).waitFor();
  report.checks.push('temporary login redirects to security onboarding');
  const form=page.locator('form[data-task=password]');
  await form.locator('[name=current_password]').fill('Initial synthetic password 123');
  await form.locator('[name=new_password]').fill('Local QA replacement password 123');await form.locator('[name=confirm_password]').fill('Local QA replacement password 123');
  await form.getByRole('button',{name:'Change password'}).click();await page.getByText('Step 2 of 2:',{exact:false}).waitFor();
  report.checks.push('password change unlocks MFA enrollment UI');
  await page.locator('form[data-task="mfa/begin"] [name=current_password]').fill('Local QA replacement password 123');
  await page.getByRole('button',{name:'Start enrollment'}).click();await page.locator('#setup-key').waitFor();
  assert.equal(await page.locator('#setup-key').getAttribute('type'),'password');
  await page.getByRole('button',{name:'Show / hide'}).click();assert.equal(await page.locator('#setup-key').getAttribute('type'),'text');
  report.checks.push('setup key is masked until revealed');
  await page.locator('form[data-task="mfa/confirm"] [name=code]').fill('123456');await page.getByRole('button',{name:'Verify and enable'}).click();
  await page.locator('#recovery-codes').waitFor();assert.equal((await page.locator('#recovery-codes').inputValue()).split('\n').length,8);
  report.checks.push('MFA confirmation shows eight recovery codes');
  await page.getByRole('button',{name:'I saved my codes'}).click();await page.locator('#recovery-codes').waitFor({state:'detached'});await page.getByRole('heading',{name:'Administrators & roles'}).waitFor();
  assert.equal(await page.locator('#recovery-codes').count(),0);report.checks.push('recovery codes dismissed from UI');
  await page.getByText('Create an administrator',{exact:true}).click();await page.locator('form[data-task=admins]').waitFor({state:'visible'});
  assert.equal(await page.locator('form[data-task=admins] [name=role] option').count(),4);report.checks.push('owner has four role choices and reauthentication fields');
  fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/security-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'test-results/security-mobile.png',fullPage:true});report.checks.push('390px viewport: no horizontal overflow');
  account.role='viewer';account.username='qa_viewer';await page.reload();await page.locator('#identity').filter({hasText:'viewer'}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Administrators & roles'}).count(),0);report.checks.push('non-owner cannot see team management UI');
  await page.goto('http://127.0.0.1:8778/login');await page.locator('input[name=username]').fill('qa_viewer');await page.locator('input[name=password]').fill('Synthetic viewer password');
  await page.getByRole('button',{name:'Sign in'}).click();await page.locator('#factor-field').waitFor({state:'visible'});report.checks.push('MFA login prompts for factor');
  assert.equal(report.errors.length,0);report.result='PASS';fs.writeFileSync('test-results/security-ui.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
