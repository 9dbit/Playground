'use strict';
// CP11 operational companions to the Xaxino dashboard: auditable local activity,
// typed database search, an owner-scoped profile, and a narrow safe maintenance job.
// No vendor credentials, player PII, remote game control or cash settlement.
const {canAccess}=require('./security-policy');
const intId=/^[1-9][0-9]{0,17}$/;
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const fail=(res,status,message)=>res.status(status).json({error:message});
const ACTIONS={
 game:['game.created','game.status_changed','game.config.updated','game.image.updated'],
 tickets:['ticket.created','ticket.status_changed','ticket.reply.recorded'],
 player:['player.metadata.updated'],
 review:['request.reviewed'],
 settings:['settings.saved','content.created','content.updated'],
 subscriptions:['subscriber.created','subscriber.status.updated'],
 wallet:['virtual_wallet.credit','virtual_wallet.debit','virtual_wallet.transfer'],
 notification:['notification.recorded']
};
const groupsByRole={
 owner:['game','tickets','player','review','settings','subscriptions','wallet','notification'],
 operator:['game','tickets','player','settings'],
 support:['tickets'],
 viewer:['game']
};
function visibleActions(role){return (groupsByRole[role]||[]).flatMap(group=>ACTIONS[group]);}
const migrations=[
 "CREATE TABLE IF NOT EXISTS gameops_admin_notification_reads(admin_id uuid NOT NULL REFERENCES gameops_admin_accounts(id) ON DELETE CASCADE,audit_id bigint NOT NULL REFERENCES gameops_audit(id) ON DELETE CASCADE,read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(admin_id,audit_id))",
 "CREATE TABLE IF NOT EXISTS gameops_maintenance_runs(id bigserial PRIMARY KEY,actor text NOT NULL,kind text NOT NULL DEFAULT 'expired_session_cleanup',cleaned_revocations integer NOT NULL DEFAULT 0,cleaned_sessions integer NOT NULL DEFAULT 0,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz NOT NULL DEFAULT now(),status text NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','failed')))",
 "CREATE INDEX IF NOT EXISTS gameops_maintenance_runs_time_idx ON gameops_maintenance_runs(started_at DESC)"
];
async function ensureSchema(pool){for(const sql of migrations)await pool.query(sql);}
async function runMaintenance(pool,{actor='scheduler',manual=false}={}){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const l=await db.query('SELECT pg_try_advisory_xact_lock($1) AS locked',[18102111]);
  if(!l.rows[0]?.locked){await db.query('ROLLBACK');return {status:'busy'};}
  const conf=await db.query("SELECT value FROM gameops_settings WHERE key='cron'");
  const config=conf.rows[0]?.value||{};
  const interval=[5,10,15,30,60].includes(Number(config.interval_minutes))?Number(config.interval_minutes):10;
  if(!manual){
   if(config.enabled!==true){await db.query('ROLLBACK');return {status:'disabled'};}
   const last=await db.query('SELECT started_at FROM gameops_maintenance_runs ORDER BY id DESC LIMIT 1');
   if(last.rows[0] && (Date.now()-new Date(last.rows[0].started_at).getTime())<interval*60000){
    await db.query('ROLLBACK');return {status:'not_due',intervalMinutes:interval};
   }
  }
  const cleanedRev=await db.query("DELETE FROM gameops_revoked_sessions WHERE expires_at<now()-interval '1 day'");
  const cleanedSession=await db.query("DELETE FROM gameops_admin_sessions WHERE expires_at<now()-interval '1 day'");
  const q=await db.query("INSERT INTO gameops_maintenance_runs(actor,cleaned_revocations,cleaned_sessions) VALUES($1,$2,$3) RETURNING id::text,actor,kind,status,cleaned_revocations,cleaned_sessions,started_at,finished_at",
   [actor,cleanedRev.rowCount,cleanedSession.rowCount]);
  await db.query("INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,'maintenance.cleanup.completed',$2,$3)",[actor,q.rows[0].id,JSON.stringify({revocations:cleanedRev.rowCount,sessions:cleanedSession.rowCount,manual})]);
  await db.query('COMMIT');
  return {status:'completed',run:q.rows[0],intervalMinutes:interval,manual};
 }catch(e){
  try{await db.query('ROLLBACK')}catch{}
  throw e;
 }finally{db.release();}
}
async function latestActivity(pool,adminId,role,limit){
 const actions=visibleActions(role);
 if(actions.length===0)return {unread:0,items:[]};
 const [history,count]=await Promise.all([
  pool.query("SELECT a.id::text,a.action,a.actor,a.resource,a.created_at,(r.read_at IS NOT NULL) AS is_read FROM gameops_audit a LEFT JOIN gameops_admin_notification_reads r ON r.audit_id=a.id AND r.admin_id=$1 WHERE a.created_at>=now()-interval '30 days' AND a.action=ANY($2::text[]) ORDER BY a.id DESC LIMIT $3",
  [adminId,actions,limit]),
  pool.query("SELECT count(*)::int AS unread FROM gameops_audit a LEFT JOIN gameops_admin_notification_reads r ON r.audit_id=a.id AND r.admin_id=$1 WHERE a.created_at>=now()-interval '30 days' AND a.action=ANY($2::text[]) AND r.audit_id IS NULL",
   [adminId,actions])
 ]);
 return {unread:count.rows[0].unread,items:history.rows};
}
async function databaseSearch(pool,q,role){
 const out=[];
 const add=(rows,type,routeMaker,subtitle)=>{
  for(const r of rows)out.push({type,label:r.label,route:routeMaker(r),subtitle:subtitle(r)});
 };
 const game=await pool.query("SELECT id::text,name AS label,slug,status FROM gameops_games WHERE position(lower($1) IN lower(name))>0 OR position(lower($1) IN lower(slug))>0 ORDER BY name LIMIT 8",[q]);
 add(game.rows,'Game',r=>'game/'+r.id,r=>r.slug+' · '+r.status);
 if(canAccess(role,'GET','/players')){
  const people=await pool.query("SELECT p.id::text,p.player_ref AS label,g.name AS game FROM gameops_players p JOIN gameops_games g ON g.id=p.game_id WHERE position(lower($1) IN lower(p.player_ref))>0 ORDER BY p.last_seen DESC LIMIT 8",[q]);
  add(people.rows,'Player',r=>'player/'+r.id,r=>r.game);
 }
 if(canAccess(role,'GET','/tickets')){
  const tickets=await pool.query("SELECT id::text,subject AS label,status FROM gameops_tickets WHERE position(lower($1) IN lower(subject))>0 ORDER BY created_at DESC LIMIT 8",[q]);
  add(tickets.rows,'Ticket',r=>'ticket/'+r.id,r=>r.status);
 }
 if(canAccess(role,'GET','/deep/content/page')){
  const content=await pool.query("SELECT id::text,title AS label,kind,slug FROM gameops_content WHERE position(lower($1) IN lower(title))>0 OR position(lower($1) IN lower(slug))>0 ORDER BY updated_at DESC LIMIT 8",[q]);
  add(content.rows,'Content',r=>'content-edit/'+r.kind+'/'+r.id,r=>r.kind+' · '+r.slug);
 }
 return out.slice(0,24);
}
function mount(app,{pool}){
 app.get('/api/admin/ops/search',wrap(async(req,res)=>{
  const q=typeof req.query.q==='string'?req.query.q.trim():'';
  if(q.length<2 || q.length>80)return fail(res,400,'Search query must contain 2 to 80 characters');
  const items=await databaseSearch(pool,q,req.auth.role);
  res.json({query:q,items,limit:24,source:'postgresql'});
 }));
 app.get('/api/admin/ops/notifications',wrap(async(req,res)=>{
  const limit=Math.max(1,Math.min(100,Number.parseInt(req.query.limit||'20',10)||20));
  const d=await latestActivity(pool,req.auth.id,req.auth.role,limit);
  res.json({...d,scope:'last_30_days',source:'audited_admin_activity',externalDelivery:false,
   note:'These are local audited activity events, not Xaxino member-registration notifications or external messages.'});
 }));
 app.post('/api/admin/ops/notifications/read-all',wrap(async(req,res)=>{
  const actions=visibleActions(req.auth.role);
  if(actions.length===0)return res.json({ok:true,marked:0});
  const q=await pool.query("INSERT INTO gameops_admin_notification_reads(admin_id,audit_id) SELECT $1,a.id FROM gameops_audit a WHERE a.created_at>=now()-interval '30 days' AND a.action=ANY($2::text[]) ON CONFLICT DO NOTHING RETURNING audit_id",
   [req.auth.id,actions]);
  res.json({ok:true,marked:q.rowCount});
 }));
 app.post('/api/admin/ops/notifications/:id/read',wrap(async(req,res)=>{
  const id=req.params.id;
  if(!intId.test(id))return fail(res,400,'Invalid notification ID');
  const actions=visibleActions(req.auth.role);
  const q=await pool.query("SELECT 1 FROM gameops_audit WHERE id=$1 AND action=ANY($2::text[]) AND created_at>=now()-interval '30 days'",[id,actions]);
  if(!q.rowCount)return fail(res,404,'Notification not found');
  await pool.query('INSERT INTO gameops_admin_notification_reads(admin_id,audit_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.auth.id,id]);
  res.json({ok:true,id});
 }));
 app.get('/api/admin/ops/profile',wrap(async(req,res)=>{
  const q=await pool.query('SELECT id::text,username,display_name AS "displayName",role,status,mfa_enabled AS "mfaEnabled" FROM gameops_admin_accounts WHERE id=$1',[req.auth.id]);
  if(!q.rowCount)return fail(res,404,'Administrator missing');
  res.json({item:q.rows[0],passwordChangeUrl:'/security',mfaUrl:'/security',avatarUploadAvailable:false});
 }));
 app.put('/api/admin/ops/profile',wrap(async(req,res)=>{
  const name=typeof req.body?.displayName==='string'?req.body.displayName.trim():'';
  if(name.length<2||name.length>80||/[<>]/.test(name))return fail(res,400,'Display name must have 2–80 plain characters');
  const q=await pool.query('UPDATE gameops_admin_accounts SET display_name=$2 WHERE id=$1 AND status=$3 RETURNING id::text,username,display_name AS "displayName",role,status',[req.auth.id,name,'active']);
  if(!q.rowCount)return fail(res,404,'Administrator missing');
  await pool.query("INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,'admin.profile.updated',$2,$3)",
   [req.auth.username,req.auth.id,JSON.stringify({displayNameChanged:true})]);
  res.json({ok:true,item:q.rows[0]});
 }));
 app.get('/api/admin/ops/cron',wrap(async(req,res)=>{
  const [conf,last,runs]=await Promise.all([
   pool.query("SELECT value,updated_at FROM gameops_settings WHERE key='cron'"),
   pool.query('SELECT id::text,actor,status,cleaned_revocations,cleaned_sessions,started_at,finished_at FROM gameops_maintenance_runs ORDER BY id DESC LIMIT 1'),
   pool.query('SELECT id::text,actor,status,cleaned_revocations,cleaned_sessions,started_at FROM gameops_maintenance_runs ORDER BY id DESC LIMIT 20')
  ]);
  const value=conf.rows[0]?.value||{};
  res.json({enabled:value.enabled===true,intervalMinutes:[5,10,15,30,60].includes(Number(value.interval_minutes))?Number(value.interval_minutes):10,
    job:'expired_session_cleanup',lastRun:last.rows[0]||null,history:runs.rows,
    operations:['remove expired revoked-session markers','remove expired administrator sessions'],
    externalVendorCron:false,remoteGameCron:false,
    note:'Only local expired session cleanup is automated. No external games, payments or withdrawals.'});
 }));
 app.post('/api/admin/ops/cron/run',wrap(async(req,res)=>{
  const outcome=await runMaintenance(pool,{actor:req.auth.username,manual:true});
  if(outcome.status==='busy')return fail(res,409,'Maintenance job is already running');
  res.json({ok:true,...outcome});
 }));
}
function startScheduler(pool,{onError=()=>{}}={}){
 const timer=setInterval(()=>{
  runMaintenance(pool,{actor:'scheduler',manual:false}).catch(onError);
 },60_000);
 timer.unref();
 return ()=>clearInterval(timer);
}
module.exports={migrations,ensureSchema,mount,startScheduler,runMaintenance,latestActivity,databaseSearch,visibleActions};
