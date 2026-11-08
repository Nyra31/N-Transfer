/* Web app del móvil de N-Transfer (iOS y Android). */
'use strict';
(function () {
  const { translator, formatSize } = window.NT_I18N;
  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* modo privado */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* modo privado */ } },
  };
  const q = new URLSearchParams(location.search);
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const PARALLEL = 2;

  let token = q.get('d') || LS.get('nt-token');
  const pairCode = q.get('c');
  let me = null;
  let lang = LS.get('nt-lang') || ((navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en');
  let skin = q.get('skin') || LS.get('nt-skin') || 'winamp';
  let t = translator(lang);
  let online = false;
  let outbox = [];
  const queue = [];
  let active = 0;
  let done = 0;
  let speed = 0;
  let bytesTick = 0;
  const viz = window.NT_VIZ.createViz($('viz'), { barWidth: 3, gap: 2 });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function applyI18n() {
    document.documentElement.lang = lang;
    for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
    $('installText').textContent = isAndroid ? t('mInstallHintAndroid') : t('mInstallHint');
    for (const b of $('langRow').children) b.classList.toggle('active', b.dataset.lang === lang);
  }

  function applySkin() {
    document.body.className = 'nt skin-' + skin;
    for (const b of $('skinRow').children) b.classList.toggle('active', b.dataset.skin === skin);
    const meta = document.querySelector('meta[name=theme-color]');
    meta.content = skin === 'luna' ? '#0053e9' : skin === 'chrome' ? '#d6dae0' : '#1b1b24';
    requestAnimationFrame(() => viz.readColors());
  }

  function show(view) {
    for (const v of ['viewPair', 'viewNone', 'viewMain']) $(v).hidden = v !== view;
    $('btnMenu').hidden = view !== 'viewMain';
    tickMarquee();
  }

  function api(path, opts = {}) {
    return fetch(path, { ...opts, headers: { 'X-Device-Token': token || '', ...(opts.headers || {}) } });
  }

  function unpaired() {
    LS.del('nt-token');
    token = null;
    show('viewNone');
    online = false;
    renderLcd();
  }

  // ───────────── LCD ─────────────
  const marquee = { pos: 0, text: '' };
  function marqueeText() {
    const running = queue.filter((i) => i.state === 'up');
    if (running.length) {
      return running.map((i) => `▲ ${i.file.name} (${i.size ? Math.floor((i.received / i.size) * 100) : 0}%)`).join('  ***  ');
    }
    if (!token) return 'N-TRANSFER  ***  ' + t('mNotPairedTitle');
    if (!online) return t('mOffline');
    return t('mConnectedTo', { pc: me ? me.pcName : '…' });
  }
  function tickMarquee() {
    const box = $('marquee');
    const text = marqueeText();
    const chars = Math.max(10, Math.floor(box.clientWidth / 9.6));
    if (text !== marquee.text) marquee.text = text;
    if (text.length <= chars) {
      box.textContent = text;
      return;
    }
    const loop = text + '   ***   ';
    marquee.pos = (marquee.pos + 1) % loop.length;
    box.textContent = (loop + loop).slice(marquee.pos, marquee.pos + chars);
  }
  setInterval(tickMarquee, 200);

  function renderLcd() {
    const running = queue.filter((i) => i.state === 'up' || i.state === 'queued');
    $('lcdStatus').textContent = !token ? '—' : !online ? 'OFFLINE' : running.length ? t('sending') : t('ready');
    $('led').classList.toggle('on', running.length > 0);
    $('lcdSpeed').textContent = (speed / 1048576).toFixed(1);
    $('lcdSmall').textContent = queue.length ? `${done}/${queue.length}` : me ? me.pcName : '';
    const total = running.reduce((s, i) => s + i.size, 0);
    const got = running.reduce((s, i) => s + i.received, 0);
    $('seek').style.width = total ? ((got / total) * 100).toFixed(1) + '%' : '0%';
    $('keepOpen').hidden = running.length === 0;
    viz.setLevel(running.length ? 0.25 + Math.min(0.75, Math.sqrt(speed / (20 * 1048576))) : 0.03);
  }
  setInterval(() => {
    const inst = bytesTick / 0.5;
    bytesTick = 0;
    speed = active ? speed * 0.5 + inst * 0.5 : 0;
    renderLcd();
  }, 500);

  // ───────────── móvil → PC ─────────────
  function addFiles(files) {
    for (const file of files) {
      const li = el('li');
      const name = el('span', 'name', file.name);
      const state = el('span', 'state', t('mQueued'));
      const bar = el('div', 'nt-progress');
      const fill = el('i');
      bar.append(fill);
      li.append(name, state, bar);
      $('queue').prepend(li);
      queue.push({ file, li, stateEl: state, fill, bar, size: file.size, received: 0, state: 'queued' });
    }
    pump();
  }

  function pump() {
    $('queueTitle').hidden = queue.length === 0;
    $('queueSummary').textContent = queue.length ? t('mSentOf', { done, total: queue.length }) : '';
    while (active < PARALLEL) {
      const next = queue.find((i) => i.state === 'queued');
      if (!next) break;
      upload(next);
    }
    renderLcd();
  }

  function upload(item) {
    active++;
    item.state = 'up';
    item.received = 0;
    item.stateEl.className = 'state';
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/v1/upload');
    xhr.setRequestHeader('X-Device-Token', token);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.file.name));
    if (item.file.lastModified) xhr.setRequestHeader('X-File-Mtime', String(item.file.lastModified));
    xhr.upload.onprogress = (e) => {
      bytesTick += e.loaded - item.received;
      item.received = e.loaded;
      const pct = item.size ? Math.floor((e.loaded / item.size) * 100) : 0;
      item.fill.style.width = pct + '%';
      item.stateEl.textContent = pct + '%';
    };
    const finish = (ok, msg) => {
      active--;
      item.state = ok ? 'done' : 'error';
      item.stateEl.className = 'state ' + (ok ? 'ok' : 'err');
      item.stateEl.textContent = msg;
      if (ok) {
        done++;
        item.fill.style.width = '100%';
        item.bar.hidden = true;
        item.stateEl.textContent = '✓ ' + formatSize(item.size);
      } else {
        const retry = el('button', 'nt-btn small', t('mRetry'));
        retry.onclick = () => {
          retry.remove();
          item.state = 'queued';
          item.stateEl.textContent = t('mQueued');
          pump();
        };
        item.stateEl.textContent = '';
        item.stateEl.append(el('span', '', msg + ' '), retry);
      }
      pump();
    };
    xhr.onload = () => {
      if (xhr.status === 200) finish(true, t('mDone'));
      else if (xhr.status === 401) { finish(false, t('mError')); unpaired(); }
      else finish(false, t('mError'));
    };
    xhr.onerror = () => finish(false, t('mOffline'));
    xhr.send(item.file);
  }

  for (const id of ['pickMedia', 'pickFiles']) {
    $(id).addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
  }

  // ───────────── PC → móvil ─────────────
  function renderOutbox() {
    const ul = $('fromPc');
    ul.replaceChildren();
    for (const item of outbox) {
      const li = el('li');
      const info = el('span', 'name', item.name);
      const a = el('a', 'nt-btn', t('mDownload') + ' · ' + formatSize(item.size));
      a.href = `/api/v1/outbox/${item.id}?d=${encodeURIComponent(token)}`;
      // En la app de inicio de iOS la descarga dentro de la app no tiene «volver»: se abre en Safari.
      if (isIOS && standalone) a.target = '_blank';
      else a.download = item.name;
      li.append(info, a);
      ul.append(li);
    }
    $('countFromPc').textContent = outbox.length ? `(${outbox.length})` : '';
    $('emptyFromPc').hidden = outbox.length > 0;
  }

  // ───────────── conexión en vivo ─────────────
  let es = null;
  function connectEvents() {
    if (es) es.close();
    es = new EventSource('/api/v1/events?d=' + encodeURIComponent(token));
    es.onopen = () => { online = true; renderLcd(); };
    es.onerror = () => { online = false; renderLcd(); };
    es.addEventListener('outbox', (e) => { outbox = JSON.parse(e.data).items; renderOutbox(); });
    es.addEventListener('settings', (e) => {
      const s = JSON.parse(e.data);
      if (!LS.get('nt-skin')) { skin = s.skin; applySkin(); }
      if (!LS.get('nt-lang')) { lang = s.lang; t = translator(lang); applyI18n(); }
    });
    es.addEventListener('unpaired', () => { es.close(); unpaired(); });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token && (!es || es.readyState === 2)) connectEvents();
  });

  // ───────────── emparejar ─────────────
  function guessName() {
    if (/iPad/.test(ua)) return 'iPad';
    if (/iPhone/.test(ua)) return 'iPhone';
    const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
    if (m && !/^K$/.test(m[1])) return m[1].trim();
    return isAndroid ? 'Android' : lang === 'es' ? 'Móvil' : 'Phone';
  }

  async function doPair(code, name, btn, msg, errorKey) {
    btn.disabled = true;
    msg.textContent = t('mPairing');
    try {
      const r = await fetch('/api/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name, platform: isIOS ? 'ios' : isAndroid ? 'android' : 'web' }),
      });
      if (!r.ok) throw new Error('bad_code');
      token = (await r.json()).token;
      LS.set('nt-token', token);
      await goHome();
    } catch {
      msg.textContent = t(errorKey);
      btn.disabled = false;
    }
  }

  /** Intenta pasar a http://<pc>.local para que el icono de inicio sobreviva a cambios de IP. */
  async function tryLocalHost(info) {
    if (standalone || !info.host || location.hostname === info.host) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch(`http://${info.host}:${info.port}/api/v1/info`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return false;
      location.replace(`http://${info.host}:${info.port}/?d=${encodeURIComponent(token)}`);
      return true;
    } catch {
      return false;
    }
  }

  async function goHome() {
    const r = await api('/api/v1/me').catch(() => null);
    if (r && r.status === 401) return unpaired();
    if (!r || !r.ok) {
      show('viewMain');
      online = false;
      renderLcd();
      setTimeout(goHome, 4000);
      return;
    }
    me = await r.json();
    if (await tryLocalHost(me)) return;
    LS.set('nt-token', token);
    // El token tiene que estar en la URL *al cargar* la página: así el servidor escribe el manifest con él
    // y el icono de la pantalla de inicio (que no comparte almacenamiento con Safari) arranca emparejado.
    if (q.get('d') !== token) {
      location.replace('/?d=' + encodeURIComponent(token));
      return;
    }
    if (!LS.get('nt-skin') && !q.get('skin')) { skin = me.skin; applySkin(); }
    if (!LS.get('nt-lang')) { lang = me.lang; t = translator(lang); applyI18n(); }
    $('pcInfo').textContent = `${me.pcName} · ${me.host}:${me.port} · v${me.version}`;
    $('installHint').hidden = standalone || !(isIOS || isAndroid) || LS.get('nt-hint-hidden') === '1';
    show('viewMain');
    renderOutbox();
    connectEvents();
    renderLcd();
  }

  // ───────────── menú ─────────────
  $('btnMenu').onclick = () => ($('sheet').hidden = false);
  $('btnCloseSheet').onclick = () => ($('sheet').hidden = true);
  $('sheet').onclick = (e) => e.target === $('sheet') && ($('sheet').hidden = true);
  $('skinRow').onclick = (e) => {
    const s = e.target.closest('[data-skin]')?.dataset.skin;
    if (!s) return;
    skin = s;
    LS.set('nt-skin', s);
    applySkin();
  };
  $('langRow').onclick = (e) => {
    const l = e.target.closest('[data-lang]')?.dataset.lang;
    if (!l) return;
    lang = l;
    LS.set('nt-lang', l);
    t = translator(lang);
    applyI18n();
  };
  $('btnUnpair').onclick = () => {
    if (!confirm(t('mUnpairConfirm'))) return;
    unpaired();
    $('sheet').hidden = true;
    history.replaceState(null, '', '/');
  };
  $('btnHideHint').onclick = () => {
    LS.set('nt-hint-hidden', '1');
    $('installHint').hidden = true;
  };
  $('btnPair').onclick = () =>
    doPair(pairCode, $('devName').value || guessName(), $('btnPair'), $('pairMsg'), 'mPairError');
  $('btnCode').onclick = () =>
    doPair($('codeInput').value, guessName(), $('btnCode'), $('codeMsg'), 'mCodeError');
  $('codeInput').addEventListener('input', (e) => {
    // Formato XXXX-XXXX mientras se escribe
    const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    e.target.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v;
  });
  $('codeInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('btnCode').click());

  // ───────────── arranque ─────────────
  applySkin();
  applyI18n();
  (async () => {
    if (token) {
      const r = await api('/api/v1/me').catch(() => null);
      if (r && r.ok) return goHome();
      if (r && r.status === 401) {
        LS.del('nt-token');
        token = null;
      } else if (!pairCode) {
        return goHome(); // PC apagado o sin red: se reintenta solo
      }
    }
    if (pairCode) {
      $('devName').value = guessName();
      show('viewPair');
    } else {
      show('viewNone');
    }
    renderLcd();
  })();
})();
