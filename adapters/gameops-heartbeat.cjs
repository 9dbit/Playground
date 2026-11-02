'use strict';
// Observability only. No game rules, balances, settlement or player data are accessed.
const crypto = require('node:crypto');
const RECEIVER = 'https://playground-admin-production.up.railway.app/api/v2/game-bridge';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function signedHeaders(keyId, secret, bytes, timestamp = String(Math.floor(Date.now()/1000)), nonce = crypto.randomBytes(16).toString('hex')) {
  const mac=crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(['gameops.v2','POST','/api/v2/game-bridge',timestamp,nonce,hash(bytes)].join('\n')).digest('hex');
  return {'Content-Type':'application/json','X-GameOps-Key':keyId,'X-GameOps-Timestamp':timestamp,'X-GameOps-Nonce':nonce,'X-GameOps-Signature':mac};
}
function verifyReceipt(secret, nonce, bytes, signature) {
  if(!/^[a-f0-9]{64}$/.test(signature||''))return false;
  const expected=crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(['gameops.receipt.v2',nonce,hash(bytes)].join('\n')).digest();
  return crypto.timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
function startBridge({game,port,version='unknown',env=process.env,request=global.fetch,log=console}={}) {
  if(env.GAMEOPS_BRIDGE_ENABLED!=='1')return ()=>{};
  const key=env.GAMEOPS_BRIDGE_KEY_ID,secret=env.GAMEOPS_BRIDGE_SECRET,environment=env.GAMEOPS_ENVIRONMENT;
  if(!/^[a-z0-9-]{3,60}$/.test(key||'')||!/^[0-9a-f]{64}$/.test(secret||'')||!['production','staging'].includes(environment)||
      !['skygate-5000','uno-luck','mahjong-wild'].includes(game)||!Number.isInteger(Number(port))||Number(port)<1||Number(port)>65535||
      (env.GAMEOPS_RECEIVER_URL&&env.GAMEOPS_RECEIVER_URL!==RECEIVER)) {
    log.error('[gameops-bridge] invalid_configuration; heartbeat disabled');return ()=>{};
  }
  let stopped=false,busy=false;
  async function tick() {
    if(stopped||busy)return;busy=true;
    try {
      let health='degraded',build=String(version);
      try {
        const r=await request('http://127.0.0.1:'+Number(port)+'/health',{redirect:'error',signal:AbortSignal.timeout(3500)});
        const d=await r.json();if(r.ok&&d.ok===true)health=d.worker_ready===false?'degraded':'ok';
        if(typeof d.version==='string')build=d.version;
      }catch{}
      const payload={schema_version:2,game,environment,type:'heartbeat',version:build.replace(/[^A-Za-z0-9_.:-]/g,'_').slice(0,80)||'unknown',
        health,deployment:String(env.RAILWAY_DEPLOYMENT_ID||'unknown').slice(0,100),capabilities:['heartbeat']};
      const bytes=Buffer.from(JSON.stringify(payload)),headers=signedHeaders(key,secret,bytes);
      const response=await request(RECEIVER,{method:'POST',headers,body:bytes,redirect:'error',signal:AbortSignal.timeout(5000)});
      const receipt=Buffer.from(await response.arrayBuffer());
      if(receipt.length>4096||!response.ok||!verifyReceipt(secret,headers['X-GameOps-Nonce'],receipt,response.headers.get('x-gameops-receipt')))
        throw Error('receipt_rejected');
      const data=JSON.parse(receipt.toString('utf8'));if(data.accepted!==true||data.type!=='heartbeat'||data.game!==game)throw Error('invalid_receipt');
      log.info('[gameops-bridge] heartbeat_acknowledged game='+game+' environment='+environment+' local_health='+health);
    }catch{log.warn('[gameops-bridge] heartbeat_not_acknowledged game='+game+'; retry next interval');}
    finally{busy=false;}
  }
  const initial=setTimeout(tick,2500);initial.unref();
  const interval=setInterval(tick,60000);interval.unref();
  return ()=>{stopped=true;clearTimeout(initial);clearInterval(interval);};
}
module.exports={signedHeaders,verifyReceipt,startBridge};
