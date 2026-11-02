from pathlib import Path
import subprocess,re,json
ROOT=Path.cwd()
BASE='3e9dad5f010aa830ba4930d1d85cd793c25deb2c'
def original(f): return subprocess.check_output(['git','show',BASE+':'+f],cwd=ROOT,text=True)
def save(f,s): (ROOT/f).write_text(s)
def replace(s,a,b):
    if s.count(a)!=1: raise Exception(f'Expected unique match {a[:130]!r}, got {s.count(a)}')
    return s.replace(a,b)
def route(s,method,path,new):
    pat="app."+method+"('"+path+"'"
    start=s.index(pat)
    if s.count(pat)!=1: raise Exception('Route ambiguous '+pat)
    end=re.search(r'\n ?}\)\);',s[start:])
    if not end: raise Exception('Route end '+pat)
    return s[:start]+new.strip()+s[start+end.end():]
for file in ['server.js','engine/deep-routes.js','engine/admin-operations.js','engine/security.js','package.json']:
    assert (ROOT/file).read_text()==original(file), 'Unexpected source drift: '+file
s=original('server.js')
s=replace(s,"const adminOps=require('./engine/admin-operations');","const adminOps=require('./engine/admin-operations');\nconst {transaction,RequestError}=require('./engine/transaction');\nconst settingsSchema=require('./engine/settings-schema');\nconst {readPlayers}=require('./engine/player-list');\nconst publicContent=require('./engine/public-content');")
s=replace(s,"const VERSION = '0.12.0';","const VERSION = '0.14.0';")
s=replace(s,"async function audit(action, resource, details = {}) {\n  await pool.query(","async function audit(action, resource, details = {}, executor = pool) {\n  await executor.query(")
s=replace(s,"  await bridge.init();","  await bridge.init();\n  const conflicts=await publicContent.inspectConflicts(pool);\n  console.log('[cms-public-url] canonical namespaces active; ambiguous legacy slugs:',conflicts);")
s=route(s,'get','/api/admin/deep/games/:id/rounds','')
s=replace(s,'// Completes the existing Game Edit -> Game Log link; no synthetic events are inserted.\n','')
s=route(s,'get','/api/admin/players',"app.get('/api/admin/players',route(async(req,res)=>{\n res.json(await readPlayers(pool,req.query));\n}));")
s=route(s,'post','/api/admin/games',r"""
app.post('/api/admin/games',route(async(req,res)=>{
 const {name,slug,code,platform}=req.body||{};
 if(!valid(name,80)||!name.trim()||!valid(slug,60)||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||!valid(code,6)||!valid(platform||'Web / PWA',60))return error(res,400,'Invalid game fields');
 const item=await transaction(pool,async db=>{
  const q=await db.query('INSERT INTO gameops_games(name,slug,code,platform) VALUES($1,$2,$3,$4) ON CONFLICT(slug) DO NOTHING RETURNING *',[name.trim(),slug,code,platform||'Web / PWA']);
  if(!q.rowCount)throw new RequestError(409,'Game slug exists');
  await audit('game.created',q.rows[0].id,{name,slug},db);return q.rows[0];
 });
 res.status(201).json({item});
}));
""")
s=route(s,'patch','/api/admin/games/:id',r"""
app.patch('/api/admin/games/:id',route(async(req,res)=>{
 const {status}=req.body||{};
 if(!validId(req.params.id)||!['Active','Maintenance'].includes(status))return error(res,400,'Invalid game status or id');
 const item=await transaction(pool,async db=>{
  const q=await db.query('UPDATE gameops_games SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[status,req.params.id]);
  if(!q.rowCount)throw new RequestError(404,'Game not found');
  await audit('game.status_changed',req.params.id,{status},db);return q.rows[0];
 });
 res.json({item,notice:'Catalog metadata only; external game engines are unchanged'});
}));
""")
s=route(s,'patch','/api/admin/requests/:id',r"""
app.patch('/api/admin/requests/:id',route(async(req,res)=>{
 const {status,note}=req.body||{};
 if(!validId(req.params.id)||!['approved','rejected'].includes(status)||(note!=null&&!valid(note,500)))return error(res,400,'Invalid decision');
 const item=await transaction(pool,async db=>{
  const q=await db.query("UPDATE gameops_requests SET status=$1,note=$2,reviewed_at=now() WHERE id=$3 AND status='pending' RETURNING *",[status,note||null,req.params.id]);
  if(!q.rowCount)throw new RequestError(409,'Not found or already reviewed');
  await audit('request.reviewed',req.params.id,{status},db);return q.rows[0];
 });res.json({item,settled:false});
}));
""")
s=route(s,'post','/api/admin/tickets',r"""
app.post('/api/admin/tickets',route(async(req,res)=>{
 const {subject,requester_ref,priority}=req.body||{};
 if(!valid(subject,200)||!subject.trim()||!valid(requester_ref,120)||!['Low','Medium','High'].includes(priority||'Medium'))return error(res,400,'Invalid ticket fields');
 const item=await transaction(pool,async db=>{
  const q=await db.query('INSERT INTO gameops_tickets(subject,requester_ref,priority) VALUES($1,$2,$3) RETURNING *',[subject.trim(),requester_ref,priority||'Medium']);
  await audit('ticket.created',q.rows[0].id,{},db);return q.rows[0];
 });res.status(201).json({item});
}));
""")
s=route(s,'patch','/api/admin/tickets/:id',r"""
app.patch('/api/admin/tickets/:id',route(async(req,res)=>{
 const {status}=req.body||{};
 if(!validId(req.params.id)||!['Open','Pending','Answered','Closed'].includes(status))return error(res,400,'Invalid ticket status');
 const item=await transaction(pool,async db=>{
  const q=await db.query('UPDATE gameops_tickets SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[status,req.params.id]);
  if(!q.rowCount)throw new RequestError(404,'Ticket not found');
  await audit('ticket.status_changed',req.params.id,{status},db);return q.rows[0];
 });res.json({item});
}));
""")
s=replace(s,"if(req.auth.role==='owner')return res.json({items:q.rows});","if(req.auth.role==='owner')return res.json({items:q.rows.map(x=>({...x,validationErrors:settingsSchema.errorsFor(x.key,x.value)}))});")
s=route(s,'put','/api/admin/settings/:key',r"""
app.put('/api/admin/settings/:key',route(async(req,res)=>{
 const key=req.params.key,value=settingsSchema.validate(key,req.body?.value);
 const expected=settingsSchema.expectedVersion(req.body?.expected_version);
 const item=await transaction(pool,async db=>{
  let q;
  if(expected===0)q=await db.query('INSERT INTO gameops_settings(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING RETURNING key,version,updated_at',[key,JSON.stringify(value),req.auth.username]);
  else q=await db.query('UPDATE gameops_settings SET value=$2,version=version+1,updated_at=now(),updated_by=$3 WHERE key=$1 AND version=$4 RETURNING key,version,updated_at',[key,JSON.stringify(value),req.auth.username,expected]);
  if(!q.rowCount)throw new RequestError(409,'Settings changed in another session. Your edits were not saved; reload the latest version.','SETTINGS_VERSION_CONFLICT');
  await audit('settings.saved',key,{version:q.rows[0].version},db);return q.rows[0];
 });
 res.set('ETag','"'+item.version+'"').json({item});
}));
""")
s=replace(s,"adminOps.mount(app,{pool});","adminOps.mount(app,{pool});\npublicContent.mount(app,{pool});")
s=replace(s," if(res.headersSent)return next(err);"," if(res.headersSent)return next(err);\n if(err instanceof RequestError)return res.status(err.status).json({error:err.message,code:err.code});")
save('server.js',s)
s=original('engine/deep-routes.js')
s=replace(s,"const crypto=require('node:crypto');","const crypto=require('node:crypto');\nconst {transaction,RequestError}=require('./transaction');\nconst {normalizeArtwork}=require('./artwork');\nconst {readPlayers}=require('./player-list');\nconst {publicPath}=require('./public-content');")
s=replace(s,'"CREATE INDEX IF NOT EXISTS gameops_login_time_idx ON gameops_login_history(created_at DESC)"','"CREATE INDEX IF NOT EXISTS gameops_login_time_idx ON gameops_login_history(created_at DESC)",\n"CREATE INDEX IF NOT EXISTS gameops_player_status_idx ON gameops_player_profiles(local_status,player_id)",\n"CREATE INDEX IF NOT EXISTS gameops_players_cursor_idx ON gameops_players(last_seen DESC,id DESC)"')
s=replace(s,"   await client.query('COMMIT');\n   await audit('game.config.updated',req.params.gid,{version:q.rows[0].version,demoOnly:true});","   await audit('game.config.updated',req.params.gid,{version:q.rows[0].version,demoOnly:true},client);\n   await client.query('COMMIT');")
s=replace(s,"   await client.query('COMMIT');\n   await audit('player.metadata.updated',req.params.pid,{version:q.rows[0].version,status:p.local_status});","   await audit('player.metadata.updated',req.params.pid,{version:q.rows[0].version,status:p.local_status},client);\n   await client.query('COMMIT');")
s=route(s,'get','/api/admin/deep/players',"app.get('/api/admin/deep/players',wrap(async(req,res)=>{\n  res.json(await readPlayers(pool,req.query));\n }));")
s=route(s,'post','/api/admin/deep/games/:gid/image',r"""
app.post('/api/admin/deep/games/:gid/image',wrap(async(req,res)=>{
  if(!id(req.params.gid))return fail(res,400,'Invalid ID');
  const image=await normalizeArtwork(req.body?.data);
  await transaction(pool,async db=>{
   const q=await db.query('UPDATE gameops_game_profiles SET image_bytes=$2,image_mime=$3,updated_at=now() WHERE game_id=$1 RETURNING game_id',[req.params.gid,image.bytes,image.mime]);
   if(!q.rowCount)throw new RequestError(409,'Save game configuration before uploading image');
   await audit('game.image.updated',req.params.gid,{mime:image.mime,size:image.bytes.length,width:image.width,height:image.height},db);
  });
  res.json({ok:true,mime:image.mime,width:image.width,height:image.height,bytes:image.bytes.length});
 }));
""")
s=route(s,'post','/api/admin/deep/tickets/:tid/replies',r"""
app.post('/api/admin/deep/tickets/:tid/replies',wrap(async(req,res)=>{
  if(!id(req.params.tid)||!clean(req.body?.body,4000)||!req.body.body.trim())return fail(res,400,'Invalid ticket reply');
  if(!req.auth?.username)throw new RequestError(401,'Authenticated author required');
  const item=await transaction(pool,async db=>{
   const q=await db.query('INSERT INTO gameops_ticket_messages(ticket_id,author,body) SELECT id,$2,$3 FROM gameops_tickets WHERE id=$1 RETURNING id::text,author',[req.params.tid,req.auth.username,req.body.body.trim()]);
   if(!q.rowCount)throw new RequestError(404,'Ticket not found');
   await audit('ticket.reply.recorded',req.params.tid,{messageId:q.rows[0].id},db);return q.rows[0];
  });res.status(201).json({item,sentExternally:false});
 }));
""")
s=route(s,'post','/api/admin/deep/notifications',r"""
app.post('/api/admin/deep/notifications',wrap(async(req,res)=>{
  const p=req.body||{};
  if(!clean(p.recipient_ref,120)||!p.recipient_ref.trim()||!clean(p.title,180)||!p.title.trim()||!clean(p.body,2000)||!p.body.trim())return fail(res,400,'Invalid notification');
  const item=await transaction(pool,async db=>{
   const q=await db.query('INSERT INTO gameops_notifications(recipient_ref,title,body) VALUES($1,$2,$3) RETURNING id::text',[p.recipient_ref.trim(),p.title.trim(),p.body.trim()]);
   await audit('notification.recorded',q.rows[0].id,{},db);return q.rows[0];
  });res.status(201).json({item,sent:false});
 }));
""")
s=route(s,'post','/api/admin/deep/subscribers',r"""
app.post('/api/admin/deep/subscribers',wrap(async(req,res)=>{
  const email=req.body?.contact;
  if(typeof email!=='string'||!/^([^@\s]+)@([^@\s]+)\.([^@\s]+)$/.test(email)||email.length>200)return fail(res,400,'Valid email required');
  const item=await transaction(pool,async db=>{
   const q=await db.query('INSERT INTO gameops_subscribers(contact) VALUES($1) ON CONFLICT(contact) DO NOTHING RETURNING id',[email.toLowerCase()]);
   if(!q.rowCount)throw new RequestError(409,'Subscriber exists');
   await audit('subscriber.created',q.rows[0].id,{},db);return q.rows[0];
  });res.status(201).json({item});
 }));
""")
s=route(s,'patch','/api/admin/deep/subscribers/:sid',r"""
app.patch('/api/admin/deep/subscribers/:sid',wrap(async(req,res)=>{
  if(!id(req.params.sid)||!['subscribed','unsubscribed'].includes(req.body?.status))return fail(res,400,'Invalid subscriber');
  const item=await transaction(pool,async db=>{
   const q=await db.query('UPDATE gameops_subscribers SET status=$2 WHERE id=$1 RETURNING id,status',[req.params.sid,req.body.status]);
   if(!q.rowCount)throw new RequestError(404,'Subscriber not found');
   await audit('subscriber.status.updated',req.params.sid,{status:req.body.status},db);return q.rows[0];
  });res.json({item});
 }));
""")
s=route(s,'post','/api/admin/deep/content/:kind',r"""
app.post('/api/admin/deep/content/:kind',wrap(async(req,res)=>{
  const p=req.body||{};
  if(!types.includes(req.params.kind)||!slug(p.slug)||!clean(p.title,180)||!p.title.trim()||!clean(p.body,20000)||!['draft','published'].includes(p.status))return fail(res,400,'Invalid content');
  const item=await transaction(pool,async db=>{
   const q=await db.query('INSERT INTO gameops_content(kind,slug,title,body,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,slug) DO NOTHING RETURNING id,kind,slug,status,version',[req.params.kind,p.slug,p.title,p.body,p.status]);
   if(!q.rowCount)throw new RequestError(409,'Slug already exists for this content type');
   await audit('content.created',q.rows[0].id,{kind:req.params.kind},db);return q.rows[0];
  });res.status(201).json({item:{...item,public_path:publicPath(item)}});
 }));
""")
s=route(s,'put','/api/admin/deep/content/:kind/:cid',r"""
app.put('/api/admin/deep/content/:kind/:cid',wrap(async(req,res)=>{
  const p=req.body||{};
  if(!types.includes(req.params.kind)||!id(req.params.cid)||!slug(p.slug)||!clean(p.title,180)||!p.title.trim()||!clean(p.body,20000)||!['draft','published'].includes(p.status)||!Number.isInteger(p.version)||p.version<1)return fail(res,400,'Invalid content');
  const item=await transaction(pool,async db=>{
   const q=await db.query('UPDATE gameops_content SET slug=$3,title=$4,body=$5,status=$6,version=version+1,updated_at=now() WHERE kind=$1 AND id=$2 AND version=$7 RETURNING id,kind,slug,status,version',[req.params.kind,req.params.cid,p.slug,p.title,p.body,p.status,p.version]);
   if(!q.rowCount)throw new RequestError(409,'Content not found or version conflict');
   await audit('content.updated',req.params.cid,{kind:req.params.kind,version:q.rows[0].version},db);return q.rows[0];
  });res.json({item:{...item,public_path:publicPath(item)}});
 }));
""")
a="const q=await pool.query('SELECT id,kind,slug,title,status,version,updated_at FROM gameops_content WHERE kind=$1 ORDER BY updated_at DESC LIMIT 200',[req.params.kind]);\n  res.json({items:q.rows});"
s=replace(s,a,a.replace('items:q.rows','items:q.rows.map(x=>({...x,public_path:publicPath(x)}))'))
a="if(!q.rowCount)return fail(res,404,'Content not found');\n  res.json({item:q.rows[0]});"
s=replace(s,a,a.replace('item:q.rows[0]','item:{...q.rows[0],public_path:publicPath(q.rows[0])}'))
s=route(s,'get','/api/admin/deep/system/:name','')
s=route(s,'get','/sitemap.xml','')
s=route(s,'get','/info/:contentSlug','')
save('engine/deep-routes.js',s)
s=original('engine/admin-operations.js')
s=replace(s,"const {canAccess}=require('./security-policy');","const {canAccess}=require('./security-policy');\nconst {transaction,RequestError}=require('./transaction');")
s=route(s,'put','/api/admin/ops/profile',r"""
app.put('/api/admin/ops/profile',wrap(async(req,res)=>{
  const name=typeof req.body?.displayName==='string'?req.body.displayName.trim():'';
  if(name.length<2||name.length>80||/[<>]/.test(name))return fail(res,400,'Display name must have 2-80 plain characters');
  const item=await transaction(pool,async db=>{
   const q=await db.query('UPDATE gameops_admin_accounts SET display_name=$2 WHERE id=$1 AND status=$3 RETURNING id::text,username,display_name AS "displayName",role,status',[req.auth.id,name,'active']);
   if(!q.rowCount)throw new RequestError(404,'Administrator missing');
   await db.query("INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,'admin.profile.updated',$2,$3)",[req.auth.username,req.auth.id,JSON.stringify({displayNameChanged:true})]);return q.rows[0];
  });res.json({ok:true,item});
 }));
""")
save('engine/admin-operations.js',s)
s=original('engine/security.js')
a="""      const q = await pool.query('DELETE FROM gameops_admin_sessions WHERE id=$1 AND admin_id=$2 RETURNING id', [sid, req.auth.id]);
      if (!q.rowCount) throw new AuthError(404, 'Session not found');
      await audit(pool, req.auth.username, 'security.session.revoked', sid);"""
b="""      await transaction(async db => {
        const q = await db.query('DELETE FROM gameops_admin_sessions WHERE id=$1 AND admin_id=$2 RETURNING id', [sid, req.auth.id]);
        if (!q.rowCount) throw new AuthError(404, 'Session not found');
        await audit(db, req.auth.username, 'security.session.revoked', sid);
      });"""
s=replace(s,a,b)
save('engine/security.js',s)
p=json.loads(original('package.json'));p['version']='0.14.0';p['dependencies']['sharp']='0.35.3'
p['scripts']['check']+=' && node --check engine/transaction.js && node --check engine/settings-schema.js && node --check engine/player-list.js && node --check engine/public-content.js && node --check engine/artwork.js'
save('package.json',json.dumps(p,indent=2)+'\n')
