(() => {
  "use strict";
  const $ = (s) => document.querySelector(s),
    E = (x) =>
      String(x ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
  const num = (x) => {
    try {
      return BigInt(x || 0).toLocaleString("id-ID");
    } catch {
      return E(x);
    }
  };
  const date = (x) => (x ? new Date(x).toLocaleString("id-ID") : "—");
  const master = location.pathname === "/agents";
  let me,
    tenant = new URLSearchParams(location.search).get("tenant_id") || "",
    tenants = [],
    base = "",
    csrf = "",
    view = "overview";
  async function request(url, method = "GET", body) {
    const r = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data;
    try {
      data = await r.json();
    } catch {
      throw Error("Respons tidak valid");
    }
    if (!r.ok || r.status === 202)
      throw Error(data.error || data.code || "Request gagal");
    return data;
  }
  const api = (p, m, b) => request(base + p, m, b);
  function toast(x) {
    $("#toast").textContent = x;
    $("#toast").style.display = "block";
    setTimeout(() => ($("#toast").style.display = "none"), 4500);
  }
  function field(name, label, value = "", type = "text", options) {
    return `<label class="${type === "textarea" ? "wide" : ""}">${E(label)}${type === "select" ? `<select name="${name}">${options.map((o) => `<option value="${E(o[0])}" ${String(value) === String(o[0]) ? "selected" : ""}>${E(o[1])}</option>`).join("")}</select>` : type === "textarea" ? `<textarea name="${name}">${E(value)}</textarea>` : `<input name="${name}" type="${type}" value="${E(value)}" ${type === "password" ? 'autocomplete="current-password"' : ""}>`}</label>`;
  }
  function form(title, fields, submit, label = "Simpan") {
    const d = $("#modal");
    d.innerHTML = `<header><h2>${E(title)}</h2><button class="quiet small" type="button" id="close-dialog">Tutup</button></header><form><div class="fields">${fields}</div><p class="error"></p><footer><button type="submit">${E(label)}</button></footer></form>`;
    d.dataset.key = crypto.randomUUID();
    $("#close-dialog").onclick = () => d.close();
    d.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const b = d.querySelector("[type=submit]");
      b.disabled = true;
      try {
        await submit(
          Object.fromEntries(new FormData(e.currentTarget)),
          d.dataset.key,
        );
        d.close();
        toast("Tersimpan");
        await render();
      } catch (err) {
        d.querySelector(".error").textContent = err.message;
      } finally {
        b.disabled = false;
      }
    };
    if (!d.open) d.showModal();
  }
  function bannerEditor() {
    const d = $("#modal"), url = d.querySelector('[name="banner_url"]');
    const box = document.createElement("section");
    box.className = "banner-editor wide";
    box.innerHTML = `<h3>Hero banner</h3><img class="banner-preview" alt="Preview hero banner" hidden><p class="banner-status muted" role="status"></p><div class="toolbar"><button type="button" class="secondary" data-banner="choose">Upload gambar</button><button type="button" class="quiet" data-banner="delete">Delete banner</button></div><input type="file" accept="image/png,image/jpeg,image/webp" hidden><p class="muted">JPG, PNG, atau WebP, maksimal 10 MB. Gambar dioptimalkan otomatis. Simpan lalu Publish untuk menampilkan perubahan.</p>`;
    url.parentElement.before(box);
    const preview = box.querySelector("img"), status = box.querySelector('[role="status"]'), file = box.querySelector("input");
    const choose = box.querySelector('[data-banner="choose"]'), remove = box.querySelector('[data-banner="delete"]');
    let pending = "", generation = 0;
    const update = () => {
      const source = pending || url.value.trim();
      preview.hidden = !source;
      if (source) preview.src = source; else preview.removeAttribute("src");
      choose.textContent = source ? "Replace gambar" : "Upload gambar";
      remove.disabled = !source;
    };
    preview.onerror = () => { status.textContent = "Preview tidak tersedia. Periksa URL atau upload gambar."; };
    choose.onclick = () => file.click();
    remove.onclick = () => {
      generation++; pending = ""; url.value = ""; file.value = "";
      status.textContent = "Banner dihapus dari draft. Klik Simpan lalu Publish."; update();
    };
    url.oninput = () => { generation++; pending = ""; status.textContent = ""; update(); };
    file.onchange = async () => {
      const selected = file.files[0]; if (!selected) return;
      const token = ++generation;
      choose.disabled = true; d.querySelector('[type="submit"]').disabled = true;
      status.textContent = "Menyiapkan gambar…";
      let bitmap;
      try {
        if (!['image/png','image/jpeg','image/webp'].includes(selected.type) || selected.size > 10000000) throw Error("Pilih JPG, PNG, atau WebP maksimal 10 MB.");
        bitmap = await createImageBitmap(selected);
        if (bitmap.width * bitmap.height > 16777216) throw Error("Resolusi gambar maksimal 16 megapiksel.");
        const canvas = document.createElement('canvas');
        let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        let blob;
        for (let attempt = 0; attempt < 6; attempt++) {
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
          if (blob && blob.size <= 500000) break;
          scale *= 0.75;
        }
        if (!blob || blob.size > 500000) throw Error("Gambar belum dapat dioptimalkan. Pilih gambar lain.");
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
        });
        if (token !== generation || !d.open) return;
        pending = data;
        status.textContent = `${selected.name} · ${Math.ceil(blob.size / 1000)} KB · siap disimpan`;
        update();
      } catch (e) { if (token === generation) status.textContent = e.message || "Gambar gagal dibaca"; }
      finally { bitmap?.close(); choose.disabled = false; d.querySelector('[type="submit"]').disabled = false; file.value = ""; }
    };
    update();
    return async () => {
      if (pending) { const result = await api('/banner-upload', 'POST', { image: pending }); url.value = result.url; pending = ""; update(); }
      return url.value.trim();
    };
  }
  function inspect(title, data) {
    const d = $("#modal");
    d.innerHTML = `<header><h2>${E(title)}</h2><button class="quiet" id="close-dialog">Tutup</button></header><pre class="json">${E(JSON.stringify(data, null, 2))}</pre>`;
    $("#close-dialog").onclick = () => d.close();
    if (!d.open) d.showModal();
  }
  function table(columns, rows) {
    if (!rows.length) return '<div class="empty">Belum ada data.</div>';
    return (
      '<div class="table-wrap"><table><thead><tr>' +
      columns.map((x) => "<th>" + E(x) + "</th>").join("") +
      "</tr></thead><tbody>" +
      rows
        .map(
          (r) => "<tr>" + r.map((c) => "<td>" + c + "</td>").join("") + "</tr>",
        )
        .join("") +
      "</tbody></table></div>"
    );
  }
  const pill = (x) =>
    `<span class="pill ${["credited", "paid", "active", "approved", "published"].includes(x) ? "good" : "pending"}">${E(x)}</span>`;
  const button = (action, id, label, extra = "") =>
    `<button class="small secondary" data-action="${action}" data-id="${E(id)}" ${extra}>${E(label)}</button>`;
  const can = (p) => master || me?.permissions?.includes(p);
  async function login() {
    const q = new URLSearchParams(location.search);
    $("#app").innerHTML =
      `<div class="login-card"><a class="brand" href="/agency">PLAYGROUND / AGEN</a><h1>Masuk workspace</h1><p class="muted">Akses operasional khusus agen Anda.</p><form id="login-form">${field("tenant", "Kode agen", q.get("tenant") || "")}${field("username", "Username")}${field("password", "Password", "", "password")}${field("code", "Kode authenticator (jika aktif)")}<p class="error"></p><button type="submit">Masuk</button></form><p class="muted" style="margin-top:20px">Admin Playground: <a href="/agents">buka panel induk</a></p></div>`;
    $("#login-form").onsubmit = async (e) => {
      e.preventDefault();
      const b = e.currentTarget.querySelector("button");
      b.disabled = true;
      try {
        me = await request(
          "/api/agency/auth/login",
          "POST",
          Object.fromEntries(new FormData(e.currentTarget)),
        );
        csrf = me.csrf;
        await start();
      } catch (err) {
        $(".error").textContent = err.message;
      } finally {
        b.disabled = false;
      }
    };
  }
  async function enroll() {
    base = "/api/agency";
    $("#app").innerHTML =
      '<div class="login-card"><a class="brand">PLAYGROUND / AGEN</a><h1>Amankan akun staff</h1><p>Aktifkan authenticator sebelum mengelola transaksi.</p><button id="enroll">Siapkan authenticator</button><div id="enrollment"></div></div>';
    $("#enroll").onclick = () =>
      form(
        "Aktifkan authenticator",
        field("password", "Password", "", "password"),
        async (p) => {
          const r = await api("/auth/mfa/start", "POST", p);
          setTimeout(() => {
            const target = $("#enrollment");
            target.innerHTML = `<p class="muted" style="margin-top:20px">Tambahkan secret berikut ke authenticator Anda.</p><pre class="json">${E(r.secret)}</pre><label>Kode authenticator<input id="mfa-code" inputmode="numeric"></label><button id="confirm-mfa">Konfirmasi</button><p class="error"></p>`;
            $("#confirm-mfa").onclick = async () => {
              try {
                await api("/auth/mfa/confirm", "POST", {
                  code: $("#mfa-code").value,
                });
                me = await api("/me");
                await start();
              } catch (e) {
                target.querySelector(".error").textContent = e.message;
              }
            };
          }, 50);
        },
        "Buat secret",
      );
  }
  const nav = [
    ["help", "Panduan operasional", "overview"],
    ["overview", "Ringkasan", "overview"],
    ["players", "Player", "players.read"],
    ["transactions", "Deposit & Withdraw", "finance.read"],
    ["coins", "Stok koin", "finance.read"],
    ["games", "Game pilihan", "overview"],
    ["website", "Website & SEO", "website"],
    ["team", "Staff & IP", "team"],
    ["policy", "Aturan withdraw", "policy"],
    ["reports", "Analitik", "reports"],
    ["billing", "Invoice", "billing"],
    ["support", "Bantuan", "support"],
    ["audit", "Audit", "audit"],
  ];
  async function start() {
    if (!me) {
      try {
        me = await request(master ? "/api/auth/session" : "/api/agency/me");
        csrf = me.csrf;
      } catch {
        if (master) {
          location.href = "/login";
          return;
        }
        return login();
      }
    }
    if (!master && me.setup_required) return enroll();
    if (master) {
      tenants = (await request("/api/admin/agency/tenants")).items;
      if (!tenants.some((x) => x.id === tenant)) tenant = tenants[0]?.id || "";
    } else tenant = me.tenant.id;
    base = master ? "/api/admin/agency/tenants/" + tenant : "/api/agency";
    const selected = master ? tenants.find((x) => x.id === tenant) : me.tenant;
    $("#app").innerHTML =
      `<div class="shell"><aside class="sidebar"><a class="brand" href="${master ? "/engine" : "/agency"}">PLAYGROUND<span class="muted"> / ${master ? "MASTER" : "AGEN"}</span></a>${master ? `<select id="tenant-select" aria-label="Pilih agen">${tenants.map((t) => `<option value="${t.id}" ${t.id === tenant ? "selected" : ""}>${E(t.name)}</option>`).join("")}</select><button id="new-tenant" class="secondary small" style="margin-top:10px">+ Agen baru</button>` : `<p><strong>${E(selected?.name)}</strong><br><small>${E(me.display_name)} · ${E(me.role)}</small></p>`}<nav>${nav
        .filter((x) => can(x[2]))
        .map((x) => `<a href="#${x[0]}" data-view="${x[0]}">${E(x[1])}</a>`)
        .join(
          "",
        )}</nav><div class="meta"><small>Satu platform. Akses sesuai peran.</small>${master ? '<p><a href="/engine">Kembali ke GameOps</a></p>' : '<p><button id="logout" class="small quiet">Keluar</button></p>'}</div></aside><main class="workspace"><div class="topbar"><div><p class="eyebrow">${E(selected?.name || "PLATFORM AGEN")}</p><h1 id="page-title">Ringkasan</h1></div><div class="actions">${selected ? `<a class="button secondary small" href="/site/${E(selected.slug)}" target="_blank" rel="noopener">Lihat website</a>` : ""}<button id="refresh" class="quiet small">Refresh</button></div></div><div id="body"></div></main></div>`;
    if (master) {
      $("#new-tenant").onclick = newTenant;
      $("#tenant-select").onchange = async (e) => {
        const u = new URL(location.href);
        u.searchParams.set("tenant_id", e.target.value);
        location.assign(u.toString());
      };
    } else
      $("#logout").onclick = async () => {
        await api("/auth/logout", "POST", {});
        dispatchEvent(new Event("agency:logout"));
        me = null;
        csrf = "";
        location.reload();
      };
    $("#refresh").onclick = render;
    view = location.hash.slice(1) || "overview";
    await render();
    if (tenant) {
      api("/help")
        .then((x) =>
          dispatchEvent(
            new CustomEvent("agency:help-context", { detail: x.chatvice }),
          ),
        )
        .catch(() => {});
    }
  }
  function newTenant() {
    form(
      "Buat agen sandbox",
      field("name", "Nama brand") +
        field("slug", "Kode agen") +
        field("owner_username", "Username owner") +
        field(
          "owner_password",
          "Password owner (min. 15 karakter)",
          "",
          "password",
        ) +
        field("fee_basis", "Basis invoice", "net", "select", [
          ["net", "Penjualan dikurangi withdraw"],
          ["gross", "Penjualan koin total"],
        ]) +
        field("rate", "Persentase fee", "20", "number") +
        field("account_mode", "Account gateway", "SHARED", "select", [
          ["SHARED", "Satu saldo"],
          ["SPLIT", "Deposit dan withdraw terpisah"],
        ]),
      async (p) => {
        const r = await request("/api/admin/agency/tenants", "POST", {
          ...p,
          rate_bps: Math.round(Number(p.rate) * 100),
        });
        tenant = r.tenant.id;
        await start();
      },
      "Buat agen",
    );
  }
  async function stepup(action, resource, p, credentials) {
    const g = await api("/step-up", "POST", {
      action,
      resource,
      payload: p,
      ...credentials,
    });
    return { ...p, approval_token: g.approval_token };
  }
  async function render() {
    if (!$("#body")) return;
    if (master && !tenant) {
      $("#body").innerHTML =
        '<div class="card empty">Buat agen pertama untuk mulai konfigurasi dan simulasi.</div>';
      return;
    }
    document
      .querySelectorAll("[data-view]")
      .forEach((a) => a.classList.toggle("active", a.dataset.view === view));
    $("#page-title").textContent =
      nav.find((x) => x[0] === view)?.[1] || "Ringkasan";
    const b = $("#body");
    b.innerHTML = '<p class="loading">Memuat…</p>';
    try {
      if (view === "overview") {
        const r = await api("/overview");
        const n = (code) =>
          r.balances.find((x) => x.code === code)?.amount || "0";
        b.innerHTML = `<div class="notice">${r.tenant.environment === "sandbox" ? "MODE SIMULASI · Pembayaran dan koin tidak bernilai uang nyata." : "Mode operasional"}</div><div class="cards">${[
          ["Player", r.counts.players],
          ["Ronde", r.counts.rounds],
          ["Stok koin tersedia", n("stock:available")],
          ["Tiket terbuka", r.counts.tickets],
        ]
          .map(
            (x) =>
              `<div class="metric"><span>${x[0]}</span><strong>${num(x[1])}</strong></div>`,
          )
          .join(
            "",
          )}</div><div class="toolbar">${master ? button("fund", "", "Tambah dana simulasi") + button("risk-fund", "", "Cadangan koin game") : ""}</div><div class="card"><h2>Perlu ditindaklanjuti</h2>${table(
          ["Transaksi", "Status", "Nominal", "Waktu"],
          r.exceptions.map((x) => [
            E(x.kind),
            pill(x.state),
            num(x.amount),
            date(x.created_at),
          ]),
        )}</div><div class="card"><h2>Kas & stok</h2>${table(
          ["Akun", "Unit", "Saldo"],
          r.balances
            .filter(
              (x) =>
                !x.code.startsWith("player:") &&
                !x.code.startsWith("external:"),
            )
            .map((x) => [E(x.code), E(x.unit), num(x.amount)]),
        )}</div><p class="muted">Diperbarui ${date(r.as_of)}</p>`;
        b.querySelector('[data-action="fund"]')?.addEventListener("click", () =>
          form(
            "Tambah dana simulasi",
            field("amount", "Nominal", "", "number") +
              field("target", "Tujuan", "withdraw", "select", [
                ["withdraw", "Account withdraw"],
                ["deposit", "Account deposit"],
              ]),
            (p, k) =>
              api("/simulation/fund", "POST", { ...p, idempotency_key: k }),
          ),
        );
        b.querySelector('[data-action="risk-fund"]')?.addEventListener(
          "click",
          () =>
            form(
              "Cadangan koin kemenangan",
              field("amount", "Koin", "", "number"),
              (p, k) =>
                api("/simulation/fund", "POST", {
                  ...p,
                  target: "risk",
                  idempotency_key: k,
                }),
            ),
        );
      } else if (view === "players") {
        const r = await api("/players");
        b.innerHTML =
          '<div class="card">' +
          table(
            ["Player", "Status", "Terdaftar", ""],
            r.items.map((x) => [
              E(x.display_name) + "<br><small>" + E(x.username) + "</small>",
              pill(x.status),
              date(x.created_at),
              button("player", x.id, "Detail"),
            ]),
          ) +
          "</div>";
        b.querySelectorAll('[data-action="player"]').forEach(
          (el) =>
            (el.onclick = async () =>
              inspect("Detail player", await api("/players/" + el.dataset.id))),
        );
      } else if (view === "transactions") {
        const r = await api("/transactions");
        b.innerHTML =
          '<div class="card">' +
          table(
            ["Transaksi", "Nominal / Koin", "Status", "Waktu", "Aksi"],
            r.items.map((x) => [
              E(x.kind) +
                " · " +
                E(x.method) +
                "<br><small>" +
                E(x.id.slice(0, 8)) +
                "</small>",
              num(x.amount) + " / " + num(x.coins),
              pill(x.state),
              date(x.created_at),
              button("tx-detail", x.id, "Detail") +
                (!master &&
                x.kind === "deposit" &&
                ["pending", "payment_received_credit_pending"].includes(
                  x.state,
                ) &&
                can("deposit.approve")
                  ? button("deposit-approve", x.id, "Approve")
                  : "") +
                (!master &&
                x.kind === "withdraw" &&
                x.state === "review" &&
                can("withdraw.approve")
                  ? button("withdraw-review", x.id, "Review")
                  : "") +
                (master &&
                x.kind === "deposit" &&
                x.method !== "manual" &&
                !x.data.received
                  ? button("sim-payment", x.id, "Simulasikan bayar")
                  : "") +
                (master &&
                x.kind === "deposit" &&
                x.data.received &&
                !x.data.settled &&
                !x.data.manual_bank &&
                x.state !== "refunded"
                  ? button("sim-settle", x.id, "Settlement")
                  : "") +
                (master &&
                x.kind === "withdraw" &&
                ["queued", "unknown", "submitted", "paid"].includes(x.state)
                  ? button("sim-payout", x.id, "Status payout")
                  : ""),
            ]),
          ) +
          "</div>";
        b.querySelectorAll("[data-action]").forEach(
          (el) =>
            (el.onclick = async () => {
              const x = r.items.find((x) => x.id === el.dataset.id),
                act = el.dataset.action;
              if (act === "tx-detail") return inspect("Detail transaksi", x);
              if (act === "sim-payment")
                return form(
                  "Simulasi pembayaran diterima",
                  field("reference", "Referensi provider", "sim-" + x.id),
                  (p) =>
                    api("/simulation/payment/" + x.id, "POST", {
                      ...p,
                      amount: x.amount,
                    }),
                );
              if (act === "sim-settle") {
                await api("/simulation/settlement/" + x.id, "POST", {});
                return render();
              }
              if (act === "sim-payout")
                return form(
                  "Simulasi status provider",
                  field(
                    "result",
                    "Status",
                    "paid",
                    "select",
                    x.state === "paid"
                      ? [["reversed", "Reversed / dana kembali"]]
                      : [
                          ["paid", "Paid"],
                          ["unknown", "Timeout / belum pasti"],
                          ["failed", "Failed final"],
                        ],
                  ),
                  (p) => api("/simulation/payout/" + x.id, "POST", p),
                );
              if (act === "deposit-approve") {
                const manual = x.method === "manual";
                return form(
                  manual ? "Approve transfer manual" : "Validasi supervisor",
                  manual
                    ? field("bank_reference", "Referensi mutasi bank") +
                        field(
                          "evidence_note",
                          "Catatan pencocokan mutasi",
                          "",
                          "textarea",
                        )
                    : field("password", "Password supervisor", "", "password") +
                        field("code", "Kode authenticator"),
                  async (p) => {
                    if (!manual)
                      p = await stepup("deposit.override", x.id, {}, p);
                    return api("/deposits/" + x.id + "/approve", "POST", p);
                  },
                  "Verifikasi dan approve",
                );
              }
              if (act === "withdraw-review")
                return form(
                  "Review withdraw",
                  `<p class="wide">${num(x.amount)} → ${E(x.beneficiary)}</p>` +
                    field("decision", "Keputusan", "approve", "select", [
                      ["approve", "Approve — beneficiary sudah diverifikasi"],
                      ["reject", "Reject"],
                    ]) +
                    field("reason", "Alasan / catatan") +
                    field("password", "Password supervisor", "", "password") +
                    field("code", "Kode authenticator"),
                  async (p) => {
                    const body = {
                      decision: p.decision,
                      reason: p.reason,
                      beneficiary_verified: p.decision === "approve",
                    };
                    return api(
                      "/withdrawals/" + x.id + "/review",
                      "POST",
                      await stepup("withdraw.review", x.id, body, {
                        password: p.password,
                        code: p.code,
                      }),
                    );
                  },
                );
            }),
        );
      } else if (view === "coins") {
        const r = await api("/coins");
        b.innerHTML = `<div class="toolbar">${can("coins.request") ? button("request", "", "Request alokasi koin") : ""}</div><div class="card">${table(
          ["Koin", "Status", "Alasan", "Tanggal", ""],
          r.items.map((x) => [
            num(x.amount),
            pill(x.status),
            E(x.reason),
            date(x.created_at),
            master && x.status === "requested"
              ? button("allocation", x.id, "Review")
              : "",
          ]),
        )}</div>`;
        b.querySelector('[data-action="request"]')?.addEventListener(
          "click",
          () =>
            form(
              "Request alokasi koin",
              field("amount", "Jumlah koin", "", "number") +
                field("reason", "Alasan", "", "textarea"),
              (p) => api("/coins", "POST", p),
            ),
        );
        b.querySelectorAll('[data-action="allocation"]').forEach(
          (el) =>
            (el.onclick = () =>
              form(
                "Review alokasi",
                field("decision", "Keputusan", "approve", "select", [
                  ["approve", "Approve"],
                  ["reject", "Reject"],
                ]),
                (p) => api("/coins/" + el.dataset.id + "/review", "POST", p),
              )),
        );
      } else if (view === "games") {
        const r = await api("/games");
        b.innerHTML =
          '<div class="notice">Readiness menunjukkan tahap integrasi. Game baru dapat dimainkan setelah launch dan wallet terverifikasi.</div><div class="card">' +
          table(
            ["Game", "Readiness", "Diizinkan", "Di website", ""],
            r.items.map((x) => [
              E(x.name),
              pill(x.readiness || "registered"),
              x.entitled ? "Ya" : "Tidak",
              x.selected ? "Ya" : "Tidak",
              can("games.select") ? button("game", x.id, "Atur") : "",
            ]),
          ) +
          "</div>";
        b.querySelectorAll('[data-action="game"]').forEach(
          (el) =>
            (el.onclick = () => {
              const x = r.items.find((x) => x.id === el.dataset.id);
              form(
                "Game " + x.name,
                field(
                  "selected",
                  "Tampilkan di website",
                  String(x.selected),
                  "select",
                  [
                    ["true", "Ya"],
                    ["false", "Tidak"],
                  ],
                ) +
                  field("position", "Urutan", x.position, "number") +
                  (master
                    ? field(
                        "entitled",
                        "Izin Playground",
                        String(x.entitled),
                        "select",
                        [
                          ["true", "Diizinkan"],
                          ["false", "Tidak diizinkan"],
                        ],
                      )
                    : ""),
                (p) =>
                  api("/games/" + x.id, "PUT", {
                    selected: p.selected === "true",
                    position: Number(p.position),
                    ...(master ? { entitled: p.entitled === "true" } : {}),
                  }),
              );
            }),
        );
      } else if (view === "team") {
        const r = await api("/staff");
        b.innerHTML =
          '<div class="toolbar">' +
          button("new-staff", "", "Tambah staff") +
          '</div><div class="card">' +
          table(
            ["Staff", "Role", "Status", "MFA", "IP whitelist", ""],
            r.items.map((x) => [
              E(x.display_name) + "<br><small>" + E(x.username) + "</small>",
              E(x.role),
              pill(x.status),
              x.mfa_enabled ? "Aktif" : "Belum aktif",
              E(x.ip_allowlist.join(", ") || "Tidak dibatasi"),
              button("staff", x.id, "Edit"),
            ]),
          ) +
          "</div>";
        const opts = [
          "owner",
          "finance",
          "supervisor",
          "support",
          "marketing",
          "analyst",
        ].map((x) => [x, x]);
        b.querySelector('[data-action="new-staff"]').onclick = () =>
          form(
            "Tambah staff",
            field("username", "Username") +
              field("display_name", "Nama") +
              field("role", "Role", "support", "select", opts) +
              field(
                "password",
                "Password awal (min. 15 karakter)",
                "",
                "password",
              ) +
              field("ips", "IP/CIDR, pisahkan koma"),
            (p) =>
              api("/staff", "POST", {
                username: p.username,
                display_name: p.display_name,
                role: p.role,
                password: p.password,
                ip_allowlist: p.ips
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              }),
          );
        b.querySelectorAll('[data-action="staff"]').forEach(
          (el) =>
            (el.onclick = () => {
              const s = r.items.find((x) => x.id === el.dataset.id);
              form(
                "Edit staff — sesi akan dicabut",
                field("role", "Role", s.role, "select", opts) +
                  field("status", "Status", s.status, "select", [
                    ["active", "Aktif"],
                    ["disabled", "Nonaktif"],
                  ]) +
                  field("ips", "IP/CIDR", s.ip_allowlist.join(", ")),
                (p) =>
                  api("/staff/" + s.id, "PATCH", {
                    role: p.role,
                    status: p.status,
                    ip_allowlist: p.ips
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  }),
              );
            }),
        );
      } else if (view === "policy") {
        const r = await api("/policy");
        b.innerHTML = `<div class="card"><h2>Aturan withdraw agen</h2><p>Kurang dari ${num(r.policy.withdraw_threshold)} menjadi kandidat otomatis. Nilai sama atau lebih besar memerlukan review.</p><p>Limit kumulatif harian: ${num(r.policy.daily_withdraw_limit)} · Maksimum ${r.policy.daily_withdraw_count} request.</p><p class="muted">Saldo, dana disbursement, beneficiary dan risiko tetap diperiksa.</p>${button("policy", "", "Ubah aturan")}</div>`;
        b.querySelector('[data-action="policy"]').onclick = () =>
          form(
            "Ubah aturan withdraw",
            field(
              "auto_withdraw",
              "Auto-withdraw",
              String(r.policy.auto_withdraw),
              "select",
              [
                ["true", "Aktif"],
                ["false", "Manual semua"],
              ],
            ) +
              field(
                "withdraw_threshold",
                "Threshold",
                r.policy.withdraw_threshold,
                "number",
              ) +
              field(
                "daily_withdraw_limit",
                "Limit harian",
                r.policy.daily_withdraw_limit,
                "number",
              ) +
              field(
                "daily_withdraw_count",
                "Maks. request harian",
                r.policy.daily_withdraw_count,
                "number",
              ) +
              (!master
                ? field("password", "Password", "", "password") +
                  field("code", "Authenticator")
                : ""),
            async (p) => {
              let body = {
                expected_version: r.config_version,
                policy: {
                  ...r.policy,
                  auto_withdraw: p.auto_withdraw === "true",
                  withdraw_threshold: p.withdraw_threshold,
                  daily_withdraw_limit: p.daily_withdraw_limit,
                  daily_withdraw_count: Number(p.daily_withdraw_count),
                },
              };
              if (!master)
                body = await stepup("policy.update", tenant, body, {
                  password: p.password,
                  code: p.code,
                });
              return api("/policy", "PUT", body);
            },
          );
      } else if (view === "help") {
        const r = await api("/help");
        b.innerHTML =
          '<div class="notice">Panduan versi ' +
          E(r.version) +
          "</div>" +
          r.guide
            .map(
              (x) =>
                '<div class="card"><h2>' +
                E(x.title) +
                "</h2><p>" +
                E(x.body) +
                "</p></div>",
            )
            .join("") +
          '<div class="card"><h2>Chatvice</h2><p>' +
          E(
            r.chatvice
              ? "Panduan eksternal telah dikonfigurasi. Data transaksi privat tidak diteruskan ke widget."
              : "Merchant Chatvice belum dihubungkan. Gunakan panduan dan tiket dukungan.",
          ) +
          '</p><a href="#support">Buka tiket dukungan</a></div>';
      } else if (view === "reports") {
        const r = await api("/reports");
        b.innerHTML =
          '<div class="toolbar"><button id="export-transactions" class="secondary">Export transaksi bulan ini</button></div><div class="notice">' +
          E(r.notice) +
          '</div><div class="card">' +
          table(
            [
              "Game",
              "Ronde settled",
              "Stake",
              "Payout",
              "Net win rounds",
              "Observed RTP",
            ],
            r.items.map((x) => [
              E(x.name),
              num(x.settled),
              num(x.stake),
              num(x.payout),
              num(x.net_wins),
              BigInt(x.stake) > 0n
                ? (
                    Number((BigInt(x.payout) * 10000n) / BigInt(x.stake)) / 100
                  ).toFixed(2) + "%"
                : "—",
            ]),
          ) +
          "</div>";
        $("#export-transactions").onclick = async () => {
          try {
            const r = await fetch(base + "/reports/export", {
              credentials: "same-origin",
            });
            if (!r.ok) throw Error((await r.json()).error);
            const u = URL.createObjectURL(await r.blob()),
              a = document.createElement("a");
            a.href = u;
            a.download = "transaksi.csv";
            a.click();
            setTimeout(() => URL.revokeObjectURL(u), 1000);
          } catch (e) {
            toast(e.message);
          }
        };
      } else if (view === "billing") {
        const r = await api("/billing");
        b.innerHTML = `<div class="toolbar">${button("billing-preview", "", "Preview periode")}${master ? button("billing-close", "", "Tutup buku") + button("contract", "", "Atur kontrak") : ""}</div><div class="card"><h2>Kontrak</h2>${table(
          ["Berlaku", "Basis", "Fee"],
          r.contracts.map((x) => [
            E(x.effective_period),
            E(x.basis),
            E(x.rate_bps / 100) + "%",
          ]),
        )}</div><div class="card"><h2>Invoice & credit note</h2>${table(
          ["Periode", "Tagihan / kredit", "Dibayar", ""],
          r.invoices.map((x) => [
            E(x.period),
            num(x.total),
            num(x.paid),
            button("invoice", x.id, "Statement") +
              (master && BigInt(x.total) > BigInt(x.paid)
                ? button("invoice-pay", x.id, "Catat pembayaran")
                : ""),
          ]),
        )}</div>`;
        const current = new Date(Date.now() + 7 * 3600000)
          .toISOString()
          .slice(0, 7);
        b.querySelector('[data-action="billing-preview"]').onclick = () =>
          form(
            "Preview billing",
            field("period", "Periode YYYY-MM", current),
            async (p) => {
              const s = await api(
                "/billing/preview?period=" + encodeURIComponent(p.period),
              );
              setTimeout(() => inspect("Preview invoice", s), 50);
            },
            "Hitung",
          );
        b.querySelector('[data-action="billing-close"]')?.addEventListener(
          "click",
          () =>
            form(
              "Tutup buku simulasi",
              field("period", "Periode", current) +
                field(
                  "exception_note",
                  "Catatan review exception",
                  "",
                  "textarea",
                ),
              (p) =>
                api("/billing/close", "POST", { ...p, simulation_close: true }),
              "Finalisasi",
            ),
        );
        b.querySelector('[data-action="contract"]')?.addEventListener(
          "click",
          () =>
            form(
              "Versi kontrak",
              field("effective_period", "Berlaku mulai YYYY-MM", current) +
                field(
                  "basis",
                  "Basis",
                  r.contracts.at(-1)?.basis || "net",
                  "select",
                  [
                    ["net", "Penjualan dikurangi withdraw"],
                    ["gross", "Penjualan total"],
                  ],
                ) +
                field("rate", "Fee %", "20", "number"),
              (p) =>
                api("/contract", "PUT", {
                  effective_period: p.effective_period,
                  basis: p.basis,
                  rate_bps: Math.round(Number(p.rate) * 100),
                }),
            ),
        );
        b.querySelectorAll('[data-action="invoice"]').forEach(
          (el) =>
            (el.onclick = () =>
              inspect(
                "Statement",
                r.invoices.find((x) => x.id === el.dataset.id),
              )),
        );
        b.querySelectorAll('[data-action="invoice-pay"]').forEach(
          (el) =>
            (el.onclick = () =>
              form(
                "Catat pembayaran invoice",
                field("amount", "Nominal", "", "number") +
                  field("reference", "Referensi pembayaran"),
                (p, k) =>
                  api("/billing/" + el.dataset.id + "/payment", "POST", {
                    ...p,
                    idempotency_key: k,
                  }),
              )),
        );
      } else if (view === "website") {
        const r = await api("/content");
        b.innerHTML =
          '<div class="toolbar">' +
          button("new-content", "", "Tambah halaman") +
          button("domains", "", "Domain & HTTPS") +
          '</div><div class="card">' +
          table(
            ["Halaman", "Judul", "Versi", "Publikasi", ""],
            r.items.map((x) => [
              E(x.slug),
              E(x.draft.title),
              E(x.version),
              x.published ? "Terbit" : "Draft",
              button("content", x.id, "Edit") +
                button("publish", x.id, "Publish") +
                button("rollback", x.id, "Rollback"),
            ]),
          ) +
          "</div>";
        const edit = (c) => {
          let saveBanner;
          form(
            "Konten & SEO",
            (!c ? field("slug", "Slug (home untuk beranda)", "home") : "") +
              field("title", "Judul", c?.draft.title || "") +
              field(
                "description",
                "Meta description",
                c?.draft.description || "",
                "textarea",
              ) +
              field("body", "Konten", c?.draft.body || "", "textarea") +
              field("banner_url", "URL banner", c?.draft.banner_url || "") +
              field(
                "canonical",
                "Canonical (kosong = otomatis)",
                c?.draft.canonical || "",
              ) +
              field(
                "accent",
                "Warna brand",
                c?.draft.accent || "#7759ed",
                "color",
              ) +
              field(
                "chatvice_merchant",
                "Merchant Chatvice",
                c?.draft.chatvice_merchant || "",
              ) +
              field(
                "chatvice_enabled",
                "Widget Chatvice",
                String(c?.draft.chatvice_enabled || false),
                "select",
                [
                  ["false", "Nonaktif"],
                  ["true", "Aktif jika integrasi tersedia"],
                ],
              ),
            async (p) => {
              const { slug: s, ...content } = p;
              content.banner_url = await saveBanner();
              content.chatvice_enabled = p.chatvice_enabled === "true";
              return api(
                "/content/" + encodeURIComponent(c?.slug || s),
                "PUT",
                { content, expected_version: c?.version || 0 },
              );
            },
          );
          saveBanner = bannerEditor();
        };
        b.querySelector('[data-action="new-content"]').onclick = () =>
          edit(null);
        b.querySelectorAll('[data-action="content"]').forEach(
          (el) =>
            (el.onclick = () =>
              edit(r.items.find((x) => x.id === el.dataset.id))),
        );
        b.querySelectorAll('[data-action="publish"]').forEach(
          (el) =>
            (el.onclick = () => {
              const c = r.items.find((x) => x.id === el.dataset.id);
              form(
                "Publish halaman",
                field("at", "Jadwal (kosong = sekarang)", "", "datetime-local"),
                (p) =>
                  api("/content/" + c.id + "/publish", "POST", {
                    expected_version: c.version,
                    ...(p.at ? { at: new Date(p.at).toISOString() } : {}),
                  }),
              );
            }),
        );
        b.querySelectorAll('[data-action="rollback"]').forEach(
          (el) =>
            (el.onclick = () => {
              const c = r.items.find((x) => x.id === el.dataset.id);
              form(
                "Rollback konten",
                field("version", "Nomor versi", "", "number"),
                (p) =>
                  api("/content/" + c.id + "/rollback", "POST", {
                    version: Number(p.version),
                    expected_version: c.version,
                  }),
              );
            }),
        );
        b.querySelector('[data-action="domains"]').onclick = async () => {
          const d = await api("/domains");
          form(
            "Domain website",
            `<pre class="json wide">${E(JSON.stringify(d.items, null, 2))}</pre>` +
              field("domain", "Domain") +
              field("action", "Tindakan", "add", "select", [
                ["add", "Tambahkan dan buat TXT"],
                ["verify", "Verifikasi TXT sebagai domain utama"],
              ]),
            async (p) => {
              const result = await api(
                p.action === "add" ? "/domains" : "/domains/verify",
                "POST",
                { domain: p.domain, primary: true },
              );
              setTimeout(() => inspect("Konfigurasi domain", result), 50);
            },
          );
        };
      } else if (view === "support") {
        const r = await api("/tickets");
        b.innerHTML =
          '<div class="card"><h2>Panduan operasional</h2><p>Deposit otomatis memerlukan bukti provider. Withdraw approved belum berarti paid. Saldo kas, stok koin dan wallet player mempunyai fungsi berbeda.</p><p>Gunakan tiket untuk eskalasi. Widget Chatvice tersedia setelah merchant dan domain dikonfigurasi.</p>' +
          button("ticket-new", "", "Buat tiket") +
          '</div><div class="card">' +
          table(
            ["Subjek", "Status", "Diperbarui", ""],
            r.items.map((x) => [
              E(x.subject),
              pill(x.status),
              date(x.updated_at),
              button("ticket", x.id, "Buka & balas"),
            ]),
          ) +
          "</div>";
        b.querySelector('[data-action="ticket-new"]').onclick = () =>
          form(
            "Tiket bantuan",
            field("subject", "Subjek") + field("body", "Pesan", "", "textarea"),
            (p) => api("/tickets", "POST", p),
          );
        b.querySelectorAll('[data-action="ticket"]').forEach(
          (el) =>
            (el.onclick = () => {
              const t = r.items.find((x) => x.id === el.dataset.id);
              form(
                t.subject,
                `<div class="wide">${t.messages.map((m) => `<p>${E(m.body)}<br><small>${date(m.at)}</small></p>`).join("")}</div>` +
                  field("body", "Balasan", "", "textarea") +
                  field("status", "Status", "answered", "select", [
                    ["answered", "Answered"],
                    ["pending", "Pending"],
                    ["closed", "Closed"],
                  ]),
                (p) => api("/tickets/" + t.id + "/reply", "POST", p),
              );
            }),
        );
      } else if (view === "audit") {
        const r = await api("/audit");
        b.innerHTML =
          '<div class="card">' +
          table(
            ["Waktu", "Tindakan", "Actor", "Resource"],
            r.items.map((x) => [
              date(x.created_at),
              E(x.action),
              E(x.actor),
              E(x.resource),
            ]),
          ) +
          "</div>";
      } else {
        view = "overview";
        return render();
      }
    } catch (e) {
      b.innerHTML = '<div class="card error">' + E(e.message) + "</div>";
    }
  }
  window.addEventListener("hashchange", () => {
    view = location.hash.slice(1) || "overview";
    render();
  });
  window.addEventListener("unhandledrejection", (e) =>
    toast(e.reason?.message || "Request gagal"),
  );
  start();
})();
