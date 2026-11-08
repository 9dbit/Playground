"use strict";
const {
  C,
  crypto,
  fail,
  id,
  text,
  amount,
  digest,
  asJson,
  locked,
  post,
  move,
  audit,
  balance,
} = require("./core");
const { playerCode } = require("./cashier");
function createGames({ pool, gameKeys = [], checkMaintenance = async()=>{} }) {
  const keys = new Map();
  for (const k of gameKeys) {
    if (
      !k.id ||
      !k.game ||
      typeof k.secret !== "string" ||
      k.secret.length < 32 ||
      !["sandbox", "live"].includes(k.environment)
    )
      throw Error("Invalid AGENCY_GAME_KEYS");
    if (keys.has(k.id)) throw Error("Duplicate agency game key");
    keys.set(k.id, k);
  }
  async function catalog(db, t, onlySelected = false) {
    return (
      await db.query(
        `SELECT g.id,g.name,g.slug,g.status,g.version,COALESCE(a.entitled,false) AS entitled,COALESCE(a.selected,false) AS selected,COALESCE(a.position,0) AS position,
 r.readiness,r.environment,r.launch_url,r.version AS release_version,r.evidence FROM gameops_games g LEFT JOIN agency_games a ON a.game_id=g.id AND a.tenant_id=$1 LEFT JOIN agency_game_releases r ON r.game_id=g.id
 ${onlySelected ? "WHERE a.entitled AND a.selected" : ""} ORDER BY COALESCE(a.position,0),g.name`,
        [t],
      )
    ).rows;
  }
  async function entitled(db, t, g) {
    await checkMaintenance(db,t.id);
    const game = (await catalog(db, t.id)).find((x) => x.id === g);
    if (
      !game ||
      !game.entitled ||
      !game.selected ||
      game.status !== "Active" ||
      game.readiness !== "publishable" ||
      game.environment !== t.environment
    )
      fail(409, "Game belum tersedia untuk agen ini");
    if (!["sandbox", "active"].includes(t.status))
      fail(409, "Agen tidak menerima ronde baru");
    return game;
  }
  async function launch(a, g) {
    return locked(pool, a.tenant_id, async (db, t) => {
      const game = await entitled(db, t, id(g));
      const player = (
        await db.query(
          "SELECT status FROM agency_players WHERE tenant_id=$1 AND id=$2",
          [t.id, a.id],
        )
      ).rows[0];
      if (!player || player.status !== "active")
        fail(403, "Player tidak aktif");
      const raw = crypto.randomBytes(32).toString("base64url");
      const l = (
        await db.query(
          "INSERT INTO agency_launches(tenant_id,player_id,game_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 minutes') RETURNING id,expires_at",
          [t.id, a.id, g, C.sha(raw)],
        )
      ).rows[0];
      await audit(db, t.id, a.id, "game.launch", l.id, { game: g });
      return {
        ...l,
        token: raw,
        game,
        simulation: t.environment === "sandbox",
      };
    });
  }
  async function redeem(p, scope) {
    const l = (
      await pool.query(
        "SELECT l.*,g.slug FROM agency_launches l JOIN gameops_games g ON g.id=l.game_id WHERE l.token_hash=$1",
        [C.sha(String(p.token || ""))],
      )
    ).rows[0];
    if (!l || l.slug !== scope.game) fail(401, "Launch token tidak valid");
    return locked(pool, l.tenant_id, async (db, t) => {
      if (t.environment !== scope.environment) fail(403, "Environment berbeda");
      const fresh = (
        await db.query(
          "SELECT * FROM agency_launches WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [t.id, l.id],
        )
      ).rows[0];
      const request = p.request_id === undefined ? null : text(p.request_id,120);
      if (new Date(fresh.expires_at) <= new Date() || (fresh.redeemed_at && (!request || fresh.redeem_request !== C.sha(request))))
        fail(409, "Launch token sudah digunakan atau kedaluwarsa");
      if(!fresh.redeemed_at){
      await entitled(db, t, l.game_id);
      await db.query(
        "UPDATE agency_launches SET redeemed_at=now(),expires_at=now()+interval '2 hours',redeem_request=$3 WHERE tenant_id=$1 AND id=$2",
        [t.id, l.id, request ? C.sha(request) : null],
      );
      }
      return {
        session_id: l.id,
        tenant_id: t.id,
        player_id: l.player_id,
        game: scope.game,
        currency: t.currency,
        coin_scale: t.coin_scale,
        balance: String(await balance(db,t.id,playerCode(l.player_id))),
      };
    });
  }
  async function session(db, t, s, scope, newRound = true) {
    const l = (
      await db.query(
        "SELECT l.*,g.slug FROM agency_launches l JOIN gameops_games g ON g.id=l.game_id WHERE l.tenant_id=$1 AND l.id=$2",
        [t.id, id(s)],
      )
    ).rows[0];
    if (
      !l ||
      !l.redeemed_at ||
      l.slug !== scope.game ||
      t.environment !== scope.environment
    )
      fail(403, "Game session tidak sesuai scope");
    if (newRound && new Date(l.expires_at) <= new Date())
      fail(401, "Session kedaluwarsa");
    return l;
  }
  async function reserve(p, scope) {
    return locked(pool, id(p.tenant_id), async (db, t) => {
      const l = await session(db, t, p.session_id, scope),
        stake = amount(p.stake),
        max = amount(p.max_payout, true),
        ref = text(p.round_ref, 120);
      const old = (
        await db.query(
          "SELECT * FROM agency_rounds WHERE tenant_id=$1 AND game_id=$2 AND round_ref=$3",
          [t.id, l.game_id, ref],
        )
      ).rows[0];
      if (old) {
        if (
          old.launch_id !== l.id ||
          BigInt(old.stake) !== stake ||
          BigInt(JSON.parse(old.evidence).max_payout) !== max
        )
          fail(409, "Round id reused with different request");
        return old;
      }
      const game = await entitled(db, t, l.game_id);
      const pl = (
        await db.query(
          "SELECT * FROM agency_players WHERE tenant_id=$1 AND id=$2",
          [t.id, l.player_id],
        )
      ).rows[0];
      if (pl.status !== "active") fail(403, "Player tidak dapat memulai ronde");
      if (pl.limits.stake_limit && stake > BigInt(pl.limits.stake_limit))
        fail(409, "Batas stake player");
      const r = (
        await db.query(
          "INSERT INTO agency_rounds(tenant_id,player_id,game_id,launch_id,round_ref,stake,release_version,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            t.id,
            l.player_id,
            l.game_id,
            l.id,
            ref,
            String(stake),
            game.release_version,
            asJson({ max_payout: String(max) }),
          ],
        )
      ).rows[0];
      const lines = move(
        playerCode(l.player_id),
        playerCode(l.player_id, "reserved"),
        stake,
      );
      if (max > 0n)
        lines.push(...move("game:pool", "round:" + r.id + ":risk", max));
      await post(
        db,
        t.id,
        "round-reserve:" + r.id,
        "round.reserve",
        "game:" + scope.game,
        lines,
        { round_id: r.id, max_payout: String(max) },
      );
      return { ...r, max_payout: String(max) };
    });
  }
  async function settle(p, scope, voided = false) {
    return locked(pool, id(p.tenant_id), async (db, t) => {
      const r = (
        await db.query(
          "SELECT r.*,g.slug FROM agency_rounds r JOIN gameops_games g ON g.id=r.game_id WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE",
          [t.id, id(p.round_id)],
        )
      ).rows[0];
      if (!r || r.slug !== scope.game || t.environment !== scope.environment)
        fail(404, "Round tidak ditemukan");
      const payout = voided ? 0n : amount(p.payout, true),
        state = voided ? "void" : "settled";
      if (r.state !== "reserved") {
        if (r.state !== state || (!voided && BigInt(r.payout) !== payout))
          fail(409, "Round settlement conflict");
        return r;
      }
      const max = BigInt(JSON.parse(r.evidence).max_payout);
      if (payout > max) fail(409, "Payout melebihi liability yang direservasi");
      const lines = voided
        ? move(
            playerCode(r.player_id, "reserved"),
            playerCode(r.player_id),
            r.stake,
          )
        : move(playerCode(r.player_id, "reserved"), "game:pool", r.stake);
      if (voided) {
        if (max > 0n)
          lines.push(...move("round:" + r.id + ":risk", "game:pool", max));
      } else {
        if (payout > 0n)
          lines.push(
            ...move("round:" + r.id + ":risk", playerCode(r.player_id), payout),
          );
        if (max > payout)
          lines.push(
            ...move("round:" + r.id + ":risk", "game:pool", max - payout),
          );
      }
      await post(
        db,
        t.id,
        "round-close:" + r.id,
        voided ? "round.void" : "round.settled",
        "game:" + scope.game,
        lines,
        {
          round_id: r.id,
          stake: r.stake,
          payout: String(payout),
          game_id: r.game_id,
          player_id: r.player_id,
          evidence: text(p.evidence, 1000),
        },
      );
      return (
        await db.query(
          "UPDATE agency_rounds SET state=$3,payout=$4,evidence=$5,settled_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
          [
            t.id,
            r.id,
            state,
            String(payout),
            asJson({ max_payout: String(max), proof: p.evidence }),
          ],
        )
      ).rows[0];
    });
  }
  async function status(p,scope){
    return locked(pool,id(p.tenant_id),async(db,t)=>{
      const l=await session(db,t,p.session_id,scope,false);
      const rounds=(await db.query("SELECT id,round_ref,stake::text,payout::text,state,created_at,settled_at FROM agency_rounds WHERE tenant_id=$1 AND launch_id=$2 AND ($3::text IS NULL OR round_ref=$3) ORDER BY created_at DESC LIMIT 100",[t.id,l.id,p.round_ref===undefined?null:text(p.round_ref,120)])).rows;
      return {session_id:l.id,tenant_id:t.id,player_id:l.player_id,currency:t.currency,coin_scale:t.coin_scale,expires_at:l.expires_at,balance:String(await balance(db,t.id,playerCode(l.player_id))),reserved:String(await balance(db,t.id,playerCode(l.player_id,'reserved'))),rounds};
    });
  }
  async function verify(req) {
    const k = keys.get(req.get("X-Agency-Key"));
    const ts = req.get("X-Agency-Timestamp"),
      nonce = req.get("X-Agency-Nonce"),
      signature = req.get("X-Agency-Signature");
    if (
      !k ||
      k.enabled === false ||
      !/^\d{10}$/.test(ts || "") ||
      Math.abs(Date.now() / 1000 - Number(ts)) > 300 ||
      !/^[a-f0-9]{32}$/.test(nonce || "")
    )
      fail(401, "Game signature tidak valid");
    const message = [
      "agency.v1",
      req.method,
      req.path,
      ts,
      nonce,
      C.sha(req.rawBody || Buffer.from(asJson(req.body))),
    ].join("\n");
    const expected = crypto
      .createHmac("sha256", k.secret)
      .update(message)
      .digest("hex");
    if (!C.equal(signature || "", expected))
      fail(401, "Game signature tidak valid");
    const q = await pool.query(
      "INSERT INTO agency_nonce(key_id,nonce,expires_at) VALUES($1,$2,now()+interval '11 minutes') ON CONFLICT DO NOTHING RETURNING nonce",
      [k.id, nonce],
    );
    if (!q.rowCount) fail(409, "Nonce replay");
    return k;
  }
  return {
    catalog,
    entitled,
    launch,
    redeem,
    reserve,
    settle,
    verify,
    status,
    configured: [...keys.values()].map((k) => ({
      id: k.id,
      game: k.game,
      environment: k.environment,
      enabled: k.enabled !== false,
    })),
  };
}
module.exports = { createGames };
