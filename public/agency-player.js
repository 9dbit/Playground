(() => {
  "use strict";
  const tenant = document.body.dataset.tenant,
    $ = (s) => document.querySelector(s),
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
  let me,
    csrf = "";
  const n = (x) => {
    try {
      return BigInt(x || 0).toLocaleString("id-ID");
    } catch {
      return "—";
    }
  };
  async function api(p, m = "GET", b) {
    const r = await fetch("/api/player" + p, {
      method: m,
      credentials: "same-origin",
      headers: {
        ...(b ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    const d = await r.json();
    if (!r.ok || r.status === 202) throw Error(d.error || "Request gagal");
    return d;
  }
  const input = (name, label, type = "text") =>
    `<label>${E(label)}<input name="${name}" type="${type}" required></label>`;
  function form(title, fields, send) {
    const d = $("#modal");
    d.innerHTML = `<header><h2>${E(title)}</h2><button id="dialog-close" class="quiet small">Tutup</button></header><form>${fields}<p class="error"></p><footer><button type="submit">Lanjutkan</button></footer></form>`;
    const key = crypto.randomUUID();
    $("#dialog-close").onclick = () => d.close();
    d.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const button = d.querySelector("[type=submit]");
      button.disabled = true;
      try {
        await send(Object.fromEntries(new FormData(e.currentTarget)), key);
        d.close();
        await wallet();
      } catch (err) {
        d.querySelector(".error").textContent = err.message;
      } finally {
        button.disabled = false;
      }
    };
    if (!d.open) d.showModal();
  }
  function login(register = false) {
    form(
      register ? "Daftar player" : "Masuk akun",
      input("username", "Username") +
        input("password", "Password (min. 15 karakter)", "password") +
        `<p><button type="button" id="switch-auth" class="quiet small">${register ? "Sudah punya akun? Masuk" : "Daftar akun baru"}</button></p>`,
      async (p) => {
        me = await api(register ? "/auth/register" : "/auth/login", "POST", {
          ...p,
          tenant,
        });
        csrf = me.csrf;
      },
    );
    $("#switch-auth").onclick = () => login(!register);
  }
  async function account() {
    try {
      me = await api("/me");
      if (me.tenant.slug !== tenant) {
        me = null;
        return login();
      }
      csrf = me.csrf;
      await wallet();
    } catch {
      return login();
    }
  }
  async function wallet() {
    if (!me) return;
    const r = await api("/wallet"),
      panel = $("#player-panel");
    panel.hidden = false;
    const available =
        r.balances.find((x) => x.code.endsWith(":available"))?.amount || 0,
      reserved =
        r.balances.find((x) => x.code.endsWith(":reserved"))?.amount || 0;
    panel.innerHTML = `<div class="card"><h2>Wallet ${E(me.display_name)}</h2><div class="cards"><div class="metric"><span>Koin tersedia</span><strong>${n(available)}</strong></div><div class="metric"><span>Koin direservasi</span><strong>${n(reserved)}</strong></div></div><div class="toolbar"><button id="deposit">Deposit</button><button id="withdraw" class="secondary">Withdraw</button><button id="wallet-refresh" class="quiet">Refresh</button><button id="player-logout" class="quiet">Keluar</button></div><p class="muted">${r.tenant.environment === "sandbox" ? "Mode simulasi. Jangan mengirim uang nyata." : ""}</p></div><div class="card"><h2>Riwayat transaksi</h2><div class="table-wrap"><table><thead><tr><th>Jenis</th><th>Nominal</th><th>Status</th><th>Waktu</th></tr></thead><tbody>${r.transactions.map((x) => `<tr><td>${E(x.kind)} · ${E(x.method)}</td><td>${n(x.amount)}</td><td><span class="pill">${E(x.state)}</span></td><td>${E(new Date(x.created_at).toLocaleString("id-ID"))}</td></tr>`).join("")}</tbody></table></div></div>`;
    $("#deposit").onclick = () =>
      form(
        "Deposit",
        input("amount", "Nominal", "number") +
          '<label>Metode<select name="method"><option value="qris">QRIS simulasi</option><option value="va">Virtual account simulasi</option><option value="manual">Transfer manual simulasi</option></select></label><p class="muted">Mode simulasi: QRIS/VA dikonfirmasi oleh simulator saat worker aktif. Transfer manual diperiksa admin agen.</p>',
        (p, k) => api("/deposits", "POST", { ...p, idempotency_key: k }),
      );
    $("#withdraw").onclick = () =>
      form(
        "Withdraw",
        input("amount", "Nominal", "number") +
          input("beneficiary", "Bank / rekening tujuan") +
          '<p class="muted">Rekening baru memerlukan verifikasi agen. Approved belum berarti dana terkirim.</p>',
        (p, k) => api("/withdrawals", "POST", { ...p, idempotency_key: k }),
      );
    $("#wallet-refresh").onclick = wallet;
    $("#player-logout").onclick = async () => {
      await api("/auth/logout", "POST", {});
      me = null;
      csrf = "";
      panel.hidden = true;
    };
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#account-open").onclick = account;
  $("#help-open").onclick = async () => {
    if (!me) return account();
    form(
      "Bantuan player",
      input("subject", "Subjek") +
        '<label>Pesan<textarea name="body" required></textarea></label>',
      (p) => api("/tickets", "POST", p),
    );
  };
  document.querySelectorAll(".play-game").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          if (!me) return account();
          const r = await api("/launch", "POST", { game_id: b.dataset.game });
          const u = new URL(r.game.launch_url);
          u.hash = "playground_launch=" + encodeURIComponent(r.token);
          location.assign(u.toString());
        } catch (e) {
          const t = $("#toast");
          t.textContent = e.message;
          t.style.display = "block";
          setTimeout(() => (t.style.display = "none"), 5000);
        }
      }),
  );
})();
