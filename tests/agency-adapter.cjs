'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
module.exports=async({pool,runtime,check,player,A,B,topup,paid,ok,base,gameSecret})=>{
 await check('ACT_ADAPTER','Node/Python signed wallet clients recover redeem responses and reconcile exact central round state',async()=>{
  const p=await player(A,'adapterPlayer');await topup(A.id,1000);await paid(A.id,'adapterPlayer',500);
  const gid=(await pool.query("SELECT id FROM gameops_games WHERE slug='uno-luck'")).rows[0].id;
  const launch=await ok('/api/player/launch','POST',{game_id:gid},'adapterPlayer');
  const client=require('../adapters/agency-wallet.cjs').createAgencyWallet({origin:base,keyId:'qa-uno',secret:gameSecret,allowLocal:true});
  const request=crypto.randomUUID(),session=await client.redeem(launch.token,request);const replay=await client.redeem(launch.token,request);assert.equal(replay.session_id,session.session_id);assert.equal(session.balance,'500');
  await assert.rejects(()=>client.redeem(launch.token,'different-request'),e=>e.status===409);
  const body={tenant_id:A.id,session_id:session.session_id,round_ref:'adapter:'+crypto.randomUUID(),stake:'100',max_payout:'200'};
  const r=await client.reserve(body);assert.equal((await client.reserve(body)).id,r.id);const status=await client.status({...body});assert.equal(status.balance,'400');assert.equal(status.reserved,'100');assert.equal(status.rounds[0].state,'reserved');
  const closed={tenant_id:A.id,round_id:r.id,payout:'150',evidence:'Server outcome fixture, not native game UAT'};await client.settle(closed);await client.settle(closed);assert.equal((await client.status(body)).balance,'550');
  await assert.rejects(()=>client.status({...body,tenant_id:B.id}),e=>e.status===403);
  const {spawn}=require('node:child_process');
  const py=spawn(process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python',['-c',"import sys,json;from adapters.agency_wallet import AgencyWallet;p=json.load(sys.stdin);c=AgencyWallet(p['origin'],p['key'],p['secret'],allow_local=True);print(json.dumps(c.request('status',p['payload'])))"],{cwd:require('node:path').join(__dirname,'..'),stdio:['pipe','pipe','pipe']});
  let output='',error='';py.stdout.on('data',x=>output+=x);py.stderr.on('data',x=>error+=x);py.stdin.end(JSON.stringify({origin:base,key:'qa-uno',secret:gameSecret,payload:body}));const exit=await new Promise(r=>py.once('exit',r));assert.equal(exit,0,error);assert.equal(JSON.parse(output).balance,'550');
  const report=await ok('/api/admin/agency/tenants/'+A.id+'/reconciliation');assert.deepEqual(report.mismatches,[]);assert.equal(report.external_statement_verified,false);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM agency_journals WHERE tenant_id=$1 AND business_id=$2",[A.id,'round-close:'+r.id])).rows[0].n,1);
  return {clients:['Node','Python'],redeemRetry:'same session',roundReserveRetry:'one debit',settleRetry:'one payout',balanceBefore:'500',balanceAfter:'550',nativeGameCertified:false,ledgerDifferences:0};
 });
};
