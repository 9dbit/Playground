'use strict';
const assert=require('node:assert/strict');
module.exports=async({pool,check,runtime,A})=>{
 await check('NATIVE_RELEASE','Sandbox deployment is isolated, audited and cannot undo a later operator maintenance decision',async()=>{
  const {applySandboxReleases}=require('../engine/agency/native-releases');
  const game=(await pool.query("SELECT g.id,g.status,r.* FROM gameops_games g JOIN agency_game_releases r ON r.game_id=g.id WHERE g.slug='uno-luck'")).rows[0];
  const release={game:'uno-luck',environment:'sandbox',version:'a'.repeat(40),launch_url:'https://native.example.test/',evidence:'Isolated synthetic manifest validation; not live certification'};
  const args={pool,schema:'agency_sandbox_qa',configured:runtime.agency.games.configured,releases:[release]};
  await assert.rejects(()=>applySandboxReleases({...args,schema:''}),/isolated sandbox/);
  await assert.rejects(()=>applySandboxReleases({...args,releases:[{...release,environment:'live'}]}),/requires sandbox/);
  await assert.rejects(()=>applySandboxReleases({...args,configured:[]}),/signing key missing/);
  await pool.query("UPDATE agency_tenants SET environment='live' WHERE id=$1",[A.id]);
  try{await assert.rejects(()=>applySandboxReleases(args),/live tenants/);}finally{await pool.query("UPDATE agency_tenants SET environment='sandbox' WHERE id=$1",[A.id]);}
  try{
   await applySandboxReleases(args);
   const active=(await pool.query('SELECT * FROM agency_game_releases WHERE game_id=$1',[game.id])).rows[0];assert.equal(active.version,release.version);assert.equal(active.readiness,'publishable');
   await pool.query("UPDATE gameops_games SET status='Maintenance' WHERE id=$1",[game.id]);
   await pool.query("UPDATE agency_game_releases SET readiness='registered' WHERE game_id=$1",[game.id]);
   await applySandboxReleases(args);
   assert.equal((await pool.query('SELECT status FROM gameops_games WHERE id=$1',[game.id])).rows[0].status,'Maintenance');
   assert.equal((await pool.query('SELECT readiness FROM agency_game_releases WHERE game_id=$1',[game.id])).rows[0].readiness,'registered');
   assert.equal((await pool.query("SELECT count(*)::int n FROM agency_audit WHERE action='game.sandbox.deployed' AND resource=$1",[game.id])).rows[0].n,1);
  }finally{
   await pool.query('UPDATE gameops_games SET status=$2 WHERE id=$1',[game.id,game.status]);
   await pool.query('UPDATE agency_game_releases SET readiness=$2,version=$3,launch_url=$4,evidence=$5 WHERE game_id=$1',[game.id,game.readiness,game.version,game.launch_url,game.evidence]);
  }
  return {sandboxSchemaRequired:true,liveTenantBlocked:true,operatorMaintenancePreserved:true,auditRecords:1};
 });
};
