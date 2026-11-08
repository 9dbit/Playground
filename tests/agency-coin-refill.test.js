'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createCoinRefill}=require('../engine/agency/coin-refill');
const {windowQuery,csv}=require('../engine/agency/report-window');
const {createBusinessReports}=require('../engine/agency/business-reports');
const {ddl}=require('../engine/agency/schema');
const {defaults,locked,post,move,balance}=require('../engine/agency/core');
test('report dates reject invalid input and CSV protects spreadsheet formulas',()=>{
  assert.throws(()=>windowQuery({from:'2026-02-30'}));assert.throws(()=>windowQuery({from:'2026-11-09',to:'2026-11-08'}));
  assert.throws(()=>windowQuery({sort:'desc;drop table'}));assert.throws(()=>windowQuery({offset:-1}));
  assert.equal(windowQuery({period:'weekly'}).timezone,'Asia/Jakarta');assert.match(csv([{name:'=1+1'}],['name']),/'=1\+1/);
});
test('coin lifecycle, authorized refill, reporting and rollback with isolated database',{timeout:120000},async t=>{
  let pool,root,schema;
  if(process.env.TEST_DATABASE_URL){const {Pool}=require('pg');root=new Pool({connectionString:process.env.TEST_DATABASE_URL});schema='coin_qa_'+crypto.randomBytes(8).toString('hex');await root.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});}
  else pool=new(require('./helpers/pglite-pool.cjs').Pool)();
  t.after(async()=>{await pool.end();if(root){await root.query('DROP SCHEMA '+schema+' CASCADE');await root.end();}});
  await pool.query(`CREATE TABLE gameops_games(id uuid PRIMARY KEY,name text,slug text);
    CREATE TABLE gameops_admin_accounts(id uuid PRIMARY KEY,role text,status text,auth_version integer);
    CREATE TABLE agency_preferences(tenant_id uuid PRIMARY KEY,settings jsonb);`);
  await pool.query(ddl);
  const A=crypto.randomUUID(),B=crypto.randomUUID(),M=crypto.randomUUID(),P=crypto.randomUUID();
  for(const [id,slug] of [[A,'alpha'],[B,'bravo']])await pool.query("INSERT INTO agency_tenants(id,slug,name,policy) VALUES($1,$2,$2,$3)",[id,slug,JSON.stringify(defaults())]);
  await pool.query("INSERT INTO gameops_admin_accounts VALUES($1,'owner','active',1)",[M]);
  const actor={id:M,kind:'master'},req={auth:{id:M,auth_version:1}},staff={agency:{id:'qa-finance',kind:'staff',role:'finance',tenant_id:B}};
  let reauth=0;
  // Credential verification itself is covered by security integration tests.
  const coin=createCoinRefill({pool,security:{reauthenticate:async()=>{reauth++;}}});await coin.init();await coin.init();
  let allocation;
  await t.test('duplicate requests and approvals each have one durable effect',async()=>{
    await assert.rejects(coin.request(A,actor,{amount:'100',reason:'test'}),e=>e.status===400);
    const payload={amount:'100',reason:'QA coin',idempotency_key:'same-request-001'};
    const pair=await Promise.all([coin.request(A,actor,payload),coin.request(A,actor,payload)]);allocation=pair[0];assert.equal(pair[0].id,pair[1].id);
    await assert.rejects(coin.request(A,actor,{...payload,amount:'101'}),e=>e.status===409);
    const reviewed=await Promise.all([coin.review(A,allocation.id,actor,{decision:'approve'}),coin.review(A,allocation.id,actor,{decision:'approve'})]);
    assert.equal(reviewed.filter(x=>x.duplicate).length,1);assert.equal(await balance(pool,A,'stock:available'),100n);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agency_journals WHERE tenant_id=$1',[A])).rows[0].n,1);
    assert.equal(reviewed[0].item.balance_before,'0');assert.equal(reviewed[0].item.balance_after,'100');assert.ok(reviewed[0].item.credited_at);
    await assert.rejects(coin.review(A,allocation.id,actor,{decision:'reject',reason:'different'}),e=>e.status===409);
    await assert.rejects(coin.review(B,allocation.id,actor,{decision:'approve'}),e=>e.status===404);
    assert.equal((await coin.read(B)).items.length,0);
  });
  await t.test('audit failure rolls back credit and review state together',async()=>{
    const r=await coin.request(A,actor,{amount:'20',reason:'rollback',idempotency_key:'rollback-request'});
    await pool.query("ALTER TABLE agency_audit ADD CONSTRAINT coin_test_reject CHECK(action<>'allocation.reviewed') NOT VALID");
    await assert.rejects(coin.review(A,r.id,actor,{decision:'approve'}));assert.equal(await balance(pool,A,'stock:available'),100n);
    assert.equal((await pool.query('SELECT status FROM agency_allocations WHERE id=$1',[r.id])).rows[0].status,'requested');
    await pool.query('ALTER TABLE agency_audit DROP CONSTRAINT coin_test_reject');
    await assert.rejects(coin.review(A,r.id,actor,{decision:'reject'}),e=>e.status===400);
    await coin.review(A,r.id,actor,{decision:'reject',reason:'No longer needed'});
  });
  const config=(mode,version=0)=>({mode,version,threshold:'0',daily_limit:'100000000',monthly_limit:'300000000'});
  await t.test('agent can automate requests; only authenticated master can authorize credit',async()=>{
    await assert.rejects(coin.save(staff,B,config('auto')),e=>e.status===403);
    await coin.save(staff,B,config('request'));assert.equal(reauth,0);
    await assert.rejects(coin.save(staff,B,config('off')),e=>e.status===409);
    const outcomes=await Promise.all([coin.tickTenant(B),coin.tickTenant(B)]);assert.ok(outcomes.includes('requested'));assert.ok(outcomes.includes('pending_request'));
    assert.equal(await balance(pool,B,'stock:available'),0n);assert.equal((await coin.read(B)).items.length,1);
    const pending=(await coin.read(B)).items[0];await coin.review(B,pending.id,actor,{decision:'reject',reason:'Pause demo'});
    assert.equal(await coin.tickTenant(B),'recent_rejection');
    await pool.query("UPDATE agency_allocations SET reviewed_at=now()-interval '25 hours' WHERE id=$1",[pending.id]);
    await coin.save(req,B,config('auto',1));assert.equal(reauth,1);
    const outcomes2=await Promise.all([coin.tickTenant(B),coin.tickTenant(B)]);assert.equal(outcomes2.filter(x=>x==='refilled').length,1);assert.equal(await balance(pool,B,'stock:available'),100000000n);
  });
  async function consume(){await locked(pool,B,async db=>{const n=await balance(db,B,'stock:available');if(n)await post(db,B,'qa-consume:'+crypto.randomUUID(),'qa.consume','qa',move('stock:available','external:qa',n));});}
  await t.test('daily limits, pause and revoked standing authorization prevent credit',async()=>{
    await consume();assert.equal(await coin.tickTenant(B),'daily_limit');
    await coin.save(req,B,{...config('auto',2),daily_limit:'300000000'});
    await pool.query("INSERT INTO agency_preferences VALUES($1,'{\"maintenance\":true}')",[B]);assert.equal(await coin.tickTenant(B),'tenant_paused');
    await pool.query("UPDATE agency_preferences SET settings='{}' WHERE tenant_id=$1",[B]);
    await pool.query('UPDATE gameops_admin_accounts SET auth_version=2 WHERE id=$1',[M]);assert.equal(await coin.tickTenant(B),'approval_inactive');
    await pool.query('UPDATE gameops_admin_accounts SET auth_version=1 WHERE id=$1',[M]);
    assert.equal(await coin.tickTenant(B),'refilled');await consume();assert.equal(await coin.tickTenant(B),'refilled');await consume();assert.equal(await coin.tickTenant(B),'daily_limit');
    await pool.query("UPDATE agency_allocations SET created_at=now()-interval '1 day' WHERE tenant_id=$1 AND status='approved'",[B]);
    // Keep the same month deterministically for the monthly ceiling test.
    await pool.query("UPDATE agency_coin_refill SET daily_limit=400000000,monthly_limit=100000000 WHERE tenant_id=$1",[B]);
    const earlier=(await pool.query("SELECT date_trunc('month',now())=date_trunc('month',now()-interval '1 day') AS same")).rows[0].same;
    if(earlier)assert.equal(await coin.tickTenant(B),'monthly_limit');
    await pool.query("UPDATE agency_tenants SET environment='live' WHERE id=$1",[B]);assert.equal(await coin.tickTenant(B),'tenant_paused');
    await assert.rejects(coin.request(B,actor,{amount:'1',reason:'live refusal',idempotency_key:'live-refusal-01'}),e=>e.status===409);
  });
  await t.test('WIB date boundaries include the complete end date, retain actor/timestamps and separate tenants',async()=>{
    await pool.query("UPDATE agency_allocations SET created_at='2026-11-07 17:00:00+00' WHERE id=$1",[allocation.id]);
    assert.equal((await coin.read(A,{from:'2026-11-08',to:'2026-11-08'})).items.some(x=>x.id===allocation.id),true);
    assert.equal((await coin.read(A,{to:'2026-11-07'})).items.some(x=>x.id===allocation.id),false);
    assert.match(await coin.read(A,{},true),/balance_before/);
    const r=await coin.read(A,{status:'approved',period:'weekly'});assert.equal(r.items.length,1);assert.equal(r.totals[0].approved,'100');
  });
  await t.test('transaction and cashflow filters are tenant-scoped and money remains decimal text',async()=>{
    const reports=createBusinessReports({pool});
    await pool.query("INSERT INTO agency_players(id,tenant_id,username,password_hash,display_name) VALUES($1,$2,'qa_player','fixture','QA')",[P,A]);
    for(const [time,ref] of [['2026-11-07 16:59:59+00','before'],['2026-11-07 17:00:00+00','inside'],['2026-11-08 17:00:00+00','after']]){
      await pool.query("INSERT INTO agency_transactions(tenant_id,player_id,kind,method,amount,coins,state,request_key,request_digest,account_ref,account_version,policy_version,created_by,created_at) VALUES($1,$2,'deposit','manual',100,100,'pending',$3,'fixture','fixture',1,1,'qa',$4)",[A,P,ref,time]);
    }
    const r=await reports.transactions(A,{from:'2026-11-08',to:'2026-11-08',search:'qa_player',kind:'deposit',state:'pending'});assert.equal(r.items.length,1);assert.equal(r.items[0].request_key,'inside');
    assert.equal((await reports.transactions(B)).items.length,0);assert.equal((await reports.transactions(A,{search:'qa%'})).items.length,0);
    const report=await reports.report(A,{period:'monthly'});assert.deepEqual(report.items,[]);assert.deepEqual(report.cashflow,[]);
    assert.match(await reports.transactions(A,{},true),/username/);
  });
});
