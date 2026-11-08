'use strict';
// Explicit deployment manifests for isolated sandbox schemas. Applied once per
// source version, so an operator's later Maintenance action survives restarts.
const {audit}=require('./core');
async function applySandboxReleases({pool,schema,configured,releases=[]}){
 if(!Array.isArray(releases))throw Error('Sandbox releases must be an array');
 if(!releases.length)return;
 if(!/^agency_sandbox_[a-z0-9_]{1,40}$/.test(schema||''))throw Error('Native release deployment requires an isolated sandbox schema');
 for(const r of releases){
  let u;try{u=new URL(r.launch_url);}catch{throw Error('Invalid native release URL');}
  if(!/^[a-z0-9-]+$/.test(r.game||'')||!/^[a-f0-9]{40}$/.test(r.version||'')||u.protocol!=='https:'||u.username||u.password||u.hash||u.search||r.environment!=='sandbox'||typeof r.evidence!=='string'||r.evidence.length<20||r.evidence.length>1000)throw Error('Native release requires sandbox, exact source SHA, clean HTTPS URL and evidence');
  if(!configured.some(k=>k.game===r.game&&k.environment==='sandbox'&&k.enabled))throw Error('Native release sandbox signing key missing');
 }
 await pool.query(`CREATE TABLE IF NOT EXISTS agency_native_deployments(game text NOT NULL, version text NOT NULL, manifest jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(game,version))`);
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  // This path cannot activate a game in a database containing live tenants.
  if((await db.query("SELECT id FROM agency_tenants WHERE environment<>'sandbox' LIMIT 1")).rowCount)throw Error('Native release deployment cannot run alongside live tenants');
  for(const r of releases){
   const claim=await db.query('INSERT INTO agency_native_deployments(game,version,manifest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING game',[r.game,r.version,JSON.stringify(r)]);
   if(!claim.rowCount)continue;
   const game=(await db.query('SELECT g.id,r.environment FROM gameops_games g JOIN agency_game_releases r ON r.game_id=g.id WHERE g.slug=$1 FOR UPDATE',[r.game])).rows[0];
   if(!game||game.environment!=='sandbox')throw Error('Only an existing sandbox release can be deployed');
   await db.query("UPDATE agency_game_releases SET readiness='publishable',environment='sandbox',version=$2,launch_url=$3,evidence=$4,updated_at=now() WHERE game_id=$1",[game.id,r.version,r.launch_url,r.evidence]);
   await db.query("UPDATE gameops_games SET status='Active' WHERE id=$1",[game.id]);
   await audit(db,null,'deployment','game.sandbox.deployed',game.id,{source_commit:r.version,launch_url:r.launch_url,evidence:r.evidence});
  }
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
module.exports={applySandboxReleases};
