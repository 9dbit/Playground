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
      encodeURIComponent(config.merchant);
    script.async = true;
    script.referrerPolicy = "origin";
    script.onerror = () => {
      clear();
    };
    document.body.appendChild(script);
  }
  addEventListener("agency:help-context", (e) => load(e.detail));
  addEventListener("agency:logout", clear);
  if (document.body.dataset.chatviceMerchant)
    load({
      origin: document.body.dataset.chatviceOrigin,
      merchant: document.body.dataset.chatviceMerchant,
    });
})();
