"use strict";
const { normalizeArtwork } = require("../artwork");
const dns = require("node:dns/promises");
const {
  fail,
  id,
  text,
  escape,
  asJson,
  locked,
  audit,
  digest,
} = require("./core");
const { wrap } = require("./auth");
function url(value, allowPath = true) {
  if (!value) return "";
  if (allowPath && /^\/(?!\/)/.test(value)) return value;
  let u;
  try {
    u = new URL(value);
  } catch {
    fail(400, "URL tidak valid");
  }
  if (u.protocol !== "https:" || u.username || u.password)
    fail(400, "URL HTTPS wajib");
  return u.toString();
}
function validate(p) {
  if (!p || typeof p !== "object" || Array.isArray(p))
    fail(400, "Konten tidak valid");
  const allowed = [
    "title",
    "description",
    "body",
    "banner_url",
    "canonical",
    "robots",
    "og_image",
    "accent",
    "chatvice_merchant",
    "chatvice_enabled",
    "analytics_id",
    "link_url",
  ];
  if (Object.keys(p).some((k) => !allowed.includes(k)))
    fail(400, "Field konten tidak dikenal");
  const out = {
    title: text(p.title, 160),
    link_url: url(p.link_url),
    description: String(p.description || "").slice(0, 300),
    body: String(p.body || "").slice(0, 20000),
    banner_url: url(p.banner_url),
    og_image: url(p.og_image),
    canonical: url(p.canonical, false),
    robots: p.robots === "noindex" ? "noindex, nofollow" : "index, follow",
    accent: p.accent || "#7759ed",
    chatvice_enabled: p.chatvice_enabled === true,
    chatvice_merchant: String(p.chatvice_merchant || ""),
    analytics_id: String(p.analytics_id || ""),
  };
  if (!/^#[0-9a-f]{6}$/i.test(out.accent)) fail(400, "Warna tidak valid");
  if (
    out.chatvice_merchant &&
    !/^[a-zA-Z0-9_-]{1,100}$/.test(out.chatvice_merchant)
  )
    fail(400, "Merchant Chatvice tidak valid");
  if (out.analytics_id && !/^G-[A-Z0-9]{4,20}$/.test(out.analytics_id))
    fail(400, "ID analytics tidak valid");
  return out;
}
function createContent({ pool, agency, publicOrigin, chatvice }) {
  let renderPage;
  let renderSitemap;
  let renderRobots;
  async function siteBase(t) {
    if (t.slug === "64cor") return "https://playground-agent-frontend-production.up.railway.app";
    const primary = (
      await pool.query(
        "SELECT domain FROM agency_domains WHERE tenant_id=$1 AND verified_at IS NOT NULL AND is_primary",
        [t.id],
      )
    ).rows[0];
    return primary
      ? "https://" + primary.domain
      : publicOrigin + "/site/" + t.slug;
  }
  const domainRouter = wrap(async (req, res, next) => {
    if (req.hostname === new URL(publicOrigin).hostname) return next();
    const site = (
      await pool.query(
        "SELECT t.id,t.slug FROM agency_domains d JOIN agency_tenants t ON t.id=d.tenant_id WHERE d.domain=$1 AND d.verified_at IS NOT NULL",
        [req.hostname],
      )
    ).rows[0];
    if (!site) return next();
    req.agencySite = site;
    if (
      /^\/(?:api\/admin|api\/auth|agents|engine|integrations|wallet|data)(?:\/|$)/.test(
        req.path,
      )
    )
      fail(404, "Halaman tidak ditemukan");
    req.params = { slug: site.slug };
    if (req.method === "GET") {
      if (req.path === "/") return renderPage(req, res);
      if (req.path === "/sitemap.xml") return renderSitemap(req, res);
      if (req.path === "/robots.txt") return renderRobots(req, res);
      const page = /^\/p\/([a-z0-9-]+)$/.exec(req.path);
      if (page) {
        req.params.page = page[1];
        return renderPage(req, res);
      }
      if (req.path.startsWith("/site/")) fail(404, "Website tidak ditemukan");
    }
    next();
  });
  async function canonical(db, t, p) {
    if (p.banner_url.startsWith("/media/agency/")) {
      const asset = /^\/media\/agency\/([a-f0-9-]+)\/([a-f0-9-]+)\.webp$/.exec(p.banner_url);
      if (!asset || asset[1] !== t) fail(400, "Banner harus milik agen ini");
      const found = await db.query("SELECT 1 FROM agency_banner_assets WHERE tenant_id=$1 AND id=$2", [t, id(asset[2])]);
      if (!found.rowCount) fail(400, "Banner tidak ditemukan");
    }
    if (p.chatvice_enabled) {
      const tenant = (
        await db.query("SELECT slug FROM agency_tenants WHERE id=$1", [t])
      ).rows[0];
      if (
        !chatvice.origin ||
        chatvice.tenants?.[tenant.slug]?.public !== p.chatvice_merchant
      )
        fail(409, "Merchant Chatvice publik harus dipetakan oleh Playground");
    }
    if (!p.canonical) return;
    const host = new URL(p.canonical).hostname;
    const found = await db.query(
      "SELECT 1 FROM agency_domains WHERE tenant_id=$1 AND domain=$2 AND verified_at IS NOT NULL",
      [t, host],
    );
    if (!found.rowCount) {
      const tenant = (
        await db.query("SELECT slug FROM agency_tenants WHERE id=$1", [t])
      ).rows[0];
      if (tenant.slug === "64cor" && new URL(p.canonical).origin === "https://playground-agent-frontend-production.up.railway.app") return;
      const u = new URL(p.canonical),
        base = "/site/" + tenant.slug;
      if (
        host !== new URL(publicOrigin).hostname ||
        (u.pathname !== base && !u.pathname.startsWith(base + "/"))
      )
        fail(400, "Canonical harus memakai domain atau path milik agen");
    }
  }
  async function publish(db, t, c, a) {
    await canonical(db, t, c.draft);
    const q = await db.query(
      "UPDATE agency_content SET published=draft,scheduled_at=null,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [t, c.id],
    );
    if (c.slug === "home")
      await db.query("UPDATE agency_tenants SET website=$2 WHERE id=$1", [
        t,
        asJson({ ...c.draft, published: true }),
      ]);
    await audit(db, t, a, "content.published", c.id, { version: c.version });
    return q.rows[0];
  }
  function mount(app) {
    app.get("/site/64cor", (req,res) => res.redirect(302,"https://playground-agent-frontend-production.up.railway.app/"));
    app.get("/site/64cor/p/:page", (req,res) => res.redirect(302,"https://playground-agent-frontend-production.up.railway.app/" + (req.params.page.startsWith("promo-") ? "promotions/all/" + encodeURIComponent(req.params.page) : "")));
    // Immutable, public website assets; retained for content revision rollback.
    app.get("/media/agency/:tenant/:asset.webp", wrap(async (req, res) => {
      const t = id(req.params.tenant);
      if (req.agencySite && req.agencySite.id !== t) fail(404, "Banner tidak ditemukan");
      const q = await pool.query("SELECT bytes FROM agency_banner_assets WHERE tenant_id=$1 AND id=$2", [t, id(req.params.asset)]);
      if (!q.rowCount) fail(404, "Banner tidak ditemukan");
      res.type("image/webp").set("Cache-Control", "public, max-age=31536000, immutable").send(Buffer.from(q.rows[0].bytes));
    }));
    for (const prefix of ["/api/agency", "/api/admin/agency/tenants/:tenant"]) {
      app.post(prefix + "/banner-upload", wrap(async (req, res) => {
        agency.allow(req, "website");
        const t = agency.scope(req);
        const image = await normalizeArtwork(req.body.image);
        const hash = digest(image.bytes.toString("base64"));
        const asset = await locked(pool, t, async db => {
          const old = await db.query("SELECT id,width,height FROM agency_banner_assets WHERE tenant_id=$1 AND hash=$2", [t, hash]);
          if (old.rowCount) return old.rows[0];
          const usage = await db.query("SELECT COALESCE(sum(octet_length(bytes)),0)::text AS size FROM agency_banner_assets WHERE tenant_id=$1", [t]);
          if (Number(usage.rows[0].size) + image.bytes.length > 50000000) fail(409, "Penyimpanan banner penuh; hubungi Playground");
          const q = await db.query("INSERT INTO agency_banner_assets(tenant_id,hash,bytes,width,height) VALUES($1,$2,$3,$4,$5) RETURNING id,width,height", [t, hash, image.bytes, image.width, image.height]);
          await audit(db, t, agency.actor(req).id, "banner.uploaded", q.rows[0].id, { size: image.bytes.length });
          return q.rows[0];
        });
        res.status(201).json({ ...asset, url: `/media/agency/${t}/${asset.id}.webp` });
      }));
      app.get(
        prefix + "/content",
        wrap(async (req, res) => {
          agency.allow(req, "website");
          res.json({
            items: (
              await pool.query(
                "SELECT * FROM agency_content WHERE tenant_id=$1 ORDER BY slug",
                [agency.scope(req)],
              )
            ).rows,
          });
        }),
      );
      app.put(
        prefix + "/content/:slug",
        wrap(async (req, res) => {
          agency.allow(req, "website");
          const t = agency.scope(req),
            p = req.body,
            s = req.params.slug;
          if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(s))
            fail(400, "Slug tidak valid");
          const data = validate(p.content);
          res.json(
            await locked(pool, t, async (db) => {
              await canonical(db, t, data);
              const old = (
                await db.query(
                  "SELECT * FROM agency_content WHERE tenant_id=$1 AND slug=$2 FOR UPDATE",
                  [t, s],
                )
              ).rows[0];
              if ((old?.version || 0) !== p.expected_version)
                fail(409, "Konten berubah; muat versi terbaru");
              const q = old
                ? await db.query(
                    "UPDATE agency_content SET draft=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
                    [t, old.id, asJson(data)],
                  )
                : await db.query(
                    "INSERT INTO agency_content(tenant_id,slug,draft) VALUES($1,$2,$3) RETURNING *",
                    [t, s, asJson(data)],
                  );
              const c = q.rows[0];
              await db.query(
                "INSERT INTO agency_content_revisions(tenant_id,content_id,version,body,actor) VALUES($1,$2,$3,$4,$5)",
                [t, c.id, c.version, asJson(data), agency.actor(req).id],
              );
              await audit(db, t, agency.actor(req).id, "content.saved", c.id, {
                version: c.version,
              });
              return c;
            }),
          );
        }),
      );
      app.post(
        prefix + "/content/:content/publish",
        wrap(async (req, res) => {
          agency.allow(req, "website");
          const t = agency.scope(req);
          res.json(
            await locked(pool, t, async (db) => {
              const c = (
                await db.query(
                  "SELECT * FROM agency_content WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
                  [t, id(req.params.content)],
                )
              ).rows[0];
              if (!c) fail(404, "Konten tidak ditemukan");
              if (c.version !== req.body.expected_version)
                fail(409, "Versi konten berubah");
              if (req.body.at) {
                const date = new Date(req.body.at);
                if (!Number.isFinite(date.getTime()) || date < Date.now())
                  fail(400, "Jadwal tidak valid");
                await db.query(
                  "UPDATE agency_content SET scheduled_at=$3 WHERE tenant_id=$1 AND id=$2",
                  [t, c.id, date.toISOString()],
                );
                return { ...c, scheduled_at: date.toISOString() };
              }
              return publish(db, t, c, agency.actor(req).id);
            }),
          );
        }),
      );
      app.post(
        prefix + "/content/:content/rollback",
        wrap(async (req, res) => {
          agency.allow(req, "website");
          const t = agency.scope(req);
          res.json(
            await locked(pool, t, async (db) => {
              const c = (
                await db.query(
                  "SELECT * FROM agency_content WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
                  [t, id(req.params.content)],
                )
              ).rows[0];
              if (!c) fail(404, "Konten tidak ditemukan");
              if (c.version !== req.body.expected_version)
                fail(409, "Versi konten berubah");
              const revision = (
                await db.query(
                  "SELECT body FROM agency_content_revisions WHERE tenant_id=$1 AND content_id=$2 AND version=$3",
                  [t, c.id, req.body.version],
                )
              ).rows[0];
              if (!revision) fail(404, "Versi tidak ditemukan");
              await db.query(
                "UPDATE agency_content SET draft=$3,version=version+1 WHERE tenant_id=$1 AND id=$2",
                [t, c.id, asJson(revision.body)],
              );
              await db.query(
                "INSERT INTO agency_content_revisions(tenant_id,content_id,version,body,actor) VALUES($1,$2,$3,$4,$5)",
                [
                  t,
                  c.id,
                  c.version + 1,
                  asJson(revision.body),
                  agency.actor(req).id,
                ],
              );
              return publish(
                db,
                t,
                { ...c, version: c.version + 1, draft: revision.body },
                agency.actor(req).id,
              );
            }),
          );
        }),
      );
      app.get(
        prefix + "/domains",
        wrap(async (req, res) => {
          agency.allow(req, "website");
          res.json({
            items: (
              await pool.query(
                "SELECT domain,token,verified_at,is_primary FROM agency_domains WHERE tenant_id=$1",
                [agency.scope(req)],
              )
            ).rows,
          });
        }),
      );
      app.post(
        prefix + "/domains",
        wrap(async (req, res) => {
          agency.allow(req, "website");
          const domain = String(req.body.domain || "").toLowerCase();
          if (
            !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
          )
            fail(400, "Domain tidak valid");
          const t = agency.scope(req),
            token = require("node:crypto").randomBytes(24).toString("hex");
          await pool.query(
            "INSERT INTO agency_domains(domain,tenant_id,token) VALUES($1,$2,$3)",
            [domain, t, token],
          );
          res.status(201).json({
            domain,
            record: "_playground." + domain,
            type: "TXT",
            value: token,
          });
        }),
      );
      app.post(
        prefix + "/domains/verify",
        wrap(async (req, res) => {
          agency.allow(req, "website");
          const t = agency.scope(req),
            domain = String(req.body.domain || "");
          const d = (
            await pool.query(
              "SELECT * FROM agency_domains WHERE tenant_id=$1 AND domain=$2",
              [t, domain],
            )
          ).rows[0];
          if (!d) fail(404, "Domain tidak ditemukan");
          let records = [];
          try {
            records = await dns.resolveTxt("_playground." + domain);
          } catch {}
          if (!records.some((x) => x.join("") === d.token))
            fail(409, "TXT verifikasi belum ditemukan");
          await locked(pool, t, async (db) => {
            if (req.body.primary)
              await db.query(
                "UPDATE agency_domains SET is_primary=false WHERE tenant_id=$1",
                [t],
              );
            await db.query(
              "UPDATE agency_domains SET verified_at=now(),is_primary=$3 WHERE tenant_id=$1 AND domain=$2",
              [t, domain, req.body.primary === true],
            );
            await audit(db, t, agency.actor(req).id, "domain.verified", domain);
          });
          res.json({
            verified: true,
            domain,
            tls_notice:
              "Hubungkan domain ke hosting dan verifikasi HTTPS sebelum aktivasi.",
          });
        }),
      );
    }
    renderSitemap = async (req, res) => {
      const t = (
        await pool.query("SELECT * FROM agency_tenants WHERE slug=$1", [
          req.params.slug,
        ])
      ).rows[0];
      if (!t || !t.website.published) fail(404, "Website belum dipublikasikan");
      const base = await siteBase(t);
      const pages =
        t.environment === "sandbox"
          ? []
          : (
              await pool.query(
                "SELECT slug,published FROM agency_content WHERE tenant_id=$1 AND published IS NOT NULL",
                [t.id],
              )
            ).rows;
      res.type("application/xml").send(
        '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
          pages
            .filter((x) => x.published.robots !== "noindex, nofollow")
            .map(
              (x) =>
                "<url><loc>" +
                escape(base + (x.slug === "home" ? "" : "/p/" + x.slug)) +
                "</loc></url>",
            )
            .join("") +
          "</urlset>",
      );
    };
    renderRobots = async (req, res) => {
      const t = (
        await pool.query("SELECT * FROM agency_tenants WHERE slug=$1", [
          req.params.slug,
        ])
      ).rows[0];
      if (!t) fail(404, "Website tidak ditemukan");
      res
        .type("text/plain")
        .send(
          t.environment === "sandbox"
            ? "User-agent: *\nDisallow: /\n"
            : "User-agent: *\nDisallow: /agency\nDisallow: /api/\nSitemap: " +
                (await siteBase(t)) +
                "/sitemap.xml\n",
        );
    };
    app.get("/site/:slug/sitemap.xml", wrap(renderSitemap));
    app.get("/site/:slug/robots.txt", wrap(renderRobots));
    async function page(req, res, preview = false) {
      const t = (
        await pool.query("SELECT * FROM agency_tenants WHERE slug=$1", [
          req.params.slug,
        ])
      ).rows[0];
      if (!t) fail(404, "Website tidak ditemukan");
      let c;
      if (req.params.page) {
        const p = (
          await pool.query(
            "SELECT * FROM agency_content WHERE tenant_id=$1 AND slug=$2",
            [t.id, req.params.page],
          )
        ).rows[0];
        c = preview ? p?.draft : p?.published;
      } else c = t.website;
      if (!c || (!preview && !req.params.page && !c.published))
        fail(404, "Website belum dipublikasikan");
      const list = await agency.games.catalog(pool, t.id, true),
        siteURL = await siteBase(t),
        canonicalURL =
          c.canonical ||
          siteURL + (req.params.page ? "/p/" + req.params.page : "");
      const chat =
        !!chatvice.origin && c.chatvice_enabled && c.chatvice_merchant;
      const chatAttrs = chat
        ? ' data-chatvice-origin="' +
          escape(chatvice.origin) +
          '" data-chatvice-merchant="' +
          escape(c.chatvice_merchant) +
          '"'
        : "";
      {
        const origin = chat ? new URL(chatvice.origin).origin : "";
        res.set(
          "Content-Security-Policy",
          `default-src 'self'; script-src 'self' ${origin}; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; frame-src ${origin || "\'none\'"}; connect-src 'self' ${origin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
        );
      }
      res
        .type("html")
        .send(
          `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(c.title || t.name)}</title><meta name="description" content="${escape(c.description)}"><meta name="robots" content="${preview || t.environment === "sandbox" ? "noindex, nofollow" : escape(c.robots || "index, follow")}"><link rel="canonical" href="${escape(canonicalURL)}"><meta property="og:title" content="${escape(c.title || t.name)}"><meta property="og:description" content="${escape(c.description)}"><meta property="og:url" content="${escape(canonicalURL)}">${c.og_image ? `<meta property="og:image" content="${escape(c.og_image)}">` : ""}<link rel="stylesheet" href="/assets/agency.css"></head><body class="storefront" data-tenant="${escape(t.slug)}"${chatAttrs} style="--accent:${escape(c.accent || "#7759ed")}"><header><a class="brand" href="${escape(siteURL)}">${escape(t.name)}</a><nav><a href="#games">Games</a><button id="account-open">Akun & Wallet</button><a href="/agency?tenant=${escape(t.slug)}">Admin agen</a></nav></header><main><div class="notice">${t.environment === "sandbox" ? "SIMULASI — koin dan pembayaran tidak bernilai uang nyata." : ""}</div><section class="hero">${c.banner_url ? '<img class="hero-image" alt="" src="' + escape(c.banner_url) + '">' : ""}<p class="eyebrow">WELCOME TO ${escape(t.name)}</p><h1>${escape(c.title || t.name)}</h1><p>${escape(c.description)}</p><div class="prose">${escape(c.body || "").replace(/\n/g, "<br>")}</div></section><section id="games"><h2>Game pilihan</h2><div class="game-grid">${list.map((g) => `<article class="game-card"><span class="game-mark">${escape(g.name.slice(0, 2).toUpperCase())}</span><h3>${escape(g.name)}</h3><p>${escape(g.readiness || "registered")}</p><button class="play-game" data-game="${g.id}" ${g.readiness === "publishable" && g.status === "Active" ? "" : "disabled"}>Main</button></article>`).join("") || "<p>Game belum dipilih agen.</p>"}</div></section><section id="player-panel" hidden></section><section class="help"><h2>Perlu bantuan?</h2><p>Gunakan dukungan agen untuk pertanyaan akun, transaksi, dan status permainan.</p><button id="help-open">Buat tiket bantuan</button></section></main><div id="toast" role="status"></div><dialog id="modal"></dialog><script src="/assets/agency-player.js" defer></script><script src="/assets/agency-chatvice.js" defer></script></body></html>`,
        );
    }
    renderPage = page;
    app.get(
      "/site/:slug",
      wrap((req, res) => page(req, res)),
    );
    app.get(
      "/site/:slug/p/:page",
      wrap((req, res) => page(req, res)),
    );
  }
  async function tick() {
    const due = (
      await pool.query(
        "SELECT tenant_id,id FROM agency_content WHERE scheduled_at<=now() LIMIT 20",
      )
    ).rows;
    for (const row of due)
      await locked(pool, row.tenant_id, async (db) => {
        const c = (
          await db.query(
            "SELECT * FROM agency_content WHERE tenant_id=$1 AND id=$2 AND scheduled_at<=now() FOR UPDATE",
            [row.tenant_id, row.id],
          )
        ).rows[0];
        if (c) await publish(db, row.tenant_id, c, "publisher");
      });
  }
  return { mount, tick, validate, domainRouter };
}
module.exports = { createContent, validate };
