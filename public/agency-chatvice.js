(() => {
  "use strict";
  let current = "";
  function clear() {
    for (const id of [
      "playground-chatvice-script",
      "chatvice-widget-frame",
      "chatvice-widget-button",
      "chatvice-welcome-bubble",
      "chatvice-eye-toggle",
      "chatvice-hidden-label",
    ])
      document.getElementById(id)?.remove();
    current = "";
  }
  function load(config) {
    if (!config) {
      clear();
      return;
    }
    let origin;
    try {
      origin = new URL(config.origin);
      if (origin.protocol !== "https:") return;
    } catch {
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(config.merchant)) return;
    const ref = origin.origin + ":" + config.merchant;
    if (current === ref) return;
    clear();
    current = ref;
    const script = document.createElement("script");
    script.id = "playground-chatvice-script";
    script.src =
      origin.origin +
      "/api/widget/chatvice.js?merchant=" +
      encodeURIComponent(config.merchant) +
      (config.version ? "&v=" + encodeURIComponent(config.version) : "");
    script.async = true;
    script.referrerPolicy = "origin";
    script.onerror = () => {
      clear();
    };
    document.body.appendChild(script);
  }
  // Master support is available independently of the selected agency.
  // Credential/setup pages deliberately do not include this loader.
  const masterPaths = ["/engine", "/engine-v1", "/integrations", "/data", "/wallet", "/agents"];
  if (masterPaths.includes(location.pathname.replace(/\/$/, ""))) {
    fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((account) => {
        if (!account || account.setupRequired) return;
        load({ origin: "https://chatvice.app", merchant: "m_36f76fcbe11167ed", version: "1793889257" });
      })
      .catch(() => {});
    return;
  }
  addEventListener("agency:help-context", (e) => load(e.detail));
  addEventListener("agency:logout", clear);
  if (document.body.dataset.chatviceMerchant)
    load({
      origin: document.body.dataset.chatviceOrigin,
      merchant: document.body.dataset.chatviceMerchant,
    });
})();
