'use strict';
const {wrap}=require('./auth');
const {C,crypto,fail,locked,audit,asJson,transaction,agentEmail}=require('./core');
const ddl=`CREATE TABLE IF NOT EXISTS agency_email_tokens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES agency_tenants(id),player_id uuid NOT NULL REFERENCES agency_players(id),email text NOT NULL,token_hash text UNIQUE NOT NULL,auth_version integer NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz);
CREATE TABLE IF NOT EXISTS agency_email_outbox(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES agency_tenants(id),player_id uuid NOT NULL REFERENCES agency_players(id),purpose text NOT NULL,payload text,state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','accepted','failed','expired')),attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,expires_at timestamptz NOT NULL,provider_id text,last_error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());`;
function createEmail({pool,agency,origin,env=process.env,send}){
 const provider=env.AGENCY_EMAIL_PROVIDER||'',from=env.AGENCY_EMAIL_FROM||'',secret=env.AGENCY_RESEND_API_KEY||'';
 const configured=provider==='resend'&&!!from&&!!secret&&/^https:\/\//.test(origin);
 const status=()=>({provider:provider||null,status:configured?'configured':'unconfigured',reason:configured?'Antrean email aktif; accepted berarti diterima provider, belum membuktikan terkirim ke inbox.':'Atur AGENCY_EMAIL_PROVIDER=resend, AGENCY_EMAIL_FROM (domain terverifikasi), AGENCY_RESEND_API_KEY, dan PUBLIC_SITE_URL HTTPS di service Playground.'});
 const deliver=send||(async(payload,key)=>{
   const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000),redirect:'error'});
   if(!r.ok){const e=Error('EMAIL_PROVIDER_'+r.status);e.retryable=r.status===429||r.status>=500;throw e;}
   const result=await r.json();if(typeof result.id!=='string')throw Error('EMAIL_INVALID_RESPONSE');return result.id;
 });
 async function enqueue(db,tid,pid,purpose,email,path){
   if(!configured)fail(503,'Pengiriman email belum dikonfigurasi');
   const job=crypto.randomUUID();const payload={from,to:[email],subject:purpose==='verify'?'Verifikasi email Playground':'Pemulihan password Playground',text:`Permintaan ${purpose==='verify'?'verifikasi email':'pemulihan password'} untuk akun Anda. Tautan berlaku 15 menit dan hanya bisa digunakan sekali:\n\n${new URL(path,origin).href}\n\nAbaikan jika Anda tidak mengajukan permintaan ini.`};
   await db.query("INSERT INTO agency_email_outbox(id,tenant_id,player_id,purpose,payload,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes')",[job,tid,pid,purpose,agency.auth.vault.seal(JSON.stringify(payload),job)]);
 }
 async function requestRecovery(db,a){
   if(!configured||!a.profile?.email_verified||!a.profile.verified_email||a.profile.email!==a.profile.verified_email)return false;
   const token=crypto.randomBytes(32).toString('base64url');
   // Keep a recent valid request intact; repeated anonymous requests cannot invalidate its email link.
   if((await db.query("SELECT id FROM agency_recovery_tokens WHERE tenant_id=$1 AND subject_id=$2 AND kind='player' AND used_at IS NULL AND expires_at>now()",[a.tenant_id,a.id])).rowCount)return true;
   await db.query("INSERT INTO agency_recovery_tokens(tenant_id,kind,subject_id,token_hash,auth_version,expires_at) VALUES($1,'player',$2,$3,$4,now()+interval '15 minutes')",[a.tenant_id,a.id,C.sha(token),a.auth_version]);
   await enqueue(db,a.tenant_id,a.id,'recovery',a.profile.verified_email,'/agency-recovery#token='+token);return true;
 }
 async function tick(){
   if(!configured)return {processed:0};
   await pool.query("UPDATE agency_email_outbox SET state='expired',payload=NULL,updated_at=now() WHERE state IN ('queued','sending') AND expires_at<=now()");
   const job=await transaction(pool,async db=>{
     const j=(await db.query("SELECT * FROM agency_email_outbox WHERE expires_at>now() AND ((state='queued' AND next_attempt_at<=now()) OR (state='sending' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
     if(!j)return null;await db.query("UPDATE agency_email_outbox SET state='sending',attempts=attempts+1,lease_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1",[j.id]);return j;
   });if(!job)return {processed:0};
   try{const result=await deliver(JSON.parse(agency.auth.vault.open(job.payload,job.id)),'agency-email/'+job.id);await pool.query("UPDATE agency_email_outbox SET state='accepted',provider_id=$2,payload=NULL,last_error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,result]);}
   catch(e){const retry=e.retryable!==false&&job.attempts<4;await pool.query("UPDATE agency_email_outbox SET state=$2,last_error=$3,lease_until=NULL,next_attempt_at=now()+interval '60 seconds',payload=CASE WHEN $2='failed' THEN NULL ELSE payload END,updated_at=now() WHERE id=$1",[job.id,retry?'queued':'failed',/^EMAIL_PROVIDER_\d+$/.test(e.message)?e.message:'EMAIL_DELIVERY_UNCERTAIN']);}
   return {processed:1};
 }
 function mountPublic(app){
   app.get('/agency-email',(_req,res)=>res.set('Cache-Control','no-store').set('Referrer-Policy','no-referrer').sendFile(require('node:path').join(__dirname,'../../public/agency-email.html')));
   app.get('/assets/agency-email.js',(_req,res)=>res.sendFile(require('node:path').join(__dirname,'../../public/agency-email.js')));
   app.post('/api/agency-email/verify',wrap(async(req,res)=>{
     agency.auth.origin(req);await agency.auth.throttle('email-verify:'+req.ip);const hash=C.sha(String(req.body.token||'').slice(0,100));
     const found=(await pool.query('SELECT tenant_id FROM agency_email_tokens WHERE token_hash=$1',[hash])).rows[0];if(!found)fail(400,'Tautan tidak valid atau kedaluwarsa');
     await locked(pool,found.tenant_id,async(db,t)=>{
       const token=(await db.query('SELECT * FROM agency_email_tokens WHERE token_hash=$1 FOR UPDATE',[hash])).rows[0];
       const p=(await db.query('SELECT * FROM agency_players WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[t.id,token.player_id])).rows[0];
       if(token.used_at||new Date(token.expires_at)<=new Date()||p.auth_version!==token.auth_version||p.status!=='active'||p.profile.email!==token.email)fail(400,'Tautan tidak valid atau kedaluwarsa');
       await db.query('UPDATE agency_players SET profile=profile||$3::jsonb WHERE tenant_id=$1 AND id=$2',[t.id,p.id,asJson({email_verified:true,verified_email:token.email,email_verified_at:new Date().toISOString()})]);
       await db.query('UPDATE agency_email_tokens SET used_at=now() WHERE tenant_id=$1 AND player_id=$2 AND used_at IS NULL',[t.id,p.id]);await audit(db,t.id,p.id,'player.email_verified',p.id);
     });res.json({ok:true,message:'Email berhasil diverifikasi. Anda bisa kembali ke website agen.'});
   }));
 }
 function mount(app){
   app.post('/api/player/email/request',wrap(async(req,res)=>{
     if(!configured)fail(503,'Pengiriman email belum dikonfigurasi');const a=req.agency;await agency.auth.throttle('email-request:'+a.id);
     await locked(pool,a.tenant_id,async db=>{
       const p=(await db.query('SELECT * FROM agency_players WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenant_id,a.id])).rows[0];if(p.status!=='active'||!await C.passwordVerify(req.body.password,p.password_hash))fail(401,'Password tidak cocok');
       const email=agentEmail(p.profile.email);if(p.profile.email_verified&&p.profile.verified_email===email)return;
       if((await db.query("SELECT id FROM agency_email_tokens WHERE tenant_id=$1 AND player_id=$2 AND used_at IS NULL AND expires_at>now() AND email=$3",[a.tenant_id,a.id,email])).rowCount)fail(429,'Verifikasi sudah diminta. Periksa email atau tunggu 15 menit.');
       const token=crypto.randomBytes(32).toString('base64url');await db.query('UPDATE agency_email_tokens SET used_at=now() WHERE tenant_id=$1 AND player_id=$2 AND used_at IS NULL',[a.tenant_id,a.id]);
       await db.query("INSERT INTO agency_email_tokens(tenant_id,player_id,email,token_hash,auth_version,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes')",[a.tenant_id,a.id,email,C.sha(token),p.auth_version]);
       await enqueue(db,a.tenant_id,a.id,'verify',email,'/agency-email#token='+token);await audit(db,a.tenant_id,a.id,'player.email_verification_requested',a.id);
     });res.json({ok:true,message:'Email verifikasi masuk antrean. Tautan berlaku 15 menit.'});
   }));
   for(const prefix of ['/api/agency','/api/admin/agency/tenants/:tenant'])app.get(prefix+'/email-delivery',wrap(async(req,res)=>{
     agency.allow(req,'recovery');res.json({provider:status(),items:(await pool.query('SELECT id,purpose,state,attempts,provider_id,last_error,created_at,updated_at FROM agency_email_outbox WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[agency.scope(req)])).rows});
   }));
 }
 function start(){if(!configured)return ()=>{};let running=false;const timer=setInterval(async()=>{if(running)return;running=true;try{await tick();}catch{console.error('[agency-email] WORKER_FAILED');}finally{running=false;}},5000);timer.unref();return ()=>clearInterval(timer);}
 return {init:()=>pool.query(ddl),mountPublic,mount,tick,start,status,configured,requestRecovery};
}
module.exports={createEmail};
