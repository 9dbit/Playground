(() => {
  'use strict';
  if (document.getElementById('playground-ai-support')) return;
  const CHAT_ORIGIN = 'https://chatvice.app';
  const WIDGET_PATH = '/widget/m_36f76fcbe11167ed';
  let root, trigger, panel, status, frame, expiryTimer, readyTimer, opening = false, disposed = false;

  async function readConfig() {
    const response = await fetch('/api/admin/ai-support', {
      credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return null;
    const config = await response.json();
    if (!config.enabled || !Number.isFinite(config.validUntil) || config.validUntil <= Date.now()) return null;
    const url = new URL(config.url);
    if (url.origin !== CHAT_ORIGIN || url.pathname !== WIDGET_PATH || url.username || url.password) return null;
    if (url.searchParams.get('embedded') !== 'true' || url.searchParams.get('showClose') !== 'true') return null;
    return config;
  }

  function clearFrame() {
    clearTimeout(readyTimer);
    if (frame) frame.remove();
    frame = null;
  }

  function dispose() {
    disposed = true;
    clearFrame();
    clearTimeout(expiryTimer);
    root?.remove();
    window.removeEventListener('message', onMessage);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pagehide', dispose);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onLogout, true);
  }

  function setExpiry(validUntil) {
    clearTimeout(expiryTimer);
    // Do not poll: background polling would keep an idle admin session alive.
    expiryTimer = setTimeout(dispose, Math.max(0, validUntil - Date.now()));
  }

  function close() {
    if (!panel || disposed) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.focus();
  }

  async function open() {
    if (opening || disposed) return;
    if (!panel.hidden) return close();
    opening = true;
    trigger.disabled = true;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    status.hidden = false;
    status.textContent = 'Menghubungkan bantuan admin…';
    try {
      const config = await readConfig();
      if (disposed) return;
      if (!config) { dispose(); return; }
      setExpiry(config.validUntil);
      if (!frame) {
        frame = document.createElement('iframe');
        frame.title = 'Percakapan Playground AI Support';
        frame.referrerPolicy = 'origin';
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
        frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'");
        frame.src = config.url;
        panel.appendChild(frame);
        readyTimer = setTimeout(() => {
          status.hidden = false;
          status.textContent = 'Chat belum tersambung. Tutup lalu buka kembali untuk mencoba lagi.';
          clearFrame();
        }, 20000);
      } else {
        status.hidden = true;
      }
      panel.querySelector('button').focus();
    } catch {
      if (!disposed) {
        clearFrame();
        status.hidden = false;
        status.textContent = 'Bantuan belum tersambung. Tutup lalu buka kembali untuk mencoba lagi.';
      }
    } finally {
      opening = false;
      if (trigger && !disposed) trigger.disabled = false;
    }
  }

  function onMessage(event) {
    if (!frame || event.origin !== CHAT_ORIGIN || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'chatvice-ready') {
      clearTimeout(readyTimer);
      status.hidden = true;
    } else if (event.data?.type === 'chatvice-close') close();
  }
  function onKey(event) { if (event.key === 'Escape' && panel && !panel.hidden) close(); }
  function onLogout(event) {
    if (event.target instanceof Element && event.target.closest('[data-action="logout"], #sign-out')) dispose();
  }
  async function onFocus() {
    if (disposed || !panel || panel.hidden || opening) return;
    try {
      const config = await readConfig();
      if (!config) dispose();
      else if (!disposed) setExpiry(config.validUntil);
    } catch { close(); clearFrame(); }
  }

  async function init() {
    try {
      const config = await readConfig();
      if (!config || disposed) return;
      root = document.createElement('section');
      root.id = 'playground-ai-support';
      root.setAttribute('aria-label', 'Bantuan admin Playground');
      root.innerHTML = '<div id="playground-ai-panel" role="dialog" aria-labelledby="playground-ai-title" hidden>' +
        '<header><div><strong id="playground-ai-title">Playground AI Support</strong><small>Panduan menu &amp; troubleshooting</small></div>' +
        '<button type="button" aria-label="Tutup AI Support">×</button></header>' +
        '<p class="ai-support-note">Gunakan nama panggilan. Jangan kirim password, OTP, atau data pribadi pemain.</p>' +
        '<p class="ai-support-status" role="status" aria-live="polite"></p></div>' +
        '<button type="button" id="playground-ai-trigger" aria-controls="playground-ai-panel" aria-expanded="false">' +
        '<span aria-hidden="true">✦</span> AI Support</button>';
      document.body.appendChild(root);
      trigger = root.querySelector('#playground-ai-trigger');
      panel = root.querySelector('#playground-ai-panel');
      status = root.querySelector('.ai-support-status');
      trigger.addEventListener('click', open);
      panel.querySelector('button').addEventListener('click', close);
      window.addEventListener('message', onMessage);
      window.addEventListener('focus', onFocus);
      window.addEventListener('pagehide', dispose);
      document.addEventListener('keydown', onKey);
      document.addEventListener('click', onLogout, true);
      setExpiry(config.validUntil);
    } catch { /* Optional help must never prevent the dashboard from working. */ }
  }
  init();
})();
