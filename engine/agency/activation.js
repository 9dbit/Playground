"use strict";
// Operational capabilities share the agency tenant, session and immutable ledger.
const {wrap}=require('./auth');
const {C,crypto,fail,id,text,amount,asJson,locked,audit,post,move,balance,key,digest}=require('./core');
const ddl=`
CREATE TABLE IF NOT EXISTS agency_preferences(tenant_id uuid PRIMARY KEY REFERENCES agency_tenants(id),version integer NOT NULL DEFAULT 1,settings jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS agency_recovery_tokens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES agency_tenants(id),kind text NOT NULL CHECK(kind IN ('staff','player')),subject_id uuid NOT NULL,token_hash text UNIQUE NOT NULL,auth_version integer NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS agency_recovery_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES agency_tenants(id),kind text NOT NULL,subject_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz);
CREATE TABLE IF NOT EXISTS agency_broadcasts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES agency_tenants(id),request_key text NOT NULL,digest text NOT NULL,title text NOT NULL,body text NOT NULL,recipients integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,request_key));
CREATE TABLE IF NOT EXISTS agency_inbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES agency_tenants(id),player_id uuid NOT NULL REFERENCES agency_players(id),broadcast_id uuid NOT NULL REFERENCES agency_broadcasts(id),read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(broadcast_id,player_id));
CREATE INDEX IF NOT EXISTS agency_inbox_player ON agency_inbox(tenant_id,player_id,created_at DESC);
CREATE TABLE IF NOT EXISTS agency_campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES agency_tenants(id),request_key text NOT NULL,digest text NOT NULL,title text NOT NULL,terms text NOT NULL,reward numeric(38,0) NOT NULL CHECK(reward>0),budget numeric(38,0) NOT NULL CHECK(budget>=reward),min_deposit numeric(38,0) NOT NULL DEFAULT 0 CHECK(min_deposit>=0),eligibility text NOT NULL CHECK(eligibility IN ('all','referred')),state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','closed')),starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,request_key));
CREATE TABLE IF NOT EXISTS agency_reward_claims(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES agency_tenants(id),campaign_id uuid NOT NULL REFERENCES agency_campaigns(id),player_id uuid NOT NULL REFERENCES agency_players(id),amount numeric(38,0) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(campaign_id,player_id));
CREATE TABLE IF NOT EXISTS agency_referral_codes(tenant_id uuid NOT NULL REFERENCES agency_tenants(id),player_id uuid PRIMARY KEY REFERENCES agency_players(id),code text UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS agency_referrals(tenant_id uuid NOT NULL REFERENCES agency_tenants(id),player_id uuid PRIMARY KEY REFERENCES agency_players(id),referrer_id uuid NOT NULL REFERENCES agency_players(id),created_at timestamptz NOT NULL DEFAULT now(),CHECK(player_id<>referrer_id));
`;
const defaults={maintenance:false,maintenance_message:'Website sedang dalam pemeliharaan. Riwayat, bantuan, dan penarikan tetap tersedia.',brand_name:'',logo_url:'',favicon_url:'',accent:'#c62d29',leaderboard:false,referral:false};
function settings(p){
  if(!p||Object.keys(p).some(k=>!(k in defaults)))fail(400,'Pengaturan tidak dikenal');
  const out={...defaults,...p};
  for(const k of ['maintenance','leaderboard','referral'])if(typeof out[k]!=='boolean')fail(400,'Flag tidak valid');
  out.brand_name=String(out.brand_name).trim();if(out.brand_name.length>80)fail(400,'Nama brand maksimal 80 karakter');
  out.maintenance_message=text(out.maintenance_message,500);
  if(!/^#[0-9a-f]{6}$/i.test(out.accent))fail(400,'Warna tidak valid');
  for(const k of ['logo_url','favicon_url']){
    const u=String(out[k]);if(u && !/^\/media\/agency\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.webp$/.test(u))fail(400,'Upload aset brand melalui media agen');out[k]=u;
  }
  return out;
}
function createActivation({pool,agency,security,publicDir}){
  const prefixes=['/api/agency','/api/admin/agency/tenants/:tenant'];
  async function configuration(db,tid){const r=(await db.query('SELECT * FROM agency_preferences WHERE tenant_id=$1',[tid])).rows[0];return {version:r?.version||0,settings:{...defaults,...r?.settings}};}
  async function maintenance(db,tid){if((await configuration(db,tid)).settings.maintenance)fail(503,'Website sedang dalam pemeliharaan. Penarikan dan bantuan tetap tersedia.','TENANT_MAINTENANCE');}
  async function capabilities(db,tid){const c=await configuration(db,tid);const campaigns=(await db.query("SELECT count(*)::int AS n FROM agency_campaigns WHERE tenant_id=$1 AND state='active' AND starts_at<=now() AND ends_at>now()",[tid])).rows[0];return {gateway:'simulation',bonus:campaigns.n>0,referral:c.settings.referral,leaderboard:c.settings.leaderboard,inbox:true,activity:true,email_verification:!!agency.email?.configured,recovery:agency.email?.configured?'verified_email_or_operator':'operator_verified',maintenance:c.settings.maintenance};}
  async function stepup(db,req){
    if(req.agency)return agency.auth.reauth(db,req.agency,req.body);
    const a=(await db.query('SELECT * FROM gameops_admin_accounts WHERE id=$1 FOR UPDATE',[req.auth.id])).rows[0];
    if(!a||a.status!=='active'||a.role!=='owner'||a.auth_version!==req.auth.auth_version)fail(403,'Sesi master tidak valid');
    await security.reauthenticate(db,a,{current_password:req.body.password,code:req.body.code});
  }
  async function registered(db,t,player,p){
    if(!p.referral_code)return;
    if(!(await configuration(db,t.id)).settings.referral)fail(409,'Referral belum diaktifkan');
    const r=(await db.query("SELECT c.player_id FROM agency_referral_codes c JOIN agency_players p ON p.id=c.player_id WHERE c.tenant_id=$1 AND c.code=$2 AND p.status='active'",[t.id,String(p.referral_code)])).rows[0];
    if(!r)fail(400,'Kode referral tidak valid');
    await db.query('INSERT INTO agency_referrals(tenant_id,player_id,referrer_id) VALUES($1,$2,$3)',[t.id,player.id,r.player_id]);
  }
  function mountPublic(app){
    app.get('/agency-recovery',(_req,res)=>res.set('Cache-Control','no-store').set('Referrer-Policy','no-referrer').sendFile(require('node:path').join(publicDir,'agency-recovery.html')));
    app.get('/assets/agency-recovery.js',(_req,res)=>res.sendFile(require('node:path').join(publicDir,'agency-recovery.js')));
    for(const [route,kind] of [['/api/player/auth/recovery','player'],['/api/agency/auth/recovery','staff']])app.post(route,wrap(async(req,res)=>{
      agency.auth.origin(req);await agency.auth.throttle('recovery-request:'+req.ip);
      if(req.agencySite && req.agencySite.slug!==req.body.tenant)fail(403,'Website agen berbeda');
      const table=kind==='staff'?'agency_staff':'agency_players';
      const a=(await pool.query(`SELECT a.id,a.tenant_id FROM ${table} a JOIN agency_tenants t ON t.id=a.tenant_id WHERE t.slug=$1 AND a.username=$2 AND a.status='active'`,[String(req.body.tenant||''),String(req.body.username||'').trim().toLowerCase().slice(0,254)])).rows[0];
      if(a)await pool.query("INSERT INTO agency_recovery_requests(tenant_id,kind,subject_id) SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM agency_recovery_requests WHERE tenant_id=$1 AND kind=$2 AND subject_id=$3 AND resolved_at IS NULL AND created_at>now()-interval '1 day')",[a.tenant_id,kind,a.id]);
      if(a&&kind==='player'&&agency.email?.configured)await locked(pool,a.tenant_id,async db=>{const fresh=(await db.query('SELECT * FROM agency_players WHERE tenant_id=$1 AND id=$2',[a.tenant_id,a.id])).rows[0];await agency.email.requestRecovery(db,fresh);});
      res.json({ok:true,message:agency.email?.configured?'Jika akun cocok dan email sudah diverifikasi, panduan pemulihan dikirim ke email tersebut. Jika tidak, hubungi admin agen untuk verifikasi identitas.':'Jika akun cocok, permintaan tercatat untuk admin agen. Hubungi dukungan untuk verifikasi identitas; tautan reset diberikan setelah verifikasi.'});
    }));
    app.post('/api/agency-recovery/complete',wrap(async(req,res)=>{
      agency.auth.origin(req);await agency.auth.throttle('recovery-complete:'+req.ip);
      if(!C.passwordValid(req.body.password))fail(400,'Password harus 15–128 karakter');
      const hash=C.sha(String(req.body.token||'').slice(0,100));
      const found=(await pool.query('SELECT tenant_id FROM agency_recovery_tokens WHERE token_hash=$1',[hash])).rows[0];
      if(!found)fail(400,'Tautan tidak valid atau kedaluwarsa');
      await locked(pool,found.tenant_id,async(db,t)=>{
        const r=(await db.query('SELECT * FROM agency_recovery_tokens WHERE token_hash=$1 FOR UPDATE',[hash])).rows[0];
        if(r.used_at||new Date(r.expires_at)<=new Date()||!['sandbox','active'].includes(t.status))fail(400,'Tautan tidak valid atau kedaluwarsa');
        const table=r.kind==='staff'?'agency_staff':'agency_players',fk=r.kind==='staff'?'staff_id':'player_id';
        const a=(await db.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[t.id,r.subject_id])).rows[0];
        if(!a||a.status!=='active'||a.auth_version!==r.auth_version)fail(400,'Tautan tidak valid atau kedaluwarsa');
        await db.query(`UPDATE ${table} SET password_hash=$3,auth_version=auth_version+1 WHERE tenant_id=$1 AND id=$2`,[t.id,a.id,await C.passwordHash(req.body.password)]);
        await db.query(`DELETE FROM agency_sessions WHERE tenant_id=$1 AND ${fk}=$2`,[t.id,a.id]);
        await db.query('UPDATE agency_recovery_tokens SET used_at=now() WHERE tenant_id=$1 AND subject_id=$2 AND used_at IS NULL',[t.id,a.id]);
        await db.query('UPDATE agency_recovery_requests SET resolved_at=now() WHERE tenant_id=$1 AND subject_id=$2',[t.id,a.id]);
        await audit(db,t.id,a.id,'account.password_recovered',a.id,{kind:r.kind,sessions_revoked:true});
      });res.json({ok:true,message:'Password diperbarui. Semua sesi lama dicabut. Authenticator yang sudah aktif tetap diperlukan.'});
    }));
    app.use('/api/player',wrap(async(req,_res,next)=>{
      if(req.method==='POST'&&['/auth/register','/deposits','/launch','/rewards/claim'].includes(req.path)){
        const tid=req.agencySite?.id||(await pool.query('SELECT id FROM agency_tenants WHERE slug=$1',[String(req.body?.tenant||'')])).rows[0]?.id;
        if(tid)await maintenance(pool,tid);
      }next();
    }));
  }
  function mount(app){
    app.get('/api/admin/agency/summary',wrap(async(req,res)=>{
      agency.allow(req,'overview');
      // Aggregate each domain separately: joining rounds with payments would multiply totals.
      const tenants=(await pool.query("SELECT id,slug,name,status,environment,currency,coin_scale FROM agency_tenants ORDER BY name")).rows;
      const items=[];for(const t of tenants){const o=await agency.overview(t.id);items.push({...t,counts:o.counts,totals:o.totals,balances:o.balances,exceptions:o.exceptions});}
      res.json({items,notice:'Saldo kasir adalah ledger internal; bukan verifikasi saldo rekening gateway.'});
    }));
    for(const prefix of prefixes){
      app.get(prefix+'/reconciliation',wrap(async(req,res)=>{
        agency.allow(req,'reports');const tid=agency.scope(req);
        const data=await locked(pool,tid,async db=>{
          const mismatches=(await db.query("WITH expected AS (SELECT code,unit,sum(delta) AS amount FROM agency_entries WHERE tenant_id=$1 GROUP BY code,unit) SELECT COALESCE(b.code,e.code) AS code,COALESCE(b.unit,e.unit) AS unit,COALESCE(b.amount,0)::text AS recorded,COALESCE(e.amount,0)::text AS expected FROM (SELECT * FROM agency_balances WHERE tenant_id=$1) b FULL JOIN expected e ON e.code=b.code AND e.unit=b.unit WHERE COALESCE(b.amount,0)<>COALESCE(e.amount,0)",[tid])).rows;
          const pending=(await db.query("SELECT r.id,r.round_ref,r.player_id,g.name AS game,r.stake::text,r.created_at,l.id AS session_id FROM agency_rounds r JOIN gameops_games g ON g.id=r.game_id JOIN agency_launches l ON l.id=r.launch_id AND l.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND r.state='reserved' ORDER BY r.created_at LIMIT 100",[tid])).rows;
          const payments=(await db.query("SELECT id,kind,state,amount::text,created_at FROM agency_transactions WHERE tenant_id=$1 AND state IN ('unknown','payment_received_credit_pending','awaiting_agent_funding') ORDER BY created_at LIMIT 100",[tid])).rows;
          return {mismatches,pending,payments,as_of:new Date().toISOString()};
        });res.json({...data,external_statement_verified:false,notice:'Pemeriksaan internal ledger. Status gateway/bank dan hasil game native masih memerlukan bukti provider; tidak ada auto-credit atau auto-void dari laporan ini.'});
      }));
      app.get(prefix+'/activation',wrap(async(req,res)=>{
        agency.allow(req,'overview');const tid=agency.scope(req),c=await configuration(pool,tid);
        res.json({...c,capabilities:await capabilities(pool,tid),providers:{payment:{status:'unconfigured',reason:'Akun merchant, API secret, callback dan UAT settlement belum tersedia'},email:agency.email?.status()||{status:'unconfigured'},sms:{status:'unconfigured'},kyc:{status:'unconfigured'},oauth:{status:'unconfigured'},chat:{provider:'Chatvice',status:'supported'}},games:(await pool.query('SELECT g.name,r.readiness,r.environment FROM agency_game_releases r JOIN gameops_games g ON g.id=r.game_id ORDER BY g.name')).rows});
      }));
      app.put(prefix+'/activation',wrap(async(req,res)=>{
        agency.allow(req,'website');const tid=agency.scope(req),s=settings(req.body.settings);
        res.json(await locked(pool,tid,async(db,t)=>{
          const c=await configuration(db,tid);if(c.version!==req.body.expected_version)fail(409,'Pengaturan berubah, muat ulang');
          for(const k of ['logo_url','favicon_url'])if(s[k]){if(!s[k].startsWith('/media/agency/'+tid+'/'))fail(400,'Aset milik agen berbeda');if(!(await db.query('SELECT id FROM agency_banner_assets WHERE tenant_id=$1 AND id=$2',[tid,id(s[k].split('/').pop().replace('.webp',''))])).rowCount)fail(400,'Aset belum diupload');}
          await db.query('INSERT INTO agency_preferences(tenant_id,version,settings) VALUES($1,1,$2) ON CONFLICT(tenant_id) DO UPDATE SET version=agency_preferences.version+1,settings=$2,updated_at=now()',[tid,asJson(s)]);
          await audit(db,tid,agency.actor(req).id,'activation.updated',tid,{settings:s});return configuration(db,tid);
        }));
      }));
      app.get(prefix+'/recovery-requests',wrap(async(req,res)=>{
        agency.allow(req,'recovery');res.json({items:(await pool.query("SELECT r.id,r.kind,r.subject_id,r.created_at,r.resolved_at,COALESCE(p.username,s.username) AS username FROM agency_recovery_requests r LEFT JOIN agency_players p ON p.id=r.subject_id AND r.kind='player' LEFT JOIN agency_staff s ON s.id=r.subject_id AND r.kind='staff' WHERE r.tenant_id=$1 ORDER BY r.created_at DESC LIMIT 100",[agency.scope(req)])).rows});
      }));
      app.post(prefix+'/recovery',wrap(async(req,res)=>{
        const p=req.body,kind=p.kind;if(!['staff','player'].includes(kind))fail(400,'Jenis akun tidak valid');
        agency.allow(req,kind==='staff'?'team':'recovery');const tid=agency.scope(req),reason=text(p.reason,500),subject=id(p.subject_id);
        if(p.identity_verified!==true)fail(400,'Verifikasi identitas wajib dicatat sebelum membuat tautan');
        await agency.auth.throttle('recovery-issue:'+agency.actor(req).id);
        const out=await locked(pool,tid,async(db,t)=>{
          await stepup(db,req);const table=kind==='staff'?'agency_staff':'agency_players';
          const a=(await db.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[tid,subject])).rows[0];if(!a||a.status!=='active')fail(404,'Akun aktif tidak ditemukan');
          const token=crypto.randomBytes(32).toString('base64url');
          await db.query('UPDATE agency_recovery_tokens SET used_at=now() WHERE tenant_id=$1 AND subject_id=$2 AND used_at IS NULL',[tid,subject]);
          const r=(await db.query("INSERT INTO agency_recovery_tokens(tenant_id,kind,subject_id,token_hash,auth_version,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes') RETURNING expires_at",[tid,kind,subject,C.sha(token),a.auth_version])).rows[0];
          await audit(db,tid,agency.actor(req).id,'account.recovery_issued',subject,{kind,reason,identity_verified:true});
          return {path:'/agency-recovery#token='+token,expires_at:r.expires_at};
        });res.set('Cache-Control','no-store').json(out);
      }));
      app.get(prefix+'/broadcasts',wrap(async(req,res)=>{agency.allow(req,'broadcast');res.json({items:(await pool.query('SELECT id,title,body,recipients,created_at FROM agency_broadcasts WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[agency.scope(req)])).rows});}));
      app.post(prefix+'/broadcasts',wrap(async(req,res)=>{
        agency.allow(req,'broadcast');const tid=agency.scope(req),p={title:text(req.body.title,150),body:text(req.body.body,4000)},requestKey=key(req.body.idempotency_key);
        res.json(await locked(pool,tid,async db=>{
          const prior=(await db.query('SELECT * FROM agency_broadcasts WHERE tenant_id=$1 AND request_key=$2',[tid,requestKey])).rows[0];
          if(prior){if(prior.digest!==digest(p))fail(409,'Payload idempotensi berubah');return prior;}
          const b=(await db.query('INSERT INTO agency_broadcasts(tenant_id,request_key,digest,title,body) VALUES($1,$2,$3,$4,$5) RETURNING *',[tid,requestKey,digest(p),p.title,p.body])).rows[0];
          const inserted=await db.query("INSERT INTO agency_inbox(tenant_id,player_id,broadcast_id) SELECT $1,id,$2 FROM agency_players WHERE tenant_id=$1 AND status='active'",[tid,b.id]);
          await db.query('UPDATE agency_broadcasts SET recipients=$2 WHERE id=$1',[b.id,inserted.rowCount]);
          await audit(db,tid,agency.actor(req).id,'inbox.broadcast',b.id,{recipients:inserted.rowCount});return {...b,recipients:inserted.rowCount};
        }));
      }));
      app.get(prefix+'/campaigns',wrap(async(req,res)=>{agency.allow(req,'rewards');res.json({items:await campaigns(agency.scope(req))});}));
      app.post(prefix+'/campaigns',wrap(async(req,res)=>{
        agency.allow(req,'rewards');await agency.auth.throttle('campaign:'+agency.actor(req).id);const tid=agency.scope(req),p=req.body,n=amount(p.reward),budget=amount(p.budget),min=amount(p.min_deposit||'0',true),requestKey=key(p.idempotency_key);
        if(budget<n||!['all','referred'].includes(p.eligibility))fail(400,'Anggaran atau kelayakan tidak valid');
        const start=new Date(p.starts_at),end=new Date(p.ends_at);if(!Number.isFinite(+start)||!Number.isFinite(+end)||end<=start||end<=new Date())fail(400,'Periode kampanye tidak valid');
        const body={title:text(p.title,150),terms:text(p.terms,2000),reward:String(n),budget:String(budget),min_deposit:String(min),eligibility:p.eligibility,starts_at:start.toISOString(),ends_at:end.toISOString()};
        res.json(await locked(pool,tid,async db=>{
          const prior=(await db.query('SELECT * FROM agency_campaigns WHERE tenant_id=$1 AND request_key=$2',[tid,requestKey])).rows[0];if(prior){if(prior.digest!==digest(body))fail(409,'Payload idempotensi berubah');return prior;}
          await stepup(db,req);
          const c=(await db.query('INSERT INTO agency_campaigns(tenant_id,request_key,digest,title,terms,reward,budget,min_deposit,eligibility,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[tid,requestKey,digest(body),body.title,body.terms,body.reward,body.budget,body.min_deposit,body.eligibility,body.starts_at,body.ends_at])).rows[0];
          await post(db,tid,'campaign:fund:'+c.id,'reward.fund',agency.actor(req).id,move('stock:available','campaign:'+c.id,budget),{campaign_id:c.id});
          await audit(db,tid,agency.actor(req).id,'campaign.created',c.id,body);return c;
        }));
      }));
      app.post(prefix+'/campaigns/:campaign/close',wrap(async(req,res)=>{
        agency.allow(req,'rewards');await agency.auth.throttle('campaign:'+agency.actor(req).id);const tid=agency.scope(req),cid=id(req.params.campaign);
        res.json(await locked(pool,tid,async db=>{
          const c=(await db.query('SELECT * FROM agency_campaigns WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tid,cid])).rows[0];if(!c)fail(404,'Kampanye tidak ditemukan');if(c.state==='closed')return {ok:true};
          await stepup(db,req);const remaining=await balance(db,tid,'campaign:'+cid);if(remaining)await post(db,tid,'campaign:return:'+cid,'reward.return',agency.actor(req).id,move('campaign:'+cid,'stock:available',remaining),{campaign_id:cid});
          await db.query("UPDATE agency_campaigns SET state='closed' WHERE id=$1",[cid]);await audit(db,tid,agency.actor(req).id,'campaign.closed',cid,{returned:String(remaining)});return {ok:true};
        }));
      }));
    }
    app.post('/api/agency/auth/password',wrap(async(req,res)=>{
      const a=req.agency;if(!C.passwordValid(req.body.new_password))fail(400,'Password baru harus 15–128 karakter');await agency.auth.throttle('password-change:'+a.id);
      await locked(pool,a.tenant_id,async db=>{await stepup(db,req);await db.query('UPDATE agency_staff SET password_hash=$3,auth_version=auth_version+1 WHERE tenant_id=$1 AND id=$2',[a.tenant_id,a.id,await C.passwordHash(req.body.new_password)]);await db.query('DELETE FROM agency_sessions WHERE tenant_id=$1 AND staff_id=$2',[a.tenant_id,a.id]);await audit(db,a.tenant_id,a.id,'staff.password_changed',a.id);});res.json({ok:true});
    }));
    app.get('/api/player/inbox',wrap(async(req,res)=>{const a=req.agency;res.json({items:(await pool.query('SELECT i.id,b.title,b.body,i.read_at,i.created_at FROM agency_inbox i JOIN agency_broadcasts b ON b.id=i.broadcast_id AND b.tenant_id=i.tenant_id WHERE i.tenant_id=$1 AND i.player_id=$2 ORDER BY i.created_at DESC LIMIT 100',[a.tenant_id,a.id])).rows});}));
    app.post('/api/player/inbox/:message/read',wrap(async(req,res)=>{const a=req.agency;await pool.query('UPDATE agency_inbox SET read_at=COALESCE(read_at,now()) WHERE tenant_id=$1 AND player_id=$2 AND id=$3',[a.tenant_id,a.id,id(req.params.message)]);res.json({ok:true});}));
    app.get('/api/player/activity',wrap(async(req,res)=>{const a=req.agency;res.json({items:(await pool.query("SELECT id,action,created_at FROM agency_audit WHERE tenant_id=$1 AND actor=$2 AND action IN ('player.registered','auth.login','player.profile_updated','player.password_changed','account.password_recovered','reward.claimed','player.ticket_created') ORDER BY created_at DESC LIMIT 100",[a.tenant_id,a.id])).rows});}));
    app.get('/api/player/rewards',wrap(async(req,res)=>{res.json({items:await campaigns(req.agency.tenant_id,req.agency.id)});}));
    app.post('/api/player/rewards/claim',wrap(async(req,res)=>{
      const a=req.agency,cid=id(req.body.campaign_id);
      res.json(await locked(pool,a.tenant_id,async(db,t)=>{
        await maintenance(db,t.id);const player=(await db.query('SELECT status FROM agency_players WHERE tenant_id=$1 AND id=$2',[t.id,a.id])).rows[0];if(player.status!=='active'||!['active','sandbox'].includes(t.status))fail(403,'Akun tidak aktif');
        const c=(await db.query('SELECT * FROM agency_campaigns WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[t.id,cid])).rows[0];if(!c)fail(404,'Kampanye tidak ditemukan');
        const prior=(await db.query('SELECT * FROM agency_reward_claims WHERE campaign_id=$1 AND player_id=$2',[cid,a.id])).rows[0];if(prior)return {claim:prior,duplicate:true};
        if(c.state!=='active'||new Date(c.starts_at)>new Date()||new Date(c.ends_at)<=new Date())fail(409,'Kampanye tidak aktif');
        if(c.eligibility==='referred'&&!(await db.query('SELECT player_id FROM agency_referrals WHERE tenant_id=$1 AND player_id=$2',[t.id,a.id])).rowCount)fail(403,'Kampanye khusus pemain referral');
        const deposit=(await db.query("SELECT COALESCE(sum(amount),0)::text AS n FROM agency_transactions WHERE tenant_id=$1 AND player_id=$2 AND kind='deposit' AND state='credited'",[t.id,a.id])).rows[0];if(BigInt(deposit.n)<BigInt(c.min_deposit))fail(409,'Minimum deposit yang dikreditkan belum terpenuhi');
        await post(db,t.id,'reward:'+cid+':'+a.id,'reward.claim',a.id,move('campaign:'+cid,'player:'+a.id+':available',BigInt(c.reward)),{campaign_id:cid,player_id:a.id});
        const claim=(await db.query('INSERT INTO agency_reward_claims(tenant_id,campaign_id,player_id,amount) VALUES($1,$2,$3,$4) RETURNING *',[t.id,cid,a.id,c.reward])).rows[0];await audit(db,t.id,a.id,'reward.claimed',cid);return {claim,duplicate:false};
      }));
    }));
    app.get('/api/player/referral',wrap(async(req,res)=>{
      const a=req.agency;if(!(await configuration(pool,a.tenant_id)).settings.referral)fail(409,'Referral belum diaktifkan');
      const result=await locked(pool,a.tenant_id,async db=>{
        await db.query('INSERT INTO agency_referral_codes(tenant_id,player_id,code) VALUES($1,$2,$3) ON CONFLICT(player_id) DO NOTHING',[a.tenant_id,a.id,crypto.randomBytes(12).toString('hex')]);
        const code=(await db.query('SELECT code FROM agency_referral_codes WHERE tenant_id=$1 AND player_id=$2',[a.tenant_id,a.id])).rows[0].code;
        const counts=(await db.query("SELECT count(*)::int AS invited,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM agency_transactions x WHERE x.tenant_id=$1 AND x.player_id=r.player_id AND x.kind='deposit' AND x.state='credited'))::int AS deposited FROM agency_referrals r WHERE r.tenant_id=$1 AND r.referrer_id=$2",[a.tenant_id,a.id])).rows[0];return {code,...counts,notice:'Pelacakan undangan. Tidak ada komisi otomatis; bonus mengikuti kampanye yang tersedia.'};
      });res.json(result);
    }));
    app.get('/api/player/leaderboard',wrap(async(req,res)=>{
      const a=req.agency;if(!(await configuration(pool,a.tenant_id)).settings.leaderboard)fail(409,'Leaderboard belum diaktifkan');
      const rows=(await pool.query("SELECT player_id,count(*)::int AS rounds,COALESCE(sum(payout-stake),0)::text AS net FROM agency_rounds WHERE tenant_id=$1 AND state='settled' AND settled_at>=date_trunc('month',now()) GROUP BY player_id ORDER BY sum(payout-stake) DESC,player_id LIMIT 20",[a.tenant_id])).rows;
      res.json({period:new Date().toISOString().slice(0,7),metric:'net_player',items:rows.map((r,i)=>({rank:i+1,name:'Player '+C.sha(a.tenant_id+':'+r.player_id).slice(0,8),self:r.player_id===a.id,rounds:r.rounds,net:r.net})),notice:'Ronde settled bulan ini (UTC), tanpa hadiah otomatis.'});
    }));
  }
  async function campaigns(tid,player=null){return (await pool.query(`SELECT c.id,c.title,c.terms,c.reward::text,c.budget::text,c.min_deposit::text,c.eligibility,c.state,c.starts_at,c.ends_at,COALESCE(b.amount,0)::text AS remaining,EXISTS(SELECT 1 FROM agency_reward_claims r WHERE r.campaign_id=c.id AND r.player_id=$2::uuid) AS claimed FROM agency_campaigns c LEFT JOIN agency_balances b ON b.tenant_id=c.tenant_id AND b.code='campaign:'||c.id::text AND b.unit='COIN' WHERE c.tenant_id=$1 ${player?"AND c.state='active' AND c.starts_at<=now() AND c.ends_at>now()":''} ORDER BY c.created_at DESC LIMIT 100`,[tid,player])).rows;}
  return {init:()=>pool.query(ddl),mountPublic,mount,configuration,capabilities,maintenance,registered};
}
module.exports={createActivation,settings};
