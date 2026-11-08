(() => {
  "use strict";
  let current = "";
  function clear() {
    for (const id of [
      "playground-chatvice-signup",
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
  function signup() {
    clear();
    const link = document.createElement("a");
    link.id = "playground-chatvice-signup";
    link.style.cssText = "position:fixed;right:20px;bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:10000;display:grid;place-items:center;width:60px;height:60px;padding:12px;box-sizing:border-box;border-radius:50%;background:#fff;box-shadow:0 4px 24px #21104026";
    link.href = "https://chatvice.app";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "Daftar Chatvice — partner chat Playground");
    link.title = "Daftar Chatvice";
    const icon = document.createElement("img");
    icon.src = "https://chatvice.app/chatvice-logo-loading.png";
    icon.alt = "Chatvice";
    icon.style.cssText = "width:100%;height:100%;object-fit:contain;filter:brightness(0) saturate(100%) invert(32%) sepia(80%) saturate(2450%) hue-rotate(243deg) brightness(90%) contrast(95%)";
    link.appendChild(icon);
    document.body.appendChild(link);
  }
  function load(config) {
    if (!config) {
      signup();
      return;
    }
    let origin;
    try {
      origin = new URL(config.origin);
      if (origin.origin !== "https://chatvice.app") { signup(); return; }
    } catch {
      signup(); return;
    }
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(config.merchant)) { signup(); return; }
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
    script.onerror = signup;
    document.body.appendChild(script);
  }
  // Master support is available independently of the selected agency.
  // Credential/setup pages deliberately do not include this loader.
  const masterPaths = ["/engine", "/engine-v1", "/integrations", "/data", "/wallet", "/agents", "/native-studio"];
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
