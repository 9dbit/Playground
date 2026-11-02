'use strict';
// CP09: this transport observes engines. It never issues game commands or moves balances.
const crypto = require('node:crypto');
const PATH = '/api/v2/game-bridge';
const MAX_BODY = 8192;
const SKEW = 300;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const KNOWN_GAMES = ['skygate-5000', 'uno-luck', 'mahjong-wild'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
class BridgeError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function configuration(raw) {
  if (!raw) return [];
  let values; try { values = JSON.parse(raw); } catch { throw Error('Invalid GAMEOPS_BRIDGE_KEYS JSON'); }
  if (!Array.isArray(values) || values.length > 20) throw Error('Bridge configuration must be an array, maximum 20 keys');
  const ids = new Set(), gameEnvironments = new Map();
  return values.map(value => {
    if (!value || typeof value !== 'object' || !/^[a-z0-9-]{3,60}$/.test(value.id || '') || ids.has(value.id) ||
        !KNOWN_GAMES.includes(value.game) || !/^[0-9a-f]{64}$/.test(value.secret || '') ||
        !['production','staging'].includes(value.environment) || typeof value.allowRounds !== 'boolean' ||
        (value.enabled !== undefined && typeof value.enabled !== 'boolean')) throw Error('Invalid or duplicate bridge key configuration');
    if(gameEnvironments.has(value.game) && gameEnvironments.get(value.game)!==value.environment) throw Error('One environment per game registry; use separate admin deployments for isolation');
    gameEnvironments.set(value.game,value.environment); ids.add(value.id);
    return Object.freeze({ id: value.id, game: value.game, secret: value.secret, environment: value.environment,
      enabled: value.enabled !== false, allowRounds: value.allowRounds });
  });
}
function signature(secret, timestamp, nonce, raw, method = 'POST', path = PATH) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(['gameops.v2', method, path, timestamp, nonce, digest(raw)].join('\n')).digest('hex');
}
function receiptSignature(secret, nonce, raw) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(['gameops.receipt.v2', nonce, digest(raw)].join('\n')).digest('hex');
}
function authenticate(headers, raw, keys, now = Date.now()) {
  if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > MAX_BODY) throw new BridgeError(413, 'BODY_LIMIT');
  const id = headers['x-gameops-key'], timestamp = headers['x-gameops-timestamp'], nonce = headers['x-gameops-nonce'], mac = headers['x-gameops-signature'];
  const key = keys.find(k => k.id === id && k.enabled);
  if (!key || !/^\d{10,11}$/.test(timestamp || '') || !/^[a-f0-9]{32}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(mac || '') ||
      Math.abs(now / 1000 - Number(timestamp)) > SKEW) throw new BridgeError(401, 'INVALID_SIGNATURE');
  const expected = signature(key.secret, timestamp, nonce, raw);
  if (!crypto.timingSafeEqual(Buffer.from(expected,'hex'), Buffer.from(mac,'hex'))) throw new BridgeError(401, 'INVALID_SIGNATURE');
  return { key, nonce };
}
function decimal(value) {
  // Numeric(38,12). Never pass monetary-looking telemetry through IEEE-754 floats.
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,25})(\.\d{1,12})?$/.test(value)) throw new BridgeError(400, 'INVALID_DECIMAL');
  const [whole, fraction = ''] = value.split('.'); return whole + '.' + fraction.padEnd(12, '0');
}
function validate(value, key, now = Date.now()) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || value.schema_version !== 2 || value.game !== key.game || value.environment !== key.environment)
    throw new BridgeError(403, 'GAME_SCOPE_MISMATCH');
  if (value.type === 'heartbeat') {
    const expected = ['schema_version','game','environment','type','version','health','deployment','capabilities'];
    if (Object.keys(value).some(k=>!expected.includes(k)) || typeof value.version !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value.version) ||
        !['ok','degraded'].includes(value.health) || typeof value.deployment !== 'string' || value.deployment.length>100 ||
        !Array.isArray(value.capabilities) || value.capabilities.length>2 || value.capabilities.some(x=>!['heartbeat','round.settled'].includes(x)))
      throw new BridgeError(400,'INVALID_HEARTBEAT');
    // A heartbeat's capabilities are sender claims, not proof of round ingestion.
    return { type:'heartbeat', version:value.version, health:value.health, deployment:value.deployment, capabilities:value.capabilities };
  }
  if (value.type !== 'round.settled') throw new BridgeError(400,'UNKNOWN_EVENT_TYPE');
  if (!key.allowRounds) throw new BridgeError(403,'ROUND_INGESTION_DISABLED');
  const expected = ['schema_version','game','environment','type','event_id','round_id','player_ref','currency','stake','payout','occurred_at'];
  if (Object.keys(value).some(k=>!expected.includes(k)) || !SAFE_ID.test(value.event_id || '') || !SAFE_ID.test(value.round_id || '') ||
      !/^p_[a-f0-9]{64}$/.test(value.player_ref || '') || value.currency !== 'DEMO_COIN' || typeof value.occurred_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.occurred_at) || !Number.isFinite(Date.parse(value.occurred_at)) ||
      Date.parse(value.occurred_at)>now+60000 || Date.parse(value.occurred_at)<now-30*86400000) throw new BridgeError(400,'INVALID_ROUND');
  return { type:'round.settled', event_id:value.event_id, round_id:value.round_id, player_ref:value.player_ref,
    currency:'DEMO_COIN', stake:decimal(value.stake), payout:decimal(value.payout), occurred_at:new Date(value.occurred_at).toISOString() };
}
const DDL = `
CREATE TABLE IF NOT EXISTS gameops_bridge_state (
 game_id uuid PRIMARY KEY REFERENCES gameops_games(id), last_seen timestamptz, last_heartbeat_at timestamptz,
 last_health text, version text, deployment text, environment text, last_key_id text,
 capabilities jsonb NOT NULL DEFAULT '[]', accepted_rounds bigint NOT NULL DEFAULT 0, duplicate_rounds bigint NOT NULL DEFAULT 0,
 last_round_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gameops_bridge_nonces (
 key_id text NOT NULL, nonce text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(key_id,nonce)
);
CREATE INDEX IF NOT EXISTS gameops_bridge_nonces_expiry_idx ON gameops_bridge_nonces(expires_at);
CREATE TABLE IF NOT EXISTS gameops_bridge_rounds (
 id bigserial PRIMARY KEY, game_id uuid NOT NULL REFERENCES gameops_games(id), environment text NOT NULL,
 source_event_id text NOT NULL, source_round_id text NOT NULL, player_ref text NOT NULL,
 currency text NOT NULL CHECK(currency='DEMO_COIN'), stake numeric(38,12) NOT NULL CHECK(stake>=0),
 payout numeric(38,12) NOT NULL CHECK(payout>=0), occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 payload_hash text NOT NULL, key_id text NOT NULL,
 UNIQUE(game_id,environment,source_event_id), UNIQUE(game_id,environment,source_round_id)
);
CREATE INDEX IF NOT EXISTS gameops_bridge_rounds_game_idx ON gameops_bridge_rounds(game_id,id DESC);
`;
function createBridge({ pool, rawConfig = process.env.GAMEOPS_BRIDGE_KEYS, logger = console }) {
  const keys = configuration(rawConfig);
  async function init() {
    await pool.query(DDL);
    await pool.query('INSERT INTO gameops_bridge_state(game_id) SELECT id FROM gameops_games ON CONFLICT DO NOTHING');
    await pool.query('DELETE FROM gameops_bridge_nonces WHERE expires_at<now()');
  }
  async function processRequest(raw, headers) {
    const {key,nonce} = authenticate(headers,raw,keys);
    let data; try { data=JSON.parse(raw.toString('utf8')); } catch { throw new BridgeError(400,'INVALID_JSON'); }
    const event = validate(data,key), client=await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      // Serializing each game's ingestion makes round idempotency and counters atomic.
      const g=await client.query('SELECT id FROM gameops_games WHERE slug=$1 FOR UPDATE',[key.game]);
      if(!g.rowCount) throw new BridgeError(409,'GAME_NOT_REGISTERED');
      const gid=g.rows[0].id;
      const replay=await client.query("INSERT INTO gameops_bridge_nonces(key_id,nonce,expires_at) VALUES($1,$2,now()+interval '11 minutes') ON CONFLICT DO NOTHING RETURNING nonce",[key.id,nonce]);
      if(!replay.rowCount)throw new BridgeError(409,'REQUEST_REPLAY');
      await client.query('INSERT INTO gameops_bridge_state(game_id) VALUES($1) ON CONFLICT DO NOTHING',[gid]);
      if(event.type==='heartbeat') {
        await client.query('UPDATE gameops_bridge_state SET last_seen=now(),last_heartbeat_at=now(),last_health=$2,version=$3,deployment=$4,environment=$5,last_key_id=$6,capabilities=$7 WHERE game_id=$1',
          [gid,event.health,event.version,event.deployment,key.environment,key.id,JSON.stringify(event.capabilities)]);
        result={accepted:true,type:'heartbeat',game:key.game,environment:key.environment,rounds_enabled:key.allowRounds};
      } else {
        const hash=digest(JSON.stringify(event));
        const prior=await client.query('SELECT id::text,payload_hash FROM gameops_bridge_rounds WHERE game_id=$1 AND environment=$2 AND (source_event_id=$3 OR source_round_id=$4)',[gid,key.environment,event.event_id,event.round_id]);
        if(prior.rowCount) {
          if(prior.rowCount!==1||prior.rows[0].payload_hash!==hash)throw new BridgeError(409,'EVENT_CONFLICT');
          await client.query('UPDATE gameops_bridge_state SET last_seen=now(),duplicate_rounds=duplicate_rounds+1 WHERE game_id=$1',[gid]);
          result={accepted:true,duplicate:true,type:event.type,id:prior.rows[0].id};
        } else {
          const inserted=await client.query('INSERT INTO gameops_bridge_rounds(game_id,environment,source_event_id,source_round_id,player_ref,currency,stake,payout,occurred_at,payload_hash,key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id::text',
            [gid,key.environment,event.event_id,event.round_id,event.player_ref,event.currency,event.stake,event.payout,event.occurred_at,hash,key.id]);
          await client.query('UPDATE gameops_bridge_state SET last_seen=now(),last_round_at=now(),accepted_rounds=accepted_rounds+1,last_key_id=$2 WHERE game_id=$1',[gid,key.id]);
          result={accepted:true,duplicate:false,type:event.type,id:inserted.rows[0].id};
        }
      }
      await client.query('DELETE FROM gameops_bridge_nonces WHERE expires_at<now()');
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    logger.info('[gameops-bridge]',JSON.stringify({type:result.type,game:key.game,environment:key.environment,accepted:true,duplicate:result.duplicate||false}));
    return { result, key, nonce };
  }
  async function summary() {
    const q=await pool.query('SELECT g.id,g.name,g.slug,s.last_seen,s.last_heartbeat_at,s.last_health,s.version,s.deployment,s.environment,s.capabilities,s.accepted_rounds::text,s.duplicate_rounds::text,s.last_round_at,s.last_key_id FROM gameops_games g LEFT JOIN gameops_bridge_state s ON s.game_id=g.id ORDER BY g.name');
    const now=Date.now();
    const items=q.rows.map(row=>{
      const configured=keys.filter(k=>k.game===row.slug&&k.enabled),fresh=row.last_heartbeat_at&&now-new Date(row.last_heartbeat_at).getTime()<180000&&configured.some(k=>k.id===row.last_key_id);
      return {...row,configured:configured.length>0,key_ids:configured.map(k=>k.id),environments:[...new Set(configured.map(k=>k.environment))],
        transport_state:!configured.length?'not_configured':!row.last_heartbeat_at?'awaiting_heartbeat':!fresh?'stale':row.last_health==='ok'?'online':'degraded',
        rounds_enabled:configured.some(k=>k.allowRounds),round_data_verified:Number(row.accepted_rounds)>0,
        control_enabled:false,wallet_connected:false};
    });
    return {items,as_of:new Date(now).toISOString(),configured:items.filter(x=>x.configured).length,online:items.filter(x=>x.transport_state==='online').length,
      round_sources:items.filter(x=>x.round_data_verified).length,protocol:'gameops.v2',note:'Online confirms signed heartbeat, not round settlement. Bridge observations do not change wallets or legacy counters.'};
  }
  function mount(app) {
    app.post(PATH,async(req,res,next)=>{
      if(req.originalUrl!==PATH)return res.status(400).json({error:'CANONICAL_PATH_REQUIRED'});
      try {
        const {result,key,nonce}=await processRequest(req.rawBody,req.headers),raw=Buffer.from(JSON.stringify(result));
        res.set('X-GameOps-Receipt',receiptSignature(key.secret,nonce,raw));res.type('json').status(200).send(raw);
      }catch(e){if(e instanceof BridgeError)return res.status(e.status).json({error:e.code});next(e);}
    });
    app.get('/api/admin/bridge',async(req,res,next)=>{try{res.json(await summary());}catch(e){next(e);}});
    app.get('/api/admin/bridge/:slug/rounds',async(req,res,next)=>{
      if(!SLUG.test(req.params.slug)||req.params.slug.length>80)return res.status(400).json({error:'INVALID_GAME'});
      const before=req.query.before;
      if(before!==undefined&&!/^[1-9]\d{0,17}$/.test(before))return res.status(400).json({error:'INVALID_CURSOR'});
      try {
        const q=await pool.query('SELECT r.id::text,r.environment,r.source_event_id,r.source_round_id,r.currency,r.stake::text,r.payout::text,r.occurred_at,r.received_at FROM gameops_bridge_rounds r JOIN gameops_games g ON g.id=r.game_id WHERE g.slug=$1 AND ($2::bigint IS NULL OR r.id<$2) ORDER BY r.id DESC LIMIT 100',[req.params.slug,before||null]);
        res.json({items:q.rows,next_cursor:q.rows.length===100?q.rows.at(-1).id:null,observational:true});
      }catch(e){next(e);}
    });
  }
  return {init,mount,summary,processRequest};
}
module.exports={createBridge,configuration,authenticate,signature,receiptSignature,decimal,validate,BridgeError,PATH};
