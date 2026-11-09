/* Web app del móvil de N-Transfer (iOS y Android). */
'use strict';
(function () {
  const { translator, formatSize } = window.NT_I18N;
  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* modo privado */ } },
    json(k, def) { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } },
  };
  const q = new URLSearchParams(location.search);
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const PARALLEL = 2;
  const MAX_RETRIES = 40;
  const MAX_HISTORY = 150;
  const ICONS = { photo: '▣', video: '▶', other: '■', text: '✉', folder: '▤' };
  const VIZ_MODES = ['bars', 'scope', 'off'];

  /** El PC que sirve esta página. Los demás PCs emparejados están en `pcs`. */
  const HOME = { id: null, base: '', token: q.get('d') || LS.get('nt-token'), name: '' };
  let pcs = LS.json('nt-pcs', {}); // id → {id, name, base, token}
  let targetId = LS.get('nt-target') || null;
  let peers = [];
  const pairCode = q.get('c');
  let me = null;
  let lang = LS.get('nt-lang') || ((navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en');
  let skin = q.get('skin') || LS.get('nt-skin') || 'winamp';
  let skins = [{ id: 'winamp' }, { id: 'chrome' }, { id: 'luna' }];
  let t = translator(lang);
  const online = {}; // pcId → bool
  const outboxes = {}; // pcId → items
  const queue = [];
  let active = 0;
  let speed = 0;
  let bytesTick = 0;
  const viz = window.NT_VIZ.createViz($('viz'), { barWidth: 3, gap: 2 });
  viz.setMode(LS.get('nt-viz') || 'bars');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const kindOf = (f) => (/^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif|dng)$/i.test(f.name) ? 'photo'
    : /^video\//.test(f.type) || /\.(mov|mp4|m4v|3gp|webm)$/i.test(f.name) ? 'video' : 'other');
  const isUrl = (s) => /^https?:\/\/\S+$/.test(String(s).trim());
  const target = () => (targetId && pcs[targetId]) || HOME;
  const pcKey = (pc) => pc.id || 'home';
  const savePcs = () => LS.set('nt-pcs', JSON.stringify(pcs));

  function call(pc, path, opts = {}) {
    return fetch(pc.base + path, { ...opts, headers: { 'X-Device-Token': pc.token || '', ...(opts.headers || {}) } });
  }
  const postJson = (pc, path, body) => call(pc, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // ───────────── idioma y skin ─────────────
  function applyI18n() {
    document.documentElement.lang = lang;
    for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
    for (const e of document.querySelectorAll('[data-i18n-placeholder]')) e.placeholder = t(e.dataset.i18nPlaceholder);
    $('installText').textContent = isAndroid ? t('mInstallHintAndroid') : t('mInstallHint');
    for (const b of $('langRow').children) b.classList.toggle('active', b.dataset.lang === lang);
    renderSkinRow();
    for (const item of queue) { item.btnKey = null; renderItemState(item); }
    renderOutbox();
    renderHistory();
    renderTargets();
    renderPcList();
  }

  function renderSkinRow() {
    const names = { winamp: t('skinWinamp'), chrome: t('skinChrome'), luna: t('skinLuna') };
    $('skinRow').replaceChildren(...skins.map((s) => {
      const b = el('button', 'nt-btn' + (s.id === skin ? ' active' : ''), s.name || names[s.id] || s.id);
      b.dataset.skin = s.id;
      return b;
    }));
  }

  /** Las skins personalizadas del PC se cargan como hojas de estilo aparte. */
  function loadCustomSkins() {
    for (const s of skins.filter((x) => x.custom)) {
      if (document.querySelector(`link[data-skin="${s.id}"]`)) continue;
      const link = el('link');
      link.rel = 'stylesheet';
      link.href = `/skins/${s.id}.css`;
      link.dataset.skin = s.id;
      document.head.append(link);
    }
  }

  function applySkin() {
    if (!skins.some((s) => s.id === skin)) skin = 'winamp';
    document.body.className = 'nt skin-' + skin;
    renderSkinRow();
    const meta = document.querySelector('meta[name=theme-color]');
    meta.content = skin === 'luna' ? '#0053e9' : skin === 'chrome' ? '#d6dae0' : '#1b1b24';
    requestAnimationFrame(() => viz.readColors());
  }

  function show(view) {
    for (const v of ['viewPair', 'viewNone', 'viewMain']) $(v).hidden = v !== view;
    $('btnMenu').hidden = view !== 'viewMain';
    tickMarquee();
  }

  function unpaired() {
    LS.del('nt-token');
    HOME.token = null;
    show('viewNone');
    online[pcKey(HOME)] = false;
    renderLcd();
  }

  // ───────────── LCD ─────────────
  const marquee = { pos: 0, text: '' };
  function marqueeText() {
    const running = queue.filter((i) => i.state === 'up');
    if (running.length) {
      return running.map((i) => `▲ ${i.file.name} (${i.size ? Math.floor((i.received / i.size) * 100) : 0}%)`).join('  ***  ');
    }
    if (queue.some((i) => i.state === 'waiting')) return t('mWaiting');
    if (!HOME.token) return 'N-TRANSFER  ***  ' + t('mNotPairedTitle');
    const tg = target();
    if (!online[pcKey(tg)]) return t('mOffline');
    return t('mConnectedTo', { pc: tg.name || (me ? me.pcName : '…') });
  }
  function tickMarquee() {
    const box = $('marquee');
    const text = marqueeText();
    const chars = Math.max(8, Math.floor(box.clientWidth / 9.1));
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

  let lastThumb = null;
  function renderLcd() {
    const pending = queue.filter((i) => ['up', 'queued', 'preparing', 'waiting'].includes(i.state));
    const up = queue.filter((i) => i.state === 'up');
    let status = t('ready');
    if (!HOME.token) status = '—';
    else if (!online[pcKey(target())]) status = 'OFFLINE';
    else if (up.length) status = t('sending');
    else if (queue.some((i) => i.state === 'waiting')) status = t('waiting');
    else if (queue.some((i) => i.state === 'paused')) status = t('paused');
    $('lcdStatus').textContent = status;
    $('led').classList.toggle('on', up.length > 0);
    $('lcdSpeed').textContent = (speed / 1048576).toFixed(1);
    const done = queue.filter((i) => i.state === 'done').length;
    const total = queue.filter((i) => i.state !== 'cancelled').length;
    $('lcdSmall').textContent = total ? `${done}/${total}` : target().name || (me ? me.pcName : '');
    const size = pending.reduce((s, i) => s + i.size, 0);
    const got = pending.reduce((s, i) => s + i.received, 0);
    $('seek').style.width = size ? ((got / size) * 100).toFixed(1) + '%' : '0%';
    $('keepOpen').hidden = pending.length === 0;
    viz.setLevel(up.length ? 0.25 + Math.min(0.75, Math.sqrt(speed / (20 * 1048576))) : 0.03);
    $('queueTitle').hidden = queue.length === 0;
    $('queueSummary').textContent = total ? t('mSentOf', { done, total }) : '';

    // Vista previa: la subida activa más reciente
    const cur = up[up.length - 1] || null;
    const src = cur && cur.thumbData ? cur.thumbData : null;
    if (src !== lastThumb) {
      lastThumb = src;
      if (src) $('lcdImg').src = src;
    }
    $('lcdThumb').classList.toggle('has-img', !!src);
    $('lcdGlyph').textContent = cur ? ICONS[cur.kind] : 'N';
  }
  setInterval(() => {
    const inst = bytesTick / 0.5;
    bytesTick = 0;
    speed = active ? speed * 0.5 + inst * 0.5 : 0;
    renderLcd();
  }, 500);

  $('viz').onclick = () => {
    const next = VIZ_MODES[(VIZ_MODES.indexOf(viz.mode) + 1) % VIZ_MODES.length];
    viz.setMode(next);
    LS.set('nt-viz', next);
  };

  // ───────────── miniaturas (de una en una: el iPhone tiene poca memoria para decodificar fotos grandes) ─────────────
  let thumbChain = Promise.resolve();
  function makeThumb(file, kind) {
    if (kind === 'other') return Promise.resolve(null);
    const job = thumbChain.then(() => new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      let settled = false;
      const done = (data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        resolve(data);
      };
      const timer = setTimeout(() => done(null), 6000);
      const draw = (src, w, h) => {
        if (!w || !h) return done(null);
        const s = Math.min(1, 240 / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.round(w * s);
        c.height = Math.round(h * s);
        try {
          c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
          done(c.toDataURL('image/jpeg', 0.72));
        } catch {
          done(null);
        }
      };
      if (kind === 'photo') {
        const img = new Image();
        img.onload = () => draw(img, img.naturalWidth, img.naturalHeight);
        img.onerror = () => done(null);
        img.src = url;
      } else {
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.onloadeddata = () => {
          v.currentTime = Math.min(0.5, (v.duration || 1) / 3);
        };
        v.onseeked = () => draw(v, v.videoWidth, v.videoHeight);
        v.onerror = () => done(null);
        v.src = url;
        v.load();
      }
    }));
    thumbChain = job.catch(() => null);
    return job;
  }

  /** Miniatura diminuta para el historial guardado en el móvil (cabe mucho en poco espacio). */
  function tinyThumb(dataUrl) {
    return new Promise((resolve) => {
      if (!dataUrl) return resolve(null);
      const img = new Image();
      img.onload = () => {
        const s = 64 / Math.max(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * s));
        c.height = Math.max(1, Math.round(img.height * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.6));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  // ───────────── historial guardado en el móvil ─────────────
  function loadHistory() {
    return LS.json('nt-history', []);
  }
  async function addHistory(entry) {
    let list = [entry, ...loadHistory()].slice(0, MAX_HISTORY);
    // Si no cabe, se quitan miniaturas de las entradas más antiguas
    while (!LS.set('nt-history', JSON.stringify(list))) {
      const withThumb = list.map((e, i) => (e.thumb ? i : -1)).filter((i) => i >= 0).pop();
      if (withThumb === undefined) { list = list.slice(0, Math.floor(list.length / 2)); if (!list.length) break; continue; }
      list[withThumb] = { ...list[withThumb], thumb: null };
    }
    renderHistory();
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date(Date.now() - 86400000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, today)) return t('mToday');
    if (same(d, y)) return t('mYesterday');
    return d.toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function renderHistory() {
    // Lo de esta sesión ya aparece en «Enviados»: aquí solo lo anterior
    const sessionStart = window.__ntSession || (window.__ntSession = Date.now());
    const items = loadHistory().filter((h) => h.at < sessionStart);
    $('histTitle').hidden = items.length === 0;
    const ul = $('histList');
    ul.replaceChildren();
    let lastDay = '';
    for (const h of items) {
      const day = dayLabel(h.at);
      if (day !== lastDay) {
        ul.append(el('li', 'day', day));
        lastDay = day;
      }
      const li = el('li');
      const thumb = el('span', 'thumb');
      if (h.thumb) {
        const img = el('img');
        img.src = h.thumb;
        thumb.append(img);
      } else thumb.textContent = ICONS[h.kind] || '■';
      const when = new Date(h.at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
      li.append(thumb, el('span', 'name', h.name), el('span', 'btns'),
        el('span', 'state', `${h.kind === 'text' ? '' : formatSize(h.size) + ' · '}${when}${h.pc ? ' · ' + h.pc : ''}`));
      ul.append(li);
    }
  }
  $('btnClearHist').onclick = () => {
    LS.del('nt-history');
    renderHistory();
  };

  // ───────────── móvil → PC: subidas reanudables ─────────────
  function addFiles(files) {
    const pc = target();
    for (const file of files) {
      const item = {
        file, pc, kind: kindOf(file), size: file.size, received: 0, state: 'queued', session: null, xhr: null,
        retries: 0, retryTimer: null, thumbData: null,
      };
      buildItem(item);
      queue.push(item);
    }
    pump();
  }

  function buildItem(item) {
    const li = el('li');
    const thumb = el('span', 'thumb', ICONS[item.kind]);
    const name = el('span', 'name', item.file.name);
    const btns = el('span', 'btns');
    const state = el('span', 'state');
    const bar = el('div', 'nt-progress');
    const fill = el('i');
    bar.append(fill);
    li.append(thumb, name, btns, state, bar);
    $('queue').prepend(li);
    Object.assign(item, { li, thumbEl: thumb, stateEl: state, btnsEl: btns, bar, fill });
    renderItemState(item);
  }

  function setThumb(item) {
    if (!item.thumbData || item.thumbEl.querySelector('img')) return;
    const img = el('img');
    img.src = item.thumbData;
    item.thumbEl.replaceChildren(img);
  }

  function renderItemState(item) {
    if (!item.li) return;
    const pct = item.size ? Math.floor((item.received / item.size) * 100) : 0;
    const multi = Object.keys(pcs).length > 0;
    const labels = {
      queued: t('mQueued'), preparing: t('mQueued'), up: pct + '%', paused: `${t('mPaused')} · ${pct}%`,
      waiting: `${t('mWaiting')} · ${pct}%`, done: '✓ ' + formatSize(item.size), error: t('mError'), cancelled: t('mCancelled'),
    };
    item.stateEl.textContent = (item.note || labels[item.state] || '') + (multi && item.pc.name ? ` → ${item.pc.name}` : '');
    item.stateEl.className = 'state' + (item.state === 'done' ? ' ok' : item.state === 'error' ? ' err' : '');
    item.fill.style.width = pct + '%';
    item.bar.hidden = item.state === 'done' || item.state === 'cancelled';
    // Botones según el estado. Solo se rehacen si el estado cambia: rehacerlos con cada progreso
    // haría que un toque cayera en un botón que ya no existe.
    const btnKey = item.state + '|' + lang;
    if (item.btnKey === btnKey) return;
    item.btnKey = btnKey;
    const btns = [];
    const b = (label, fn) => {
      const x = el('button', 'nt-btn', label);
      x.onclick = fn;
      btns.push(x);
    };
    if (['up', 'queued', 'preparing', 'waiting'].includes(item.state)) b('❚❚', () => pauseItem(item));
    if (item.state === 'paused') b('▶', () => resumeItem(item));
    if (item.state === 'error') b(t('mRetry'), () => resumeItem(item));
    if (!['done', 'cancelled'].includes(item.state)) b('×', () => cancelItem(item));
    item.btnsEl.replaceChildren(...btns);
  }

  function pump() {
    while (active < PARALLEL) {
      const next = queue.find((i) => i.state === 'queued');
      if (!next) break;
      run(next);
    }
    renderLcd();
  }

  async function run(item) {
    active++;
    item.state = 'preparing';
    item.note = '';
    renderItemState(item);
    const pc = item.pc;
    try {
      if (!item.session) {
        item.thumbData = await makeThumb(item.file, item.kind);
        setThumb(item);
        const r = await postJson(pc, '/api/v1/uploads', {
          name: item.file.name, size: item.size, mtime: item.file.lastModified || 0, type: item.file.type || '', thumb: item.thumbData,
        });
        if (r.status === 401) { if (pc === HOME) unpaired(); throw Object.assign(new Error('401'), { fatal: true }); }
        if (!r.ok) throw Object.assign(new Error('http ' + r.status), { status: r.status });
        item.session = await r.json();
        item.received = item.session.offset;
        if (item.received > 0) item.note = t('mResuming', { pct: Math.floor((item.received / item.size) * 100) });
      } else {
        const r = await call(pc, `/api/v1/uploads/${item.session.id}`);
        if (r.status === 410) return markCancelled(item);
        if (!r.ok) throw Object.assign(new Error('http ' + r.status), { status: r.status });
        const s = await r.json();
        item.received = s.offset;
        if (s.state === 'paused') { item.state = 'paused'; return; }
      }
      if (item.state !== 'preparing') return; // pausada o cancelada mientras se preparaba
      item.state = 'up';
      renderItemState(item);
      for (;;) {
        const res = await sendFrom(item, item.received);
        if (res.done) break;
        item.received = res.offset;
      }
      item.state = 'done';
      item.note = '';
      item.retries = 0;
      item.received = item.size;
      addHistory({ name: item.file.name, size: item.size, kind: item.kind, at: Date.now(), pc: pc.name || '', thumb: await tinyThumb(item.thumbData) });
    } catch (e) {
      if (item.state === 'paused' || item.state === 'cancelled') return;
      if (e.fatal) { item.state = 'error'; return; }
      if (e.status === 423) { item.state = 'paused'; return; }
      if (e.status === 410) return markCancelled(item);
      if (e.status === 409) { item.state = 'queued'; return; } // el PC nos dice el offset bueno: se reintenta ya
      // Corte de red o el PC no responde: se reintenta solo, esperando cada vez un poco más.
      item.retries++;
      if (item.retries > MAX_RETRIES) { item.state = 'error'; return; }
      item.state = 'waiting';
      item.retryTimer = setTimeout(() => {
        if (item.state === 'waiting') { item.state = 'queued'; pump(); }
      }, Math.min(15000, 1000 * 2 ** Math.min(item.retries, 4)));
    } finally {
      active--;
      renderItemState(item);
      pump();
    }
  }

  function sendFrom(item, offset) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      xhr.open('PUT', `${item.pc.base}/api/v1/uploads/${item.session.id}?offset=${offset}`);
      xhr.setRequestHeader('X-Device-Token', item.pc.token);
      let last = 0;
      xhr.upload.onprogress = (e) => {
        bytesTick += e.loaded - last;
        last = e.loaded;
        item.received = offset + e.loaded;
        item.note = '';
        renderItemState(item);
      };
      xhr.onload = () => {
        item.xhr = null;
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* vacío */ }
        if (xhr.status === 200) resolve(body);
        else {
          if (typeof body.offset === 'number') item.received = body.offset;
          reject(Object.assign(new Error('http ' + xhr.status), { status: xhr.status }));
        }
      };
      xhr.onerror = () => { item.xhr = null; reject(new Error('network')); };
      xhr.onabort = () => { item.xhr = null; reject(new Error('aborted')); };
      xhr.send(item.file.slice(offset));
    });
  }

  function pauseItem(item) {
    clearTimeout(item.retryTimer);
    item.state = 'paused';
    item.xhr?.abort();
    if (item.session) postJson(item.pc, `/api/v1/uploads/${item.session.id}/state`, { state: 'paused' }).catch(() => {});
    renderItemState(item);
    renderLcd();
  }

  async function resumeItem(item) {
    item.retries = 0;
    if (item.session) await postJson(item.pc, `/api/v1/uploads/${item.session.id}/state`, { state: 'active' }).catch(() => {});
    item.state = 'queued';
    renderItemState(item);
    pump();
  }

  function cancelItem(item) {
    clearTimeout(item.retryTimer);
    item.state = 'cancelled';
    item.xhr?.abort();
    if (item.session) call(item.pc, `/api/v1/uploads/${item.session.id}`, { method: 'DELETE' }).catch(() => {});
    renderItemState(item);
    renderLcd();
  }

  function markCancelled(item) {
    item.state = 'cancelled';
    item.xhr?.abort();
  }

  /** Órdenes del PC: pausar, reanudar o cancelar una subida. */
  function onControl({ id, action }) {
    const item = queue.find((i) => i.session && i.session.id === id);
    if (!item) return;
    if (action === 'pause') {
      clearTimeout(item.retryTimer);
      item.state = 'paused';
      item.xhr?.abort();
    } else if (action === 'resume' && item.state === 'paused') {
      item.state = 'queued';
      pump();
    } else if (action === 'cancel') {
      clearTimeout(item.retryTimer);
      markCancelled(item);
    }
    renderItemState(item);
    renderLcd();
  }

  for (const id of ['pickMedia', 'pickFiles']) {
    $(id).addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
  }

  // Al volver a la app (pantalla desbloqueada), reintentar ya lo que estaba esperando.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const item of queue) {
      if (item.state === 'waiting') {
        clearTimeout(item.retryTimer);
        item.state = 'queued';
      }
    }
    pump();
    if (HOME.token) connectAll();
  });

  // ───────────── texto ─────────────
  $('btnText').onclick = () => {
    $('textMsg').textContent = '';
    $('textSheet').hidden = false;
    $('textInput').focus();
  };
  $('btnTextCancel').onclick = () => ($('textSheet').hidden = true);
  $('textSheet').onclick = (e) => e.target === $('textSheet') && ($('textSheet').hidden = true);
  $('btnTextSend').onclick = async () => {
    const text = $('textInput').value;
    if (!text.trim()) return;
    const pc = target();
    $('btnTextSend').disabled = true;
    const r = await postJson(pc, '/api/v1/text', { text }).catch(() => null);
    $('btnTextSend').disabled = false;
    if (r && r.ok) {
      $('textInput').value = '';
      $('textMsg').textContent = t('mSentOk');
      addHistory({ name: text.trim().split('\n')[0].slice(0, 120), size: 0, kind: 'text', at: Date.now(), pc: pc.name || '', thumb: null });
      setTimeout(() => ($('textSheet').hidden = true), 700);
    } else {
      $('textMsg').textContent = r && r.status === 401 ? t('mNotPairedTitle') : t('mOffline');
    }
  };

  /** Copiar sin HTTPS: navigator.clipboard solo funciona en conexiones seguras, así que hay plan B. */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => false);
    const ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return Promise.resolve(ok);
  }

  // ───────────── PC → móvil ─────────────
  function renderOutbox() {
    const pc = target();
    const outbox = outboxes[pcKey(pc)] || [];
    const ul = $('fromPc');
    ul.replaceChildren();
    const tok = encodeURIComponent(pc.token || '');
    for (const item of outbox) {
      const li = el('li');
      const thumb = el('span', 'thumb');
      const btns = el('span', 'btns');
      if (item.type === 'text') {
        thumb.textContent = ICONS.text;
        const copy = el('button', 'nt-btn', t('mCopy'));
        copy.onclick = async () => {
          copy.textContent = (await copyText(item.text)) ? t('copied') : t('mError');
          setTimeout(() => (copy.textContent = t('mCopy')), 1500);
        };
        btns.append(copy);
        if (isUrl(item.text)) {
          const a = el('a', 'nt-btn', t('mOpen'));
          a.href = item.text.trim();
          a.target = '_blank';
          a.rel = 'noopener';
          btns.append(a);
        }
        li.append(thumb, el('span', 'text-body', item.text), btns);
      } else {
        if (item.thumb) {
          const img = el('img');
          img.loading = 'lazy';
          img.src = `${pc.base}/api/v1/outbox/${item.id}/thumb?d=${tok}`;
          img.onerror = () => (thumb.textContent = ICONS[item.kind] || '■');
          thumb.append(img);
        } else {
          thumb.textContent = item.type === 'folder' ? ICONS.folder : ICONS[item.kind] || '■';
        }
        const a = el('a', 'nt-btn', item.type === 'folder' ? t('mDownload') + ' ZIP' : t('mDownload'));
        a.href = `${pc.base}/api/v1/outbox/${item.id}?d=${tok}`;
        // En la app de inicio de iOS la descarga dentro de la app no tiene «volver»: se abre en Safari.
        if (isIOS && standalone) a.target = '_blank';
        else a.download = item.type === 'folder' ? item.name + '.zip' : item.name;
        btns.append(a);
        const info = item.type === 'folder' ? `${t('folderItems', { n: item.count })} · ${formatSize(item.size)}` : formatSize(item.size);
        li.append(thumb, el('span', 'name', item.type === 'folder' ? item.name + '/' : item.name), btns, el('span', 'state', info));
      }
      ul.append(li);
    }
    $('countFromPc').textContent = outbox.length ? `(${outbox.length})` : '';
    $('emptyFromPc').hidden = outbox.length > 0;
  }

  // ───────────── conexión en vivo (una por PC emparejado) ─────────────
  const streams = {};
  function connect(pc) {
    const key = pcKey(pc);
    if (streams[key] && streams[key].readyState !== 2) return;
    streams[key]?.close();
    const es = new EventSource(`${pc.base}/api/v1/events?d=${encodeURIComponent(pc.token)}`);
    streams[key] = es;
    es.onopen = () => { online[key] = true; renderLcd(); renderTargets(); };
    es.onerror = () => { online[key] = false; renderLcd(); renderTargets(); };
    es.addEventListener('outbox', (e) => {
      outboxes[key] = JSON.parse(e.data).items;
      if (pcKey(target()) === key) renderOutbox();
    });
    es.addEventListener('control', (e) => onControl(JSON.parse(e.data)));
    es.addEventListener('unpaired', () => {
      es.close();
      if (pc === HOME) return unpaired();
      delete pcs[pc.id];
      savePcs();
      if (targetId === pc.id) setTarget(null);
      renderPcList();
    });
    if (pc === HOME) {
      es.addEventListener('settings', (e) => {
        const s = JSON.parse(e.data);
        if (s.skins) { skins = s.skins; loadCustomSkins(); }
        if (!LS.get('nt-skin')) skin = s.skin;
        applySkin();
        if (!LS.get('nt-lang')) { lang = s.lang; t = translator(lang); applyI18n(); }
      });
    }
  }
  function connectAll() {
    connect(HOME);
    for (const pc of Object.values(pcs)) connect(pc);
  }

  // ───────────── varios PCs ─────────────
  function setTarget(id) {
    targetId = id && pcs[id] ? id : null;
    if (targetId) LS.set('nt-target', targetId);
    else LS.del('nt-target');
    renderTargets();
    renderOutbox();
    renderLcd();
  }

  function renderTargets() {
    const list = [HOME, ...Object.values(pcs)];
    $('targetRow').hidden = list.length < 2;
    const sel = $('targetSel');
    sel.replaceChildren(...list.map((pc) => {
      const o = el('option', '', `${pc.name || '…'}${online[pcKey(pc)] === false ? ' (' + t('mOffline').toLowerCase() + ')' : ''}`);
      o.value = pc.id || '';
      return o;
    }));
    sel.value = targetId || '';
  }
  $('targetSel').onchange = (e) => setTarget(e.target.value || null);

  async function loadPeers() {
    const r = await call(HOME, '/api/v1/peers').catch(() => null);
    peers = r && r.ok ? (await r.json()).peers : [];
    // La IP de un PC puede cambiar: se actualiza con lo que se ve en la red
    for (const p of peers) {
      if (pcs[p.id]) {
        pcs[p.id].base = `http://${p.ip}:${p.port}`;
        pcs[p.id].name = p.name;
      }
    }
    savePcs();
    renderPcList();
    renderTargets();
  }

  function renderPcList() {
    const ul = $('pcList');
    const rows = [];
    const seen = new Set();
    for (const p of peers) {
      seen.add(p.id);
      rows.push({ id: p.id, name: p.name, paired: !!pcs[p.id], peer: p });
    }
    for (const pc of Object.values(pcs)) if (!seen.has(pc.id)) rows.push({ id: pc.id, name: pc.name, paired: true });
    if (!rows.length) {
      ul.replaceChildren(el('li', 'dim', t('mNoPeers')));
      return;
    }
    ul.replaceChildren(...rows.map((row) => {
      const li = el('li');
      li.append(el('span', 'grow', row.name));
      if (row.paired) {
        li.append(el('span', 'dim', t('mPaired')));
        const forget = el('button', 'nt-btn', t('mForgetPc'));
        forget.onclick = () => {
          streams[row.id]?.close();
          delete pcs[row.id];
          savePcs();
          if (targetId === row.id) setTarget(null);
          renderPcList();
          renderTargets();
        };
        li.append(forget);
      } else {
        const pair = el('button', 'nt-btn', t('mPairOther'));
        pair.onclick = () => pairOther(row.peer);
        li.append(pair);
      }
      return li;
    }));
  }

  /** Emparejar con otro PC de la red escribiendo su código (la petición va directamente a ese PC). */
  async function pairOther(peer) {
    const code = prompt(t('mOtherCode', { pc: peer.name }));
    if (!code) return;
    const base = `http://${peer.ip}:${peer.port}`;
    try {
      const r = await fetch(base + '/api/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name: guessName(), platform: isIOS ? 'ios' : isAndroid ? 'android' : 'web' }),
      });
      if (!r.ok) throw new Error('bad_code');
      const { token } = await r.json();
      pcs[peer.id] = { id: peer.id, name: peer.name, base, token };
      savePcs();
      connect(pcs[peer.id]);
      setTarget(peer.id);
      renderPcList();
    } catch {
      alert(t('mCodeError'));
    }
  }

  // ───────────── emparejar con este PC ─────────────
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
      HOME.token = (await r.json()).token;
      LS.set('nt-token', HOME.token);
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
      location.replace(`http://${info.host}:${info.port}/?d=${encodeURIComponent(HOME.token)}`);
      return true;
    } catch {
      return false;
    }
  }

  async function goHome() {
    const r = await call(HOME, '/api/v1/me').catch(() => null);
    if (r && r.status === 401) return unpaired();
    if (!r || !r.ok) {
      show('viewMain');
      online[pcKey(HOME)] = false;
      renderLcd();
      setTimeout(goHome, 4000);
      return;
    }
    me = await r.json();
    HOME.id = me.pcId;
    HOME.name = me.pcName;
    if (pcs[HOME.id]) { delete pcs[HOME.id]; savePcs(); } // por si se emparejó también como «otro PC»
    if (await tryLocalHost(me)) return;
    LS.set('nt-token', HOME.token);
    // El token tiene que estar en la URL *al cargar* la página: así el servidor escribe el manifest con él
    // y el icono de la pantalla de inicio (que no comparte almacenamiento con Safari) arranca emparejado.
    if (q.get('d') !== HOME.token) {
      location.replace('/?d=' + encodeURIComponent(HOME.token));
      return;
    }
    if (me.skins) { skins = me.skins; loadCustomSkins(); }
    if (!LS.get('nt-skin') && !q.get('skin')) skin = me.skin;
    applySkin();
    if (!LS.get('nt-lang')) { lang = me.lang; t = translator(lang); applyI18n(); }
    $('pcInfo').textContent = `${me.pcName} · ${me.host}:${me.port} · v${me.version}`;
    $('installHint').hidden = standalone || !(isIOS || isAndroid) || LS.get('nt-hint-hidden') === '1';
    show('viewMain');
    if (targetId && !pcs[targetId]) setTarget(null);
    renderTargets();
    renderOutbox();
    renderHistory();
    connectAll();
    renderLcd();
    loadPeers();
  }

  // ───────────── menú ─────────────
  $('btnMenu').onclick = () => {
    $('sheet').hidden = false;
    loadPeers();
  };
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
    if (HOME.token) {
      const r = await call(HOME, '/api/v1/me').catch(() => null);
      if (r && r.ok) return goHome();
      if (r && r.status === 401) {
        LS.del('nt-token');
        HOME.token = null;
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
