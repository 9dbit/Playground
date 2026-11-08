"use strict";
const {locked,amount,fail,balance,post,move,audit,key,digest,text,id,permit}=require('./core');
const {windowQuery,dateWhere,csv}=require('./report-window');
const ddl=`
ALTER TABLE agency_allocations ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE agency_allocations ADD COLUMN IF NOT EXISTS request_key text;
ALTER TABLE agency_allocations ADD COLUMN IF NOT EXISTS request_digest text;
ALTER TABLE agency_allocations ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE agency_allocations ADD COLUMN IF NOT EXISTS credited_at timestamptz;
ALTER TABLE agency_allocations ADD COLUMN IF NOT EXISTS review_reason text;
ALTER TABLE agency_allocations ADD COLUMN IF NOT EXISTS balance_before numeric(38,0);
ALTER TABLE agency_allocations ADD COLUMN IF NOT EXISTS balance_after numeric(38,0);
CREATE UNIQUE INDEX IF NOT EXISTS agency_allocation_request_key ON agency_allocations(tenant_id,request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS agency_allocation_history ON agency_allocations(tenant_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS agency_coin_refill(
 tenant_id uuid PRIMARY KEY REFERENCES agency_tenants(id), mode text NOT NULL DEFAULT 'off',
 threshold numeric(38,0) NOT NULL DEFAULT 0, daily_limit numeric(38,0) NOT NULL DEFAULT 100000000,
 monthly_limit numeric(38,0) NOT NULL DEFAULT 300000000, version integer NOT NULL DEFAULT 0,
 approved_by text, approved_auth_version integer, checked_at timestamptz, last_status text NOT NULL DEFAULT 'disabled');
ALTER TABLE agency_coin_refill ADD COLUMN IF NOT EXISTS daily_limit numeric(38,0) NOT NULL DEFAULT 100000000;
ALTER TABLE agency_coin_refill ADD COLUMN IF NOT EXISTS approved_auth_version integer;`;
const batch=t=>100000000n*10n**BigInt(t.coin_scale);
const boundary=unit=>`date_trunc('${unit}',now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta'`;
function createCoinRefill({pool,security,workerEnabled=false}) {
  async function settings(db,t) {
    return (await db.query('SELECT * FROM agency_coin_refill WHERE tenant_id=$1',[t.id])).rows[0] || {mode:'off',threshold:'0',daily_limit:String(batch(t)),monthly_limit:String(batch(t)*3n),version:0,last_status:'disabled'};
  }
  function active(t) { if(t.environment!=='sandbox') fail(409,'Alur coin ini hanya tersedia untuk demo'); if(!['active','sandbox'].includes(t.status)) fail(409,'Agen tidak aktif'); }
  async function request(tid,a,p) {
    const n=amount(p.amount), reason=text(p.reason,500), requestKey=key(p.idempotency_key), hash=digest({amount:String(n),reason,actor:a.id});
    return locked(pool,tid,async(db,t)=>{
      active(t);
      const old=(await db.query('SELECT * FROM agency_allocations WHERE tenant_id=$1 AND request_key=$2',[tid,requestKey])).rows[0];
      if(old){if(old.request_digest!==hash)fail(409,'Permintaan dengan ID yang sama memiliki isi berbeda');return old;}
      const r=(await db.query("INSERT INTO agency_allocations(tenant_id,amount,reason,requested_by,request_key,request_digest) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[tid,String(n),reason,a.id,requestKey,hash])).rows[0];
      await audit(db,tid,a.id,'coins.requested',r.id,{amount:String(n)});return r;
    });
  }
  async function review(tid,allocation,a,p) {
    if(!['approve','reject'].includes(p.decision))fail(422,'Keputusan tidak valid');
    const reason=p.decision==='reject'?text(p.reason,500):(p.reason?text(p.reason,500):'Disetujui master');
    return locked(pool,tid,async(db,t)=>{
      active(t);
      const r=(await db.query('SELECT * FROM agency_allocations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tid,id(allocation)])).rows[0];
      if(!r)fail(404,'Permintaan tidak ditemukan');
      const status=p.decision==='approve'?'approved':'rejected';
      if(r.status===status)return {ok:true,duplicate:true,item:r};
      if(r.status!=='requested')fail(409,'Permintaan sudah diproses');
      const before=await balance(db,tid,'stock:available'), n=BigInt(r.amount);
      if(status==='approved'){
        if(before+await balance(db,tid,'stock:reserved')+n>BigInt(t.policy.coin_limit))fail(409,'Alokasi melebihi limit stok agen');
        await post(db,tid,'allocation:'+r.id,'stock.allocated',a.id,move('external:coin_allocation','stock:available',n),{allocation_id:r.id});
      }
      const result=(await db.query("UPDATE agency_allocations SET status=$3,reviewed_by=$4,reviewed_at=now(),credited_at=CASE WHEN $3='approved' THEN now() ELSE NULL END,review_reason=$5,balance_before=$6,balance_after=$7 WHERE tenant_id=$1 AND id=$2 RETURNING *",[tid,r.id,status,a.id,reason,String(before),String(status==='approved'?before+n:before)])).rows[0];
      await audit(db,tid,a.id,'allocation.reviewed',r.id,{decision:p.decision,reason});return {ok:true,item:result};
    });
  }
  async function read(tid,q={},exporting=false) {
    const w=windowQuery(q), status=q.status||'';
    if(!['','requested','approved','rejected'].includes(status))fail(422,'Status tidak valid');
    return locked(pool,tid,async(db,t)=>{
      const params=[tid,w.from,w.to,status];
      const where=`tenant_id=$1 AND ${dateWhere('created_at')} AND ($4='' OR status=$4)`;
      const rows=(await db.query(`SELECT * FROM agency_allocations WHERE ${where} ORDER BY created_at ${w.sort},id ${w.sort} LIMIT $5 OFFSET $6`,[...params,exporting?10001:101,exporting?0:w.offset])).rows;
      if(exporting){if(rows.length>10000)fail(422,'Pilih rentang lebih pendek; maksimal 10.000 baris');return csv(rows,['id','amount','source','status','reason','requested_by','created_at','reviewed_by','reviewed_at','credited_at','review_reason','balance_before','balance_after']);}
      const totals=(await db.query(`SELECT to_char(date_trunc('${w.unit}',created_at AT TIME ZONE 'Asia/Jakarta'),'YYYY-MM-DD') AS period,count(*)::int AS requests,coalesce(sum(amount) FILTER(WHERE status='approved'),0)::text AS approved,coalesce(sum(amount) FILTER(WHERE status='requested'),0)::text AS pending FROM agency_allocations WHERE ${where} GROUP BY 1 ORDER BY 1 ${w.sort} LIMIT 1001`,params)).rows;
      return {items:rows.slice(0,100),has_more:rows.length>100,totals:totals.slice(0,1000),totals_truncated:totals.length>1000,worker_enabled:workerEnabled,...w,batch:String(batch(t)),coin_scale:t.coin_scale,settings:await settings(db,t),stock:(await db.query("SELECT code,amount::text FROM agency_balances WHERE tenant_id=$1 AND code LIKE 'stock:%'",[tid])).rows,as_of:new Date().toISOString()};
    });
  }
  async function save(req,tid,p) {
    if(!['off','request','auto'].includes(p.mode))fail(422,'Mode tidak valid');
    if(!Number.isInteger(p.version))fail(422,'Versi pengaturan diperlukan');
    if(req.agency){permit(req.agency,'coins.request');if(p.mode==='auto')fail(403,'Persetujuan refill otomatis hanya oleh master');}
    return locked(pool,tid,async(db,t)=>{
      active(t);const old=await settings(db,t);if(p.version!==old.version)fail(409,'Pengaturan berubah; refresh dahulu');
      let approver=null,authVersion=null,actor=req.agency?.id;
      if(!req.agency){const a=(await db.query('SELECT * FROM gameops_admin_accounts WHERE id=$1 FOR UPDATE',[req.auth.id])).rows[0];
        if(!a||a.role!=='owner'||a.status!=='active'||a.auth_version!==req.auth.auth_version)fail(403,'Master owner required');
        await security.reauthenticate(db,a,p);actor=a.id;
        if(p.mode==='auto'){approver=a.id;authVersion=a.auth_version;}
      }
      const threshold=amount(p.threshold,true),daily=amount(p.daily_limit),monthly=amount(p.monthly_limit),n=batch(t);
      if(threshold>=n||daily<n||monthly<daily)fail(422,'Ambang harus di bawah 100 juta; batas harian minimal satu refill dan batas bulanan minimal batas harian');
      if(p.mode!=='off'&&threshold+n>BigInt(t.policy.coin_limit))fail(422,'Ambang + refill melampaui limit stok agen');
      await db.query(`INSERT INTO agency_coin_refill(tenant_id,mode,threshold,daily_limit,monthly_limit,version,approved_by,approved_auth_version,last_status) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8) ON CONFLICT(tenant_id) DO UPDATE SET mode=$2,threshold=$3,daily_limit=$4,monthly_limit=$5,version=agency_coin_refill.version+1,approved_by=$6,approved_auth_version=$7,last_status=$8`,[tid,p.mode,String(threshold),String(daily),String(monthly),approver,authVersion,p.mode==='off'?'disabled':'waiting']);
      await audit(db,tid,actor,'coins.refill.configured',tid,{before:{mode:old.mode,threshold:old.threshold,daily_limit:old.daily_limit,monthly_limit:old.monthly_limit},after:{mode:p.mode,threshold:String(threshold),daily_limit:String(daily),monthly_limit:String(monthly)},batch:String(n)});
      return {ok:true,settings:await settings(db,t)};
    });
  }
  async function tickTenant(tid) {
    return locked(pool,tid,async(db,t)=>{
      const s=await settings(db,t);if(s.mode==='off')return 'disabled';
      const status=async v=>{await db.query('UPDATE agency_coin_refill SET checked_at=now(),last_status=$2 WHERE tenant_id=$1',[tid,v]);return v;};
      if(t.environment!=='sandbox'||!['active','sandbox'].includes(t.status)||t.policy.maintenance)return status('tenant_paused');
      // Activation maintenance uses a separate configuration record.
      if((await db.query("SELECT to_regclass('agency_preferences') AS name")).rows[0].name){
        const c=(await db.query('SELECT settings FROM agency_preferences WHERE tenant_id=$1',[tid])).rows[0];if(c?.settings?.maintenance)return status('tenant_paused');
      }
      if(s.mode==='auto'&&!(await db.query("SELECT id FROM gameops_admin_accounts WHERE id::text=$1 AND role='owner' AND status='active' AND auth_version=$2",[s.approved_by,s.approved_auth_version])).rowCount)return status('approval_inactive');
      if((await db.query("SELECT id FROM agency_allocations WHERE tenant_id=$1 AND source='auto' AND status='rejected' AND reviewed_at>now()-interval '24 hours' LIMIT 1",[tid])).rowCount)return status('recent_rejection');
      const before=await balance(db,tid,'stock:available');if(before>BigInt(s.threshold))return status('above_threshold');
      if((await db.query("SELECT id FROM agency_allocations WHERE tenant_id=$1 AND status='requested' LIMIT 1",[tid])).rowCount)return status('pending_request');
      const n=batch(t);
      for(const [unit,limit] of [['day',s.daily_limit],['month',s.monthly_limit]]){
        const used=BigInt((await db.query(`SELECT coalesce(sum(amount),0)::text AS used FROM agency_allocations WHERE tenant_id=$1 AND source='auto' AND status<>'rejected' AND created_at>=${boundary(unit)}`,[tid])).rows[0].used);
        if(used+n>BigInt(limit))return status(unit==='day'?'daily_limit':'monthly_limit');
      }
      if(before+await balance(db,tid,'stock:reserved')+n>BigInt(t.policy.coin_limit))return status('stock_limit');
      const r=(await db.query("INSERT INTO agency_allocations(tenant_id,amount,reason,requested_by,source) VALUES($1,$2,'Auto refill 100 juta coin','auto-refill','auto') RETURNING id",[tid,String(n)])).rows[0];
      if(s.mode==='auto'){
        await post(db,tid,'allocation:'+r.id,'stock.allocated','auto-refill',move('external:coin_allocation','stock:available',n),{allocation_id:r.id,standing_approval:s.approved_by,config_version:s.version});
        await db.query("UPDATE agency_allocations SET status='approved',reviewed_at=now(),credited_at=now(),reviewed_by=$2,review_reason='Sesuai otorisasi auto refill',balance_before=$3,balance_after=$4 WHERE id=$1",[r.id,s.approved_by,String(before),String(before+n)]);
      }
      await audit(db,tid,'auto-refill','coins.refill.'+s.mode,r.id,{amount:String(n),approved_by:s.approved_by,version:s.version});return status(s.mode==='auto'?'refilled':'requested');
    });
  }
  async function tick(){for(const r of (await pool.query("SELECT tenant_id FROM agency_coin_refill WHERE mode<>'off'")).rows){try{await tickTenant(r.tenant_id);}catch(e){console.error('[coin-refill]',e.code||'failed');}}}
  return {init:()=>pool.query(ddl),read,request,review,save,tick,tickTenant};
}
module.exports={createCoinRefill,batch};
