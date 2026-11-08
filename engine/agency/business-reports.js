"use strict";
const {fail}=require('./core');
const {windowQuery,dateWhere,csv}=require('./report-window');
function createBusinessReports({pool}) {
  async function transactions(tid,q={},exporting=false){
    const w=windowQuery(q),state=q.state||'',kind=q.kind||'',search=String(q.search||'').trim();
    if(!['','deposit','withdraw'].includes(kind)||!/^[a-z_]{0,64}$/.test(state)||search.length>100)fail(422,'Filter transaksi tidak valid');
    const values=[tid,w.from,w.to,state,kind,search];
    const where=`x.tenant_id=$1 AND ${dateWhere('x.created_at')} AND ($4='' OR x.state=$4) AND ($5='' OR x.kind=$5) AND ($6='' OR x.id::text=$6 OR p.username ILIKE '%' || replace(replace(replace($6,'\\','\\\\'),'%','\\%'),'_','\\_') || '%')`;
    const rows=(await pool.query(`SELECT x.*,p.username FROM agency_transactions x JOIN agency_players p ON p.tenant_id=x.tenant_id AND p.id=x.player_id WHERE ${where} ORDER BY x.created_at ${w.sort},x.id ${w.sort} LIMIT $7 OFFSET $8`,[...values,exporting?10001:201,exporting?0:w.offset])).rows;
    if(exporting){if(rows.length>10000)fail(422,'Pilih rentang lebih pendek; maksimal 10.000 baris');return csv(rows,['id','username','kind','method','amount','coins','state','created_at','updated_at']);}
    return {items:rows.slice(0,200),has_more:rows.length>200,...w};
  }
  async function report(tid,q={}){
    const w=windowQuery(q),params=[tid,w.from,w.to];
    const items=(await pool.query(`SELECT g.name,g.slug,count(*)::int AS rounds,count(*) FILTER(WHERE r.state='settled')::int AS settled,
      coalesce(sum(r.stake) FILTER(WHERE r.state='settled'),0)::text AS stake,coalesce(sum(r.payout) FILTER(WHERE r.state='settled'),0)::text AS payout,
      count(*) FILTER(WHERE r.state='settled' AND r.payout>r.stake)::int AS net_wins FROM agency_rounds r JOIN gameops_games g ON g.id=r.game_id
      WHERE r.tenant_id=$1 AND ${dateWhere('COALESCE(r.settled_at,r.created_at)')} GROUP BY g.name,g.slug ORDER BY g.name`,params)).rows;
    const cashflow=(await pool.query(`SELECT to_char(date_trunc('${w.unit}',created_at AT TIME ZONE 'Asia/Jakarta'),'YYYY-MM-DD') AS period,
      coalesce(sum((data->>'sales')::numeric),0)::text AS sales,coalesce(sum((data->>'withdrawals')::numeric),0)::text AS withdrawals
      FROM agency_journals WHERE tenant_id=$1 AND ${dateWhere('created_at')} AND (data ? 'sales' OR data ? 'withdrawals') GROUP BY 1 ORDER BY 1 ${w.sort} LIMIT 1001`,params)).rows;
    const tenant=(await pool.query('SELECT currency,coin_scale FROM agency_tenants WHERE id=$1',[tid])).rows[0];if(!tenant)fail(404,'Agen tidak ditemukan');
    return {items,cashflow:cashflow.slice(0,1000),cashflow_truncated:cashflow.length>1000,...w,currency:'COIN minor units',cash_currency:tenant.currency,coin_scale:tenant.coin_scale,notice:'Arus kas mengikuti waktu pencatatan journal termasuk koreksi. Ronde mengikuti waktu penyelesaian (atau dibuat bila belum selesai). Penjualan dikurangi penarikan bukan laba. Observed RTP bukan bukti fraud.'};
  }
  return {transactions,report};
}
module.exports={createBusinessReports};
