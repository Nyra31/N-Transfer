/* Interfaz del PC de N-Transfer. */
'use strict';
const { translator, formatSize, timeAgo } = window.NT_I18N;
const $ = (id) => document.getElementById(id);
const S = {
  settings: {}, pair: {}, devices: [], outbox: [], history: [],
  active: new Map(), tab: 'transfers', sel: null, serverError: null, updateReady: false, version: '',
};
let t = translator('es');
let speed = 0;
let bytesTick = 0;
const viz = window.NT_VIZ.createViz($('viz'));

// ───────────── utilidades ─────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function applyI18n() {
  document.documentElement.lang = S.settings.lang;
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
}
function applySkin() {
  document.body.className = document.body.className.replace(/skin-\w+/g, '').trim() + ' skin-' + S.settings.skin;
  for (const b of document.querySelectorAll('.skin-opt')) b.classList.toggle('active', b.dataset.skin === S.settings.skin);
  requestAnimationFrame(() => viz.readColors());
}
let toastTimer;
function toast(msg) {
  const e = $('toast');
  e.textContent = msg;
  e.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (e.hidden = true), 3200);
}

// ───────────── LCD ─────────────
const marquee = { text: '', pos: 0 };
function marqueeText() {
  if (S.serverError) return S.serverError;
  if (S.updateReady) return t('updateReady');
  const act = [...S.active.values()];
  if (act.length) {
    return act.map((a) => {
      const pct = a.size ? Math.floor((a.received / a.size) * 100) : 0;
      return `${a.direction === 'in' ? '▼' : '▲'} ${a.name} (${pct}%) - ${a.device}`;
    }).join('  ***  ');
  }
  return `N-TRANSFER v${S.version}  ***  ` + (S.devices.length ? t('idleMarqueePaired') : t('idleMarquee'));
}
function tickMarquee() {
  const box = $('marquee');
  const text = marqueeText();
  const chars = Math.max(10, Math.floor(box.clientWidth / 8.6));
  if (text !== marquee.text) {
    marquee.text = text;
    if (text.length <= chars) marquee.pos = 0;
  }
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
  const act = [...S.active.values()];
  const inCount = act.filter((a) => a.direction === 'in').length;
  let status = t('ready');
  if (S.serverError) status = 'ERROR';
  else if (inCount) status = t('receiving');
  else if (act.length) status = t('sending');
  $('lcdStatus').textContent = status;
  $('led').classList.toggle('on', act.length > 0);
  $('lcdSpeed').textContent = (speed / 1048576).toFixed(1).padStart(5, ' ');
  $('lcdStats').textContent = t('stats', {
    in: S.history.filter((h) => h.direction === 'in').length,
    out: S.history.filter((h) => h.direction === 'out').length,
    dev: S.devices.length,
  });
  const total = act.reduce((s, a) => s + (a.size || 0), 0);
  const got = act.reduce((s, a) => s + a.received, 0);
  $('seek').style.width = total ? ((got / total) * 100).toFixed(1) + '%' : '0%';
  viz.setLevel(act.length ? 0.25 + Math.min(0.75, Math.sqrt(speed / (40 * 1048576))) : 0.03);
}

setInterval(() => {
  const inst = bytesTick / 0.5;
  bytesTick = 0;
  speed = S.active.size ? speed * 0.5 + inst * 0.5 : 0;
  renderLcd();
}, 500);

// ───────────── lista ─────────────
function renderList() {
  const list = $('list');
  list.replaceChildren();
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === S.tab);
  $('badgeOutbox').textContent = S.outbox.length ? `(${S.outbox.length})` : '';
  $('badgeDevices').textContent = S.devices.length ? `(${S.devices.length})` : '';
  const actions = $('actions');
  actions.replaceChildren();
  const action = (key, fn) => {
    const b = el('button', 'nt-btn', t(key));
    b.onclick = fn;
    actions.append(b);
  };
  let rows = [];

  if (S.tab === 'transfers') {
    rows = [...[...S.active.values()].map((a) => ({ ...a, isActive: true })), ...S.history];
    rows.forEach((r, i) => {
      const li = el('li', r.isActive ? 'active' : '');
      li.append(el('span', 'num', String(i + 1).padStart(2, '0') + '.'), el('span', 'dir', r.direction === 'in' ? '▼' : '▲'),
        el('span', 'name', r.name));
      if (r.isActive) {
        const pct = r.size ? Math.floor((r.received / r.size) * 100) : 0;
        li.append(el('span', 'meta', pct + '%'));
        const bar = el('div', 'nt-progress');
        const fill = el('i');
        fill.style.width = pct + '%';
        bar.append(fill);
        li.append(el('span'), el('span'), bar);
      } else {
        li.append(el('span', 'meta dim', formatSize(r.size)));
        li.append(el('span'), el('span'), el('span', 'sub dim', `${r.device} · ${timeAgo(t, r.at)}`));
        li.ondblclick = () => r.path && window.nt.invoke('item-menu', r.path);
        li.oncontextmenu = (e) => { e.preventDefault(); r.path && window.nt.invoke('item-menu', r.path); };
      }
      li.onclick = () => select(li);
      list.append(li);
    });
    const size = S.history.reduce((s, h) => s + h.size, 0);
    $('summary').textContent = t('itemsTotal', { n: S.history.length, size: formatSize(size) });
    if (S.history.length) action('clear', () => window.nt.invoke('history-clear'));
  }

  if (S.tab === 'outbox') {
    rows = S.outbox;
    rows.forEach((r, i) => {
      const li = el('li');
      const rm = el('button', 'nt-btn row-btn', '×');
      rm.title = t('remove');
      rm.onclick = () => window.nt.invoke('outbox-remove', r.id);
      const meta = el('span', 'meta');
      meta.append(el('span', 'dim', formatSize(r.size) + '  '), rm);
      li.append(el('span', 'num', String(i + 1).padStart(2, '0') + '.'), el('span', 'dir', '▲'), el('span', 'name', r.name), meta);
      li.onclick = () => select(li);
      list.append(li);
    });
    const size = S.outbox.reduce((s, h) => s + h.size, 0);
    $('summary').textContent = t('itemsTotal', { n: S.outbox.length, size: formatSize(size) });
    action('add', () => window.nt.invoke('outbox-pick'));
    if (S.outbox.length) action('clearAll', () => window.nt.invoke('outbox-clear'));
  }

  if (S.tab === 'devices') {
    rows = S.devices;
    rows.forEach((d, i) => {
      const li = el('li');
      const forget = el('button', 'nt-btn row-btn', t('forget'));
      forget.onclick = () => window.nt.invoke('device-forget', d.id);
      li.append(el('span', 'num', String(i + 1).padStart(2, '0') + '.'), el('span', 'dir', '◘'), el('span', 'name', d.name),
        forget, el('span'), el('span'),
        el('span', 'sub dim', `${t('lastSeen', { when: timeAgo(t, d.lastSeen) })} · ${t('pairedOn', { when: timeAgo(t, d.pairedAt) })}`));
      li.onclick = () => select(li);
      list.append(li);
    });
    $('summary').textContent = '';
    action('pair', openPair);
  }

  const empty = { transfers: 'emptyTransfers', outbox: 'emptyOutbox', devices: 'emptyDevices' }[S.tab];
  $('empty').textContent = rows.length ? '' : t(empty);
}
function select(li) {
  for (const x of $('list').children) x.classList.toggle('sel', x === li);
}

// Actualiza solo las filas activas (sin rehacer la lista) para que el progreso sea fluido.
let listDirty = false;
function scheduleList() {
  if (listDirty) return;
  listDirty = true;
  requestAnimationFrame(() => {
    listDirty = false;
    renderList();
  });
}

// ───────────── diálogos ─────────────
function openPair() {
  $('qr').src = S.pair.qr;
  $('pairUrl').textContent = S.pair.url;
  $('pairDlg').hidden = false;
}
function openSettings(section) {
  $('setDest').value = S.settings.destDir;
  $('setLang').value = S.settings.lang;
  $('setAutostart').checked = S.settings.autostart;
  $('setTray').checked = S.settings.closeToTray;
  $('netInfo').textContent = `${S.pair.ip}:${S.pair.port}\n${S.pair.host}`;
  $('netInfo').style.whiteSpace = 'pre-line';
  $('version').textContent = 'v' + S.version;
  $('settingsDlg').hidden = false;
  if (section === 'about') $('aboutBox').scrollIntoView();
}
for (const dlg of document.querySelectorAll('.overlay')) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.hidden = true;
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const d of document.querySelectorAll('.overlay')) d.hidden = true;
});

// ───────────── botones ─────────────
$('titlebar').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'menu') window.nt.invoke('main-menu');
  else if (act === 'shade') toggleShade();
  else window.nt.invoke('win', act);
});
$('titlebar').addEventListener('dblclick', (e) => !e.target.closest('button') && toggleShade());
function toggleShade() {
  const on = !document.body.classList.contains('shaded');
  document.body.classList.toggle('shaded', on);
  if (on) {
    const h = $('titlebar').offsetHeight + $('deck').offsetHeight + 2;
    window.nt.invoke('win', 'shade', h);
  } else {
    window.nt.invoke('win', 'unshade');
  }
}
$('btnPair').onclick = openPair;
$('btnSend').onclick = () => {
  S.tab = 'outbox';
  renderList();
  window.nt.invoke('outbox-pick');
};
$('btnFolder').onclick = () => window.nt.invoke('open-folder');
$('btnSettings').onclick = () => openSettings();
$('btnNewCode').onclick = () => window.nt.invoke('pair-new');
$('btnDest').onclick = () => window.nt.invoke('pick-folder');
$('setLang').onchange = (e) => window.nt.invoke('set', 'lang', e.target.value);
$('setAutostart').onchange = (e) => window.nt.invoke('set', 'autostart', e.target.checked);
$('setTray').onchange = (e) => window.nt.invoke('set', 'closeToTray', e.target.checked);
$('skinPicker').onclick = (e) => {
  const s = e.target.closest('[data-skin]')?.dataset.skin;
  if (s) window.nt.invoke('set', 'skin', s);
};
$('repoLink').onclick = (e) => {
  e.preventDefault();
  window.nt.invoke('open-external', 'https://github.com/Nyra31/N-Transfer');
};
for (const b of document.querySelectorAll('.tab')) {
  b.onclick = () => {
    S.tab = b.dataset.tab;
    renderList();
  };
}

// ───────────── arrastrar y soltar (PC → móvil) ─────────────
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const paths = [...e.dataTransfer.files].map((f) => window.nt.pathForFile(f)).filter(Boolean);
  if (paths.length) {
    window.nt.invoke('outbox-add', paths);
    S.tab = 'outbox';
    renderList();
  }
});

// ───────────── eventos del proceso principal ─────────────
window.nt.on((name, p) => {
  switch (name) {
    case 'transfer-start':
      S.active.set(p.id, p);
      break;
    case 'transfer-progress': {
      const a = S.active.get(p.id);
      if (a) {
        bytesTick += p.received - a.received;
        a.received = p.received;
      }
      break;
    }
    case 'transfer-done': {
      const a = S.active.get(p.id);
      if (a) bytesTick += p.size - a.received;
      S.active.delete(p.id);
      S.history.unshift(p);
      S.history = S.history.slice(0, 200);
      break;
    }
    case 'transfer-error':
      S.active.delete(p.id);
      break;
    case 'devices':
      S.devices = p;
      break;
    case 'outbox':
      S.outbox = p;
      break;
    case 'history':
      S.history = p;
      break;
    case 'pair':
      S.pair = p;
      if (!$('pairDlg').hidden) openPair();
      break;
    case 'paired':
      $('pairDlg').hidden = true;
      toast(t('pairDone', { name: p.name }));
      S.tab = 'devices';
      break;
    case 'settings': {
      const langChanged = p.lang !== S.settings.lang;
      S.settings = p;
      t = translator(p.lang);
      applySkin();
      if (langChanged) applyI18n();
      if (!$('settingsDlg').hidden) openSettings();
      break;
    }
    case 'open-pair':
      openPair();
      break;
    case 'open-settings':
      openSettings(p);
      break;
    case 'update-ready':
      S.updateReady = true;
      break;
  }
  scheduleList();
  renderLcd();
});

// ───────────── arranque ─────────────
(async () => {
  Object.assign(S, await window.nt.invoke('state'));
  t = translator(S.settings.lang);
  applySkin();
  applyI18n();
  renderList();
  renderLcd();
  tickMarquee();
  // Refresca los «hace X min»
  setInterval(() => !S.active.size && renderList(), 60000);
})();
