'use strict';
const assert=require('node:assert/strict'),express=require('express');
module.exports=async({pool,runtime,check,player,A,password,req})=>{
 await check('ACT_EMAIL','Email verification and recovery outbox are durable, encrypted, idempotent and never treat API acceptance as delivery',async()=>{
  const p=await player(A,'emailSubject');const agency=runtime.agency;
  const calls=[];let failOnce=true;
  const email=require('../engine/agency/email').createEmail({pool,agency,origin:'https://qa.invalid',env:{AGENCY_EMAIL_PROVIDER:'resend',AGENCY_EMAIL_FROM:'qa@example.test',AGENCY_RESEND_API_KEY:'synthetic-only'},send:async(payload,key)=>{calls.push({payload,key});if(failOnce){failOnce=false;throw Error('network reset');}return 'qa-mail-id';}});
  const app=express();app.use(express.json());email.mountPublic(app);app.use((req,res,next)=>{req.agency={id:p.id,tenant_id:A.id};next();});email.mount(app);app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const send=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  try{
   assert.equal((await req('/api/player/email/request','POST',{password},'emailSubject')).status,503);
   await pool.query("UPDATE agency_players SET profile='{"+'"email":"verified@example.test"'+"}'::jsonb WHERE id=$1",[p.id]);
   assert.equal((await send('/api/player/email/request',{password:'wrong'})).status,401);
   assert.equal((await send('/api/player/email/request',{password})).status,200);
   assert.equal((await send('/api/player/email/request',{password})).status,429);
   const queued=(await pool.query('SELECT * FROM agency_email_outbox WHERE player_id=$1',[p.id])).rows[0];assert.ok(!queued.payload.includes('verified@example.test'));assert.equal(queued.state,'queued');
   await email.tick();await pool.query('UPDATE agency_email_outbox SET next_attempt_at=now() WHERE id=$1',[queued.id]);await email.tick();assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].payload,calls[1].payload);
   const accepted=(await pool.query('SELECT * FROM agency_email_outbox WHERE id=$1',[queued.id])).rows[0];assert.equal(accepted.state,'accepted');assert.equal(accepted.payload,null);assert.equal(accepted.attempts,2);
   const token=new URL(calls[1].payload.text.match(/https:\/\/\S+/)[0]).hash.slice('#token='.length);
   assert.equal((await send('/api/agency-email/verify',{token})).status,200);assert.equal((await send('/api/agency-email/verify',{token})).status,400);
   const verified=(await pool.query('SELECT * FROM agency_players WHERE id=$1',[p.id])).rows[0];assert.equal(verified.profile.email_verified,true);
   const old=agency.email;agency.email=email;
   try{
    await req('/api/player/auth/recovery','POST',{tenant:A.slug,username:'player_emailsubject'},null);await req('/api/player/auth/recovery','POST',{tenant:A.slug,username:'player_emailsubject'},null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM agency_email_outbox WHERE player_id=$1 AND purpose='recovery'",[p.id])).rows[0].n,1);
   }finally{agency.email=old;}
   await req('/api/player/profile','PUT',{name:'Updated email',email:'new@example.test'},'emailSubject');const changed=(await pool.query('SELECT profile FROM agency_players WHERE id=$1',[p.id])).rows[0].profile;assert.equal(changed.email_verified,false);assert.equal(changed.verified_email,null);
   await pool.query("UPDATE agency_email_outbox SET expires_at=now()-interval '1 second' WHERE player_id=$1 AND purpose='recovery'",[p.id]);await email.tick();assert.equal(calls.length,2);
   assert.equal((await pool.query("SELECT state FROM agency_email_outbox WHERE player_id=$1 AND purpose='recovery'",[p.id])).rows[0].state,'expired');
   return {provider:'mock only; no network delivery',retryKeyStable:true,verificationSingleUse:true,verifiedAddressResetOnChange:true,expiredMailDiscarded:true,acceptedNotDelivered:true};
  }finally{await new Promise(r=>server.close(r));}
 });
};
