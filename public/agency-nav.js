(() => {
  const add = () => {
    const nav =
      document.querySelector(".sidebar nav") || document.querySelector("nav");
    if (!nav || nav.querySelector("[data-agency-link]")) return;
    const a = document.createElement("a");
    a.href = "/agents";
    a.dataset.agencyLink = "true";
    a.textContent = "Platform Agen";
    nav.append(a);
  };
  new MutationObserver(add).observe(document.body, {
    childList: true,
    subtree: true,
  });
  add();
})();
