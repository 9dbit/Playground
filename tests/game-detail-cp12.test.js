'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Pool}=require('pg');
const express=require('express');
const deep=require('../engine/deep-routes');
const {canAccess}=require('../engine/security-policy');

test('Checkpoint 12 game detail permissions retain role protection',()=>{
 const gid='10000000-0000-4000-8000-000000000001';
 assert.equal(canAccess('viewer','GET','/deep/games/'+gid+'/rounds'),true);
 assert.equal(canAccess('viewer','PUT','/deep/games/'+gid),false);
 assert.equal(canAccess('operator','PUT','/deep/games/'+gid),true);
 assert.equal(canAccess('support','GET','/deep/players/'+gid+'/rounds'),true);
 assert.equal(canAccess('viewer','GET','/deep/players/'+gid+'/rounds'),false);
});

test('Checkpoint 12: legacy schema migration, edit persistence and scoped observed round logs',{
 skip:!process.env.TEST_DATABASE_URL,timeout:120000},async t=>{
 const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const schema='cp12_game_'+crypto.randomBytes(8).toString('hex');
 await admin.query('CREATE SCHEMA '+schema);
 const url=new URL(process.env.TEST_DATABASE_URL);
 url.searchParams.set('options','-c search_path='+schema+',public');
 const db=new Pool({connectionString:url.toString()});
 let srv;
 t.after(async()=>{
  if(srv)await new Promise(resolve=>srv.close(resolve));
  await db.end();
  await admin.query('DROP SCHEMA '+schema+' CASCADE');
  await admin.end();
 });
 const ddl=[
  "CREATE TABLE gameops_games(id uuid PRIMARY KEY,name text NOT NULL,slug text NOT NULL,code text NOT NULL,platform text NOT NULL,version text NOT NULL DEFAULT '0.1.0',status text NOT NULL DEFAULT 'Active',rounds bigint NOT NULL DEFAULT 0,updated_at timestamptz DEFAULT now())",
  "CREATE TABLE gameops_players(id uuid PRIMARY KEY,game_id uuid NOT NULL REFERENCES gameops_games(id),player_ref text NOT NULL,rounds bigint NOT NULL DEFAULT 0,last_seen timestamptz DEFAULT now(),UNIQUE(game_id,player_ref))",
  "CREATE TABLE gameops_events(id bigserial PRIMARY KEY,event_id text NOT NULL UNIQUE,round_id text NOT NULL,game_id uuid NOT NULL REFERENCES gameops_games(id),player_ref text NOT NULL,stake bigint NOT NULL,payout bigint NOT NULL,currency text NOT NULL DEFAULT 'DEMO_COIN',occurred_at timestamptz NOT NULL DEFAULT now(),ingested_at timestamptz NOT NULL DEFAULT now())",
  "CREATE TABLE gameops_tickets(id uuid PRIMARY KEY,subject text NOT NULL,requester_ref text NOT NULL,status text NOT NULL DEFAULT 'Open')",
  "CREATE TABLE gameops_audit(id bigserial PRIMARY KEY,actor text NOT NULL,action text NOT NULL,resource text NOT NULL,details jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz DEFAULT now())",
  "CREATE TABLE gameops_game_profiles(game_id uuid PRIMARY KEY REFERENCES gameops_games(id),demo_chance integer NOT NULL DEFAULT 50,invest_enabled boolean NOT NULL DEFAULT false,min_invest integer NOT NULL DEFAULT 1,max_invest integer NOT NULL DEFAULT 1000,trending boolean NOT NULL DEFAULT false,featured boolean NOT NULL DEFAULT false,instructions text NOT NULL DEFAULT '',image_bytes bytea,image_mime text,version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now())"
 ];
 for(const sql of ddl)await db.query(sql);
 await deep.ensureSchema(db);
 await deep.ensureSchema(db);
 const game='10000000-0000-4000-8000-000000000001',
       other='10000000-0000-4000-8000-000000000002',
       p1='20000000-0000-4000-8000-000000000001',
       p2='20000000-0000-4000-8000-000000000002',
       p3='20000000-0000-4000-8000-000000000003';
 await db.query('INSERT INTO gameops_games(id,name,slug,code,platform) VALUES($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)',
  [game,'QA Primary Game','qa-primary','QA','Web',other,'QA Other Game','qa-other','Q2','Web']);
 await db.query('INSERT INTO gameops_players(id,game_id,player_ref) VALUES($1,$2,$3),($4,$5,$6),($7,$8,$9)',
  [p1,game,'qa-player-A',p2,game,'qa-player-B',p3,other,'qa-external']);
 for(let i=1;i<=57;i++){
  const kind=i%3,payout=kind===0?200:kind===1?50:100;
  await db.query("INSERT INTO gameops_events(event_id,round_id,game_id,player_ref,stake,payout) VALUES($1,$2,$3,$4,100,$5)",
    ['evt-'+String(i).padStart(3,'0'),'r-'+String(i).padStart(3,'0'),game,i%2?'qa-player-A':'qa-player-B',payout]);
 }
 await db.query("INSERT INTO gameops_events(event_id,round_id,game_id,player_ref,stake,payout) VALUES('private-other','other-001',$1,'qa-external',100,500)",[other]);
 const app=express();app.use(express.json());
 deep.mount(app,{pool:db,audit:async(action,resource,details={})=>{
  await db.query("INSERT INTO gameops_audit(actor,action,resource,details) VALUES('qa_owner',$1,$2,$3)",[action,resource,JSON.stringify(details)]);
 }});
 app.use((err,req,res,next)=>res.status(500).json({error:err.message}));
 srv=await new Promise(resolve=>{const x=app.listen(0,'127.0.0.1',()=>resolve(x))});
 const base='http://127.0.0.1:'+srv.address().port;
 async function request(route,method='GET',body){
  const res=await fetch(base+'/api/admin/deep/'+route,{method,headers:{'Content-Type':'application/json'},
   ...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const data=await res.json();
  return {status:res.status,data};
 }
 const before=await request('games/'+game);
 assert.equal(before.status,200);
 assert.equal(before.data.item.winning_chance,50);
 assert.equal(before.data.item.win_amount,50);
 const config={name:'QA Primary Game Revised',code:'QA',platform:'Web',demo_chance:20,
  winning_chance:65,win_amount:35,invest_enabled:true,min_invest:1,max_invest:1000,
  trending:true,featured:true,instructions:'Only demo metadata. No external payout change.',version:1};
 const changed=await request('games/'+game,'PUT',config);
 assert.equal(changed.status,200);
 assert.equal(changed.data.version,2);
 assert.equal(changed.data.externalEngineAffected,false);
 const after=await request('games/'+game);
 assert.equal(after.data.item.winning_chance,65);
 assert.equal(after.data.item.win_amount,35);
 assert.equal(after.data.item.demo_chance,20);
 assert.equal(after.data.item.instructions,config.instructions);
 const readback=await db.query('SELECT winning_chance,win_amount,version FROM gameops_game_profiles WHERE game_id=$1',[game]);
 assert.deepEqual([readback.rows[0].winning_chance,readback.rows[0].win_amount,readback.rows[0].version],[65,35,2]);
 assert.equal((await request('games/'+game,'PUT',config)).status,409,'Stale form cannot overwrite newer config');
 for(const bad of [{win_amount:101},{winning_chance:-1},{winning_chance:'95'},{demo_chance:101}]){
  const x=await request('games/'+game,'PUT',{...config,...bad,version:2});
  assert.equal(x.status,400,'Server must reject invalid demo percentages');
 }
 const list=await request('games/'+game+'/rounds?limit=25&page=1');
 assert.equal(list.status,200);
 assert.equal(list.data.total,57);
 assert.equal(list.data.pages,3);
 assert.equal(list.data.items.length,25);
 assert.equal(list.data.hasNext,true);
 assert.ok(list.data.items.every(x=>x.game==='QA Primary Game Revised'));
 assert.ok(list.data.items.every(x=>x.currency==='DEMO_COIN'));
 assert.equal(list.data.externalSettlementVerified,false);
 const page2=await request('games/'+game+'/rounds?page=2&limit=25');
 const page3=await request('games/'+game+'/rounds?page=3&limit=25');
 assert.equal(page2.data.items.length,25);
 assert.equal(page3.data.items.length,7);
 assert.equal(page3.data.hasNext,false);
 assert.equal(new Set([...list.data.items,...page2.data.items,...page3.data.items].map(x=>x.id)).size,57,'No duplicate game log rows across pages');
 for(const type of ['win','loss','draw']){
  const q=await request('games/'+game+'/rounds?result='+type);
  assert.equal(q.data.total,19);
  assert.ok(q.data.items.every(x=>x.result===type));
 }
 const search=await request('games/'+game+'/rounds?q=r-057');
 assert.equal(search.data.total,1);
 assert.equal(search.data.items[0].round_id,'r-057');
 assert.equal((await request('games/'+game+'/rounds?q=%25')).data.total,0,'Literal percent must not act as SQL wildcard');
 const isolated=await request('games/'+other+'/rounds');
 assert.equal(isolated.data.total,1);
 assert.equal(isolated.data.items[0].event_id,'private-other');
 for(const q of ['result=unknown','page=-1','page=1001','limit=101','limit=1.5','q='+('x'.repeat(81))]){
  assert.equal((await request('games/'+game+'/rounds?'+q)).status,400,q);
 }
 assert.equal((await request('games/bad/rounds')).status,400);
 assert.equal((await request('games/90000000-0000-4000-8000-000000000001/rounds')).status,404);
 const playerPage=await request('players/'+p1+'/rounds?page=1&limit=20');
 assert.equal(playerPage.status,200);
 assert.equal(playerPage.data.total,29);
 assert.equal(playerPage.data.items.length,20);
 assert.ok(playerPage.data.items.every(x=>x.player_ref==='qa-player-A'));
 assert.ok(playerPage.data.items.every(x=>x.player_id===p1));
 assert.equal((await request('players/90000000-0000-4000-8000-000000000001/rounds')).status,404);
 const events=await db.query("SELECT count(*)::int AS n,sum(stake)::text AS stake,sum(payout)::text AS payout FROM gameops_events WHERE game_id=$1",[game]);
 assert.equal(events.rows[0].n,57);
 assert.equal(events.rows[0].stake,'5700','Editing metadata cannot modify observed stake');
 const audit=await db.query("SELECT count(*)::int AS n FROM gameops_audit WHERE action='game.config.updated'");
 assert.equal(audit.rows[0].n,1);
});
