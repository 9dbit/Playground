'use strict';
// Server-side only. The game must persist request_id, round_ref and its outcome before calls.
const crypto=require('node:crypto');
class AgencyWalletError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
function createAgencyWallet({origin,keyId,secret,fetchImpl=fetch,allowLocal=false}){
 const url=new URL(origin);if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!(url.protocol==='https:'||allowLocal&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw Error('Agency wallet origin must be HTTPS');
 if(!keyId||typeof secret!=='string'||secret.length<32)throw Error('Agency wallet credentials required');
 async function request(action,payload){
  if(!['redeem','status','reserve','settle','void'].includes(action))throw Error('Unsupported agency action');
  const path='/api/v4/agency-game/'+action,body=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(16).toString('hex');
  const hash=crypto.createHash('sha256').update(body).digest('hex'),signature=crypto.createHmac('sha256',secret).update(['agency.v1','POST',path,timestamp,nonce,hash].join('\n')).digest('hex');
  const r=await fetchImpl(new URL(path,url),{method:'POST',headers:{'Content-Type':'application/json','X-Agency-Key':keyId,'X-Agency-Timestamp':timestamp,'X-Agency-Nonce':nonce,'X-Agency-Signature':signature},body,redirect:'error',signal:AbortSignal.timeout(12000)});
  let data;try{data=await r.json();}catch{throw new AgencyWalletError(502,'AGENCY_INVALID_RESPONSE');}
  if(!r.ok)throw new AgencyWalletError(r.status,data.code||'AGENCY_REQUEST_REJECTED');return data;
 }
 return {redeem:(token,requestId)=>{if(!requestId)throw Error('Persisted redemption request ID required');return request('redeem',{token,request_id:requestId});},status:p=>request('status',p),reserve:p=>request('reserve',p),settle:p=>request('settle',p),void:p=>request('void',p)};
}
module.exports={createAgencyWallet,AgencyWalletError};
