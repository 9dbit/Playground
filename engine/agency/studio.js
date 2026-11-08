'use strict';
// Master-owned release intents. Only the signed runtime can validate/report
// deployment; an HTTP acceptance is never presented as an applied release.
const {createHash}=require('node:crypto');
const {fail,id,text,transaction,audit}=require('./core');
const {wrap}=require('./auth');
const SUPPORTED=['mahjong-wild','skygate-5000'];
const hash=s=>createHash('sha256').update(s).digest('hex');
const note=value=>value===undefined||value===null||value===''?'':text(value,500);
const ddl=`
CREATE TABLE IF NOT EXISTS agency_studio_targets(
 game text PRIMARY KEY, generation integer NOT NULL DEFAULT 0, desired uuid,
 observed uuid, observed_sha text, observed_generation integer NOT NULL DEFAULT 0,
 runtime text, seen_at timestamptz, baseline text, error text NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS agency_studio_packages(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game text NOT NULL,
 name text NOT NULL, body text NOT NULL, sha256 text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','validated','rejected')),
 validated_runtime text, error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(game,sha256));`;
function envelope(game,input){
 if(!SUPPORTED.includes(game)||!input||input.format!=='playground.studio.v1'||input.game!==game||!input.payload||Array.isArray(input.payload)||typeof input.payload!=='object')fail(422,'Paket Studio tidak sesuai game');
 if(Object.keys(input).some(k=>!['format','game','name','payload'].includes(k)))fail(422,'Field paket tidak dikenal');
 const value={format:input.format,game,name:text(input.name,120),payload:input.payload};
 if(!value.name.trim())fail(422,'Nama rilis wajib');
 const body=JSON.stringify(value);if(Buffer.byteLength(body)>34*1024*1024)fail(413,'Paket maksimal 34 MB');
 return {body,sha256:hash(body),name:value.name};
}
function createStudio({pool,security,throttle}){
 async function game(db,slug){
  if(!SUPPORTED.includes(slug))fail(404,'Studio game tidak tersedia');
  const g=(await db.query('SELECT r.environment FROM agency_game_releases r JOIN gameops_games g ON g.id=r.game_id WHERE g.slug=$1',[slug])).rows[0];
  if(!g||g.environment!=='sandbox')fail(409,'Rilis Studio ini hanya untuk runtime sandbox');
  await db.query('INSERT INTO agency_studio_targets(game) VALUES($1) ON CONFLICT DO NOTHING',[slug]);
  return (await db.query('SELECT * FROM agency_studio_targets WHERE game=$1 FOR UPDATE',[slug])).rows[0];
 }
 async function sync(p,scope){
  if(scope.environment!=='sandbox')fail(403,'Studio sandbox scope required');
  if(!p||typeof p.runtime!=='string'||!p.runtime||p.runtime.length>100||!Number.isSafeInteger(p.generation)||p.generation<0)fail(422,'Runtime report invalid');
  return transaction(pool,async db=>{
   const t=await game(db,scope.game);
   // Registration is read-only metadata; it cannot activate a release.
   let baseline=null;if(p.baseline&&(!t.baseline||t.runtime!==p.runtime)){const b=envelope(scope.game,p.baseline);if(Buffer.byteLength(b.body)>500000)fail(413,'Baseline too large');baseline=b.body;}
   if(p.receipt){
    const r=p.receipt;
    if(!['validated','rejected'].includes(r.state)||!/^([a-f0-9]{64})$/.test(r.sha256||''))fail(422,'Validation receipt invalid');
    await db.query('UPDATE agency_studio_packages SET state=$4,validated_runtime=$5,error=$6 WHERE id=$1 AND game=$2 AND sha256=$3',[id(r.id),scope.game,r.sha256,r.state,p.runtime,note(r.error)]);
   }
   // A stale/unknown report cannot claim the current generation is applied.
   let observed=t.observed,sha=t.observed_sha,gen=t.observed_generation;
   if(p.generation===t.generation){
    if(p.active===null&&t.desired===null){observed=null;sha=null;gen=p.generation;}
    else if(p.active===t.desired){
     const r=(await db.query('SELECT sha256 FROM agency_studio_packages WHERE id=$1 AND game=$2 AND state=\'validated\'',[id(p.active),scope.game])).rows[0];
     if(r&&r.sha256===p.sha256){observed=p.active;sha=r.sha256;gen=p.generation;}
    }
   }
   await db.query('UPDATE agency_studio_targets SET runtime=$2,seen_at=now(),baseline=coalesce($3,baseline),observed=$4,observed_sha=$5,observed_generation=$6,error=$7 WHERE game=$1',[scope.game,p.runtime,baseline,observed,sha,gen,note(p.error)]);
   if(gen!==t.observed_generation||observed!==t.observed)await audit(db,null,'native:'+scope.game,'studio.applied',observed||'baseline',{generation:gen,sha256:sha,runtime:p.runtime});
   // Desired release gets priority after a runtime restart/lost local cache.
   const desired=t.desired?(await db.query('SELECT id,sha256,body FROM agency_studio_packages WHERE id=$1',[t.desired])).rows[0]:null;
   const candidate=(await db.query("SELECT id,sha256,body FROM agency_studio_packages WHERE game=$1 AND (state='pending' OR (state='validated' AND validated_runtime<>$2)) ORDER BY created_at LIMIT 1",[scope.game,p.runtime])).rows[0]||null;
   return {generation:t.generation,desired:t.desired,apply:desired&&!(p.active===t.desired&&p.sha256===desired.sha256&&p.generation===t.generation)?desired:null,candidate};
  });
 }
 function mount(app){
  const prefix='/api/admin/agency/studio';
  app.get(prefix,wrap(async(req,res)=>res.json({items:(await pool.query('SELECT game,generation,desired,observed,observed_sha,observed_generation,runtime,seen_at,error FROM agency_studio_targets ORDER BY game')).rows})));
  app.get(prefix+'/:game',wrap(async(req,res)=>{
   const out=await transaction(pool,async db=>{const t=await game(db,req.params.game);const packages=(await db.query('SELECT id,name,sha256,state,validated_runtime,error,created_at FROM agency_studio_packages WHERE game=$1 ORDER BY created_at DESC',[req.params.game])).rows;delete t.baseline;return {target:t,packages};});res.json(out);
  }));
  app.get(prefix+'/:game/package/:release',wrap(async(req,res)=>{
   const {game:g,release}=req.params;if(!SUPPORTED.includes(g))fail(404,'Game tidak tersedia');
   const row=release==='baseline'?(await pool.query('SELECT baseline AS body FROM agency_studio_targets WHERE game=$1',[g])).rows[0]:(await pool.query('SELECT body FROM agency_studio_packages WHERE id=$1 AND game=$2',[id(release),g])).rows[0];
   if(!row?.body)fail(404,'Paket belum tersedia; tunggu runtime terhubung');res.type('json').send(row.body);
  }));
  app.post(prefix+'/:game/packages',wrap(async(req,res)=>{
   const packed=envelope(req.params.game,req.body);
   const result=await transaction(pool,async db=>{await game(db,req.params.game);
    const prior=(await db.query('SELECT id FROM agency_studio_packages WHERE game=$1 AND sha256=$2',[req.params.game,packed.sha256])).rows[0];if(prior)return prior;
    const quota=(await db.query('SELECT count(*)::int AS n,coalesce(sum(octet_length(body)),0)::text AS bytes FROM agency_studio_packages WHERE game=$1',[req.params.game])).rows[0];
    if(quota.n>=24||Number(quota.bytes)+Buffer.byteLength(packed.body)>350*1024*1024)fail(409,'Arsip rilis penuh; ekspor cadangan sebelum pemeliharaan');
    const r=(await db.query('INSERT INTO agency_studio_packages(game,name,body,sha256) VALUES($1,$2,$3,$4) RETURNING id',[req.params.game,packed.name,packed.body,packed.sha256])).rows[0];
    await audit(db,null,req.auth.id,'studio.staged',r.id,{game:req.params.game,sha256:packed.sha256});return r;
   });res.status(201).json(result);
  }));
  app.post(prefix+'/:game/activate',wrap(async(req,res)=>{
   await throttle('studio:'+req.auth.id);
   const result=await transaction(pool,async db=>{
    const t=await game(db,req.params.game),p=req.body;
    if(!Number.isSafeInteger(p.expected_generation)||p.expected_generation!==t.generation)fail(409,'Versi berubah. Refresh sebelum menerbitkan');
    if(!t.seen_at||Date.now()-new Date(t.seen_at)>90000)fail(409,'Runtime belum terhubung. Tunggu koneksi pulih');
    if(typeof p.reason!=='string'||!p.reason.trim()||p.reason.length>500)fail(422,'Alasan penerbitan/rollback wajib');
    const account=(await db.query('SELECT * FROM gameops_admin_accounts WHERE id=$1 FOR UPDATE',[req.auth.id])).rows[0];
    if(!account||account.role!=='owner'||account.status!=='active'||account.auth_version!==req.auth.auth_version)fail(403,'Master owner required');
    await security.reauthenticate(db,account,p);
    const desired=p.release===null?null:id(p.release);
    if(desired){const r=(await db.query('SELECT * FROM agency_studio_packages WHERE id=$1 AND game=$2',[desired,req.params.game])).rows[0];if(!r||r.state!=='validated'||r.validated_runtime!==t.runtime)fail(409,'Rilis belum divalidasi oleh runtime yang berjalan');}
    if(desired===t.desired)return {generation:t.generation,desired};
    await db.query('UPDATE agency_studio_targets SET desired=$2,generation=generation+1,error=\'\' WHERE game=$1',[req.params.game,desired]);
    await audit(db,null,req.auth.id,'studio.activation.requested',desired||'baseline',{game:req.params.game,previous:t.desired,reason:p.reason,generation:t.generation+1});
    return {generation:t.generation+1,desired};
   });res.json(result);
  }));
 }
 return {init:()=>pool.query(ddl),mount,sync};
}
module.exports={createStudio,envelope};
