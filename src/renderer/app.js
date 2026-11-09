/* Interfaz del PC de N-Transfer. */
'use strict';
const { translator, formatSize, timeAgo } = window.NT_I18N;
const sound = window.NT_SOUND;
const $ = (id) => document.getElementById(id);
const S = {
  settings: {}, pair: {}, devices: [], outbox: [], history: [], stats: {}, customSkins: [],
  active: new Map(), tab: 'transfers', serverError: null, updateReady: false, version: '', thumbBase: '',
  filter: { q: '', type: 'all', device: '' }, sel: new Set(),
};
let t = translator('es');
let speed = 0;
let bytesTick = 0;
let statsMode = 0;
const viz = window.NT_VIZ.createViz($('viz'));
const ICONS = { photo: '▣', video: '▶', other: '■', text: '✉' };

// ───────────── utilidades ─────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function btn(label, title, onclick, cls = 'nt-btn row-btn') {
  const b = el('button', cls, label);
  if (title) b.title = title;
  b.onclick = (e) => {
    e.stopPropagation();
    onclick();
  };
  return b;
}
const thumbUrl = (name) => (name ? S.thumbBase + encodeURIComponent(name) : null);
const isUrl = (s) => /^https?:\/\/\S+$/.test(String(s).trim());
const fmtSpeed = (b) => (b / 1048576).toFixed(1) + ' MB/s';

function applyI18n() {
  document.documentElement.lang = S.settings.lang;
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  for (const e of document.querySelectorAll('[data-i18n-placeholder]')) e.placeholder = t(e.dataset.i18nPlaceholder);
}
function applySkin() {
  $('customSkins').textContent = S.customSkins.map((s) => s.css).join('\n');
  document.body.className = document.body.className.replace(/\bskin-[\w-]+/g, '').trim() + ' skin-' + S.settings.skin;
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
function stateLabel(a) {
  if (a.state === 'paused') return t('statePaused');
  if (a.state === 'stalled') return t('stateStalled');
  if (a.state === 'converting') return t('stateConverting');
  return (a.size ? Math.floor((a.received / a.size) * 100) : 0) + '%';
}
function marqueeText() {
  if (S.serverError) return S.serverError;
  if (S.updateReady) return t('updateReady');
  const act = [...S.active.values()];
  if (act.length) {
    return act.map((a) => `${a.direction === 'in' ? '▼' : '▲'} ${a.name} (${stateLabel(a)}) - ${a.device}`).join('  ***  ');
  }
  return `N-TRANSFER v${S.version}  ***  ` + (S.devices.length ? t('idleMarqueePaired') : t('idleMarquee'));
}
function tickMarquee() {
  const box = $('marquee');
  const text = marqueeText();
  const chars = Math.max(8, Math.floor(box.clientWidth / 8.1));
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

/** La transferencia que se muestra en la vista previa: la activa más reciente con miniatura. */
function previewTransfer() {
  const act = [...S.active.values()];
  return act.filter((a) => a.state === 'active').pop() || act[act.length - 1] || null;
}

function lcdStatsText() {
  const s = S.stats || {};
  switch (statsMode) {
    case 1: return t('lcdTotal', { size: formatSize((s.bytesIn || 0) + (s.bytesOut || 0)) });
    case 2: return t('lcdMax', { speed: fmtSpeed(s.maxSpeed || 0) });
    case 3: return t('lcdCounts', { p: s.photos || 0, v: s.videos || 0, o: s.others || 0 });
    default: return t('stats', { in: s.filesIn || 0, out: s.filesOut || 0, dev: S.devices.length });
  }
}

let lastThumb = null;
function renderLcd() {
  const act = [...S.active.values()];
  const running = act.filter((a) => a.state === 'active' || a.state === 'converting');
  let status = t('ready');
  if (S.serverError) status = 'ERROR';
  else if (running.some((a) => a.state === 'converting')) status = t('converting');
  else if (running.some((a) => a.direction === 'in')) status = t('receiving');
  else if (running.length) status = t('sending');
  else if (act.some((a) => a.state === 'paused')) status = t('paused');
  else if (act.length) status = t('waiting');
  $('lcdStatus').textContent = status;
  $('led').classList.toggle('on', running.length > 0);
  $('lcdSpeed').textContent = (speed / 1048576).toFixed(1).padStart(5, ' ');
  $('lcdStats').textContent = lcdStatsText();
  const total = act.reduce((s, a) => s + (a.size || 0), 0);
  const got = act.reduce((s, a) => s + a.received, 0);
  $('seek').style.width = total ? ((got / total) * 100).toFixed(1) + '%' : '0%';
  viz.setLevel(running.length ? 0.25 + Math.min(0.75, Math.sqrt(speed / (40 * 1048576))) : 0.03);

  // Vista previa en directo
  const p = previewTransfer();
  const src = p && p.thumb ? thumbUrl(p.thumb) : null;
  const box = $('lcdThumb');
  if (src !== lastThumb) {
    lastThumb = src;
    if (src) $('lcdImg').src = src;
    else $('lcdImg').removeAttribute('src');
  }
  box.classList.toggle('has-img', !!src);
  box.classList.toggle('busy', !!p && !src);
  $('lcdGlyph').textContent = p ? ICONS[p.kind] || 'N' : 'N';
}

setInterval(() => {
  const inst = bytesTick / 0.5;
  bytesTick = 0;
  const running = [...S.active.values()].some((a) => a.state === 'active');
  speed = running ? speed * 0.5 + inst * 0.5 : 0;
  renderLcd();
}, 500);

$('lcdStats').onclick = () => {
  statsMode = (statsMode + 1) % 4;
  sound.play('click');
  renderLcd();
};

// ───────────── lista ─────────────
function thumbCell(item) {
  const box = el('span', 'thumb');
  const src = thumbUrl(item.thumb);
  if (src) {
    const img = el('img');
    img.loading = 'lazy';
    img.src = src;
    img.onerror = () => img.replaceWith(document.createTextNode(ICONS[item.kind] || '■'));
    box.append(img);
  } else {
    box.textContent = ICONS[item.kind] || (item.type === 'text' ? '✉' : '■');
  }
  return box;
}

function renderList() {
  const list = $('list');
  const scroll = list.scrollTop;
  list.replaceChildren();
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === S.tab);
  $('badgeActive').textContent = S.active.size ? `(${S.active.size})` : '';
  $('badgeOutbox').textContent = S.outbox.length ? `(${S.outbox.length})` : '';
  $('badgeDevices').textContent = S.devices.length ? `(${S.devices.length})` : '';
  const actions = $('actions');
  actions.replaceChildren();
  const action = (key, fn) => actions.append(btn(t(key), null, fn, 'nt-btn'));
  let count = 0;
  const num = (i) => el('span', 'num', String(i + 1).padStart(2, '0') + '.');

  if (S.tab === 'transfers') {
    renderFilters();
    const known = new Set(S.history.map((h) => h.id));
    for (const id of S.sel) if (!known.has(id)) S.sel.delete(id);
    const active = [...S.active.values()].reverse();
    active.forEach((a, i) => {
      const li = el('li', 'active ' + (a.state || ''));
      li.dataset.id = a.id;
      const meta = el('span', 'meta');
      meta.append(el('span', 'pct', stateLabel(a)));
      if (a.direction === 'in' && a.state !== 'converting') {
        if (a.state === 'paused') meta.append(btn('▶', t('resume'), () => window.nt.invoke('transfer', 'resume', a.id)));
        else meta.append(btn('❚❚', t('pause'), () => window.nt.invoke('transfer', 'pause', a.id)));
      }
      if (a.state !== 'converting') meta.append(btn('×', t('cancel'), () => window.nt.invoke('transfer', 'cancel', a.id)));
      const bar = el('div', 'nt-progress');
      const fill = el('i');
      fill.style.width = (a.size ? (a.received / a.size) * 100 : 0) + '%';
      bar.append(fill);
      li.append(num(i), thumbCell(a), el('span', 'name', (a.direction === 'in' ? '▼ ' : '▲ ') + a.name), meta, bar);
      list.append(li);
    });
    const shown = filteredHistory();
    visibleIds = shown.map((h) => h.id);
    shown.forEach((h, i) => {
      const li = el('li', S.sel.has(h.id) ? 'sel' : '');
      li.dataset.id = h.id;
      const meta = el('span', 'meta');
      if (h.kind === 'text') {
        meta.append(btn(t('copy'), null, () => {
          window.nt.invoke('clipboard-write', h.text);
          toast(t('copied'));
        }));
        if (isUrl(h.text)) meta.append(btn('↗', t('openLink'), () => window.nt.invoke('open-external', h.text.trim())));
      } else {
        meta.append(el('span', 'dim', formatSize(h.size)));
      }
      const extra = h.extra ? ` · +${h.extra.name}` : '';
      li.append(num(active.length + i), thumbCell(h), el('span', 'name', (h.direction === 'in' ? '▼ ' : '▲ ') + h.name), meta,
        el('span', 'sub dim', `${h.device} · ${timeAgo(t, h.at)}${extra}`));
      li.ondblclick = () => (h.kind === 'text' ? window.nt.invoke('clipboard-write', h.text).then(() => toast(t('copied'))) : window.nt.invoke('open-entry', h.id));
      li.oncontextmenu = (e) => {
        e.preventDefault();
        if (!S.sel.has(h.id)) selectOnly(h.id);
        if (S.sel.size > 1) return; // con varias seleccionadas se usan los botones de abajo
        window.nt.invoke('item-menu', h.id);
      };
      li.onclick = (e) => clickSelect(h.id, e);
      // Arrastrar a otra carpeta o aplicación (con varias seleccionadas, se arrastran todas)
      if (h.kind !== 'text' && h.path) {
        li.draggable = true;
        li.ondragstart = (e) => {
          e.preventDefault();
          if (!S.sel.has(h.id)) selectOnly(h.id);
          outDrag = true;
          window.nt.startDrag([...S.sel]);
        };
      }
      list.append(li);
    });
    count = active.length + shown.length;
    if (S.sel.size) {
      $('summary').textContent = t('selected', { n: S.sel.size });
      const ids = () => [...S.sel];
      action('openSel', () => window.nt.invoke('entries', 'open', ids()));
      action('showSel', () => window.nt.invoke('entries', 'show', ids()));
      action('removeSel', () => removeSelected());
      action('trashSel', () => window.nt.invoke('entries', 'trash', ids()));
    } else {
      const size = shown.reduce((s, h) => s + (h.kind === 'text' ? 0 : h.size), 0);
      $('summary').textContent = t('itemsTotal', { n: shown.length, size: formatSize(size) });
      if (S.history.length && !filtering()) action('clear', () => window.nt.invoke('history-clear'));
    }
    if (!count && filtering()) {
      $('empty').textContent = t('noResults');
      return finishList(list, scroll);
    }
  }

  if (S.tab === 'outbox') {
    S.outbox.forEach((r, i) => {
      const li = el('li');
      const meta = el('span', 'meta');
      if (r.type !== 'text') meta.append(el('span', 'dim', formatSize(r.size)));
      meta.append(btn('×', t('remove'), () => window.nt.invoke('outbox-remove', r.id)));
      const name = r.type === 'text' ? r.text.trim().split('\n')[0] : r.type === 'folder' ? r.name + '/' : r.name;
      const sub = r.type === 'folder' ? `${t('folderItems', { n: r.count })} · ZIP · ${timeAgo(t, r.addedAt)}` : timeAgo(t, r.addedAt);
      const thumb = thumbCell(r.type === 'text' ? { kind: 'text' } : r);
      if (r.type === 'folder') thumb.textContent = '▤';
      li.append(num(i), thumb, el('span', 'name', name), meta, el('span', 'sub dim', sub));
      li.onclick = () => select(li);
      list.append(li);
    });
    count = S.outbox.length;
    const size = S.outbox.reduce((s, h) => s + (h.size || 0), 0);
    $('summary').textContent = t('itemsTotal', { n: S.outbox.length, size: formatSize(size) });
    action('add', () => window.nt.invoke('outbox-pick'));
    action('addFolder', () => window.nt.invoke('outbox-pick-folder'));
    action('text', openText);
    if (S.outbox.length) action('clearAll', () => window.nt.invoke('outbox-clear'));
  }

  if (S.tab === 'devices') {
    S.devices.forEach((d, i) => {
      const li = el('li');
      const meta = el('span', 'meta');
      meta.append(btn(t('forget'), null, () => window.nt.invoke('device-forget', d.id)));
      li.append(num(i), thumbCell({ kind: 'device' }), el('span', 'name', d.name), meta,
        el('span', 'sub dim', `${t('lastSeen', { when: timeAgo(t, d.lastSeen) })} · ${t('pairedOn', { when: timeAgo(t, d.pairedAt) })}`));
      li.querySelector('.thumb').textContent = '◘';
      li.onclick = () => select(li);
      list.append(li);
    });
    count = S.devices.length;
    $('summary').textContent = '';
    action('pair', openPair);
  }

  const empty = { transfers: 'emptyTransfers', outbox: 'emptyOutbox', devices: 'emptyDevices' }[S.tab];
  $('empty').textContent = count ? '' : t(empty);
  finishList(list, scroll);
}
function finishList(list, scroll) {
  list.scrollTop = scroll;
  $('filters').hidden = S.tab !== 'transfers';
}
function select(li) {
  for (const x of $('list').children) x.classList.toggle('sel', x === li);
}

// ───────────── búsqueda, filtros y selección múltiple (historial) ─────────────
let visibleIds = [];
let anchorId = null;
let outDrag = false; // arrastrando desde la lista hacia fuera: no confundirlo con «soltar para enviar»
const filtering = () => !!(S.filter.q || S.filter.type !== 'all' || S.filter.device);

function filteredHistory() {
  const q = S.filter.q.trim().toLowerCase();
  return S.history.filter((h) => {
    if (S.filter.type !== 'all' && (h.kind || 'other') !== S.filter.type) return false;
    if (S.filter.device && h.device !== S.filter.device) return false;
    if (q && !`${h.name} ${h.text || ''} ${h.device}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderFilters() {
  for (const b of $('ftypes').children) b.classList.toggle('active', b.dataset.f === S.filter.type);
  const devices = [...new Set(S.history.map((h) => h.device).filter(Boolean))];
  const sel = $('fDevice');
  sel.hidden = devices.length < 2;
  const opts = [['', t('allDevices')], ...devices.map((d) => [d, d])];
  if (sel.dataset.sig !== JSON.stringify(opts)) {
    sel.dataset.sig = JSON.stringify(opts);
    sel.replaceChildren(...opts.map(([v, l]) => Object.assign(el('option', '', l), { value: v })));
  }
  sel.value = S.filter.device;
}

function selectOnly(id) {
  S.sel = new Set([id]);
  anchorId = id;
  scheduleList();
}
function clickSelect(id, e) {
  if (e.shiftKey && anchorId && visibleIds.includes(anchorId)) {
    const [a, b] = [visibleIds.indexOf(anchorId), visibleIds.indexOf(id)].sort((x, y) => x - y);
    S.sel = new Set(visibleIds.slice(a, b + 1));
  } else if (e.ctrlKey || e.metaKey) {
    if (S.sel.has(id)) S.sel.delete(id);
    else S.sel.add(id);
    anchorId = id;
  } else {
    S.sel = new Set([id]);
    anchorId = id;
  }
  scheduleList();
}
function removeSelected() {
  if (!S.sel.size) return;
  window.nt.invoke('entries', 'remove', [...S.sel]);
  S.sel.clear();
}

$('search').addEventListener('input', (e) => {
  S.filter.q = e.target.value;
  S.sel.clear();
  renderList();
});
$('ftypes').onclick = (e) => {
  const f = e.target.closest('[data-f]')?.dataset.f;
  if (!f) return;
  S.filter.type = f;
  S.sel.clear();
  renderFilters();
  renderList();
};
$('fDevice').onchange = (e) => {
  S.filter.device = e.target.value;
  S.sel.clear();
  renderList();
};
$('list').addEventListener('keydown', (e) => {
  if (S.tab !== 'transfers') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    S.sel = new Set(visibleIds);
    renderList();
  } else if (e.key === 'Delete' && S.sel.size) {
    e.preventDefault();
    if (e.shiftKey) window.nt.invoke('entries', 'trash', [...S.sel]);
    else removeSelected();
  } else if (e.key === 'Enter' && S.sel.size) {
    window.nt.invoke('entries', 'open', [...S.sel]);
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.tab === 'transfers') {
    e.preventDefault();
    $('search').focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    window.nt.invoke('set', 'scale', S.settings.scale === 2 ? 1 : 2);
  }
});
// Al soltar fuera de la ventana el primer movimiento del ratón llega sin botones pulsados
window.addEventListener('mousemove', (e) => {
  if (outDrag && e.buttons === 0) outDrag = false;
});

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
  $('pairCode').textContent = S.pair.code;
  $('pairDlg').hidden = false;
}

async function openText(prefill) {
  const input = $('textInput');
  input.value = typeof prefill === 'string' ? prefill : '';
  $('textDlg').hidden = false;
  input.focus();
}
$('btnPaste').onclick = async () => {
  $('textInput').value = await window.nt.invoke('clipboard-read');
  $('textInput').focus();
};
$('btnSendText').onclick = async () => {
  const text = $('textInput').value;
  if (!text.trim()) return;
  await window.nt.invoke('outbox-text', text);
  $('textDlg').hidden = true;
  toast(t('textQueued'));
  S.tab = 'outbox';
  renderList();
};
$('textInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('btnSendText').click();
});

let prefsPage = 'general';
function showPrefsPage(page) {
  prefsPage = page;
  for (const b of $('prefsNav').children) b.classList.toggle('active', b.dataset.page === page);
  for (const s of document.querySelectorAll('.prefs-page section')) s.hidden = s.dataset.page !== page;
}
$('prefsNav').onclick = (e) => {
  const p = e.target.closest('[data-page]')?.dataset.page;
  if (p) showPrefsPage(p);
};

function fillSettings() {
  const s = S.settings;
  $('setDest').value = s.destDir;
  $('setLang').value = s.lang;
  $('setAutostart').checked = s.autostart;
  $('setTray').checked = s.closeToTray;
  $('setTop').checked = s.alwaysOnTop;
  $('setSounds').checked = s.sounds;
  $('setCopy').checked = s.autoCopyText;
  $('setSplit').checked = s.splitByType;
  $('typeDirs').classList.toggle('disabled', !s.splitByType);
  $('setPhotoDir').value = s.photoDir;
  $('setVideoDir').value = s.videoDir;
  $('setOtherDir').value = s.otherDir;
  for (const r of document.querySelectorAll('input[name=heic]')) r.checked = r.value === s.heicMode;
  // En rutas largas lo importante es el final (la carpeta), no «C:\Users\…»
  requestAnimationFrame(() => {
    for (const id of ['setDest', 'setPhotoDir', 'setVideoDir', 'setOtherDir']) {
      $(id).scrollLeft = $(id).scrollWidth;
      $(id).title = $(id).value;
    }
  });
  $('netInfo').textContent = `${S.pair.ip}:${S.pair.port} · ${S.pair.host}`;
  $('version').textContent = 'v' + S.version;
  $('setScale').value = String(s.scale || 1);
  if (document.activeElement !== $('setPcName')) {
    $('setPcName').value = s.pcName || '';
    $('setPcName').placeholder = s.pcLabel || '';
  }
  const ipOpts = [['', `${t('ipAuto')} (${s.ips?.[0] || '—'})`], ...(s.ips || []).map((ip) => [ip, ip])];
  $('setIp').replaceChildren(...ipOpts.map(([v, l]) => Object.assign(el('option', '', l), { value: v })));
  $('setIp').value = s.preferredIp || '';
  $('customActions').hidden = !S.customSkins.some((c) => c.id === s.skin);

  const picker = $('customPicker');
  picker.replaceChildren();
  for (const c of S.customSkins) {
    const b = el('button', 'nt-btn skin-opt' + (c.id === s.skin ? ' active' : ''));
    b.dataset.skin = c.id;
    const sw = el('i', 'sw sw-custom');
    sw.classList.add('skin-' + c.id);
    b.append(sw, el('span', '', c.name));
    picker.append(b);
  }
  $('noCustom').hidden = S.customSkins.length > 0;
  renderStats();
}

function renderStats() {
  const s = S.stats || {};
  $('statsSince').textContent = t('statSince', { date: new Date(s.since || Date.now()).toLocaleDateString(S.settings.lang) });
  const rows = [
    [t('statReceived'), `${formatSize(s.bytesIn || 0)} · ${t('statFiles', { n: s.filesIn || 0 })}`],
    [t('statSent'), `${formatSize(s.bytesOut || 0)} · ${t('statFiles', { n: s.filesOut || 0 })}`],
    [t('photos'), s.photos || 0],
    [t('videos'), s.videos || 0],
    [t('others'), s.others || 0],
    [t('statTexts'), s.texts || 0],
    [t('statMax'), fmtSpeed(s.maxSpeed || 0)],
  ];
  $('statsTable').replaceChildren(...rows.map(([k, v]) => {
    const tr = el('tr');
    tr.append(el('td', '', k), el('td', '', String(v)));
    return tr;
  }));
}

function openSettings(page) {
  fillSettings();
  showPrefsPage(page || prefsPage);
  $('settingsDlg').hidden = false;
}

for (const dlg of document.querySelectorAll('.overlay')) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.hidden = true;
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (editor) return closeEditor(); // quita también la vista previa
  for (const d of document.querySelectorAll('.overlay')) d.hidden = true;
});

// Pegar (Ctrl+V) con la ventana activa: abre «Enviar texto» con el portapapeles.
document.addEventListener('paste', (e) => {
  if (e.target.closest('input, textarea')) return;
  const text = e.clipboardData.getData('text');
  if (text) openText(text);
});

// ───────────── botones ─────────────
$('titlebar').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'menu') window.nt.invoke('main-menu');
  else if (act === 'shade') setMode(mode === 'shade' ? 'normal' : 'shade');
  else if (act === 'mini') setMode(mode === 'mini' ? 'normal' : 'mini');
  else window.nt.invoke('win', act);
});
$('titlebar').addEventListener('dblclick', (e) => !e.target.closest('button') && setMode(mode === 'normal' ? 'shade' : 'normal'));
$('deck').addEventListener('dblclick', (e) => mode === 'mini' && !e.target.closest('button') && setMode('normal'));

let mode = 'normal';
function setMode(next) {
  mode = next;
  document.body.classList.toggle('shaded', next === 'shade');
  document.body.classList.toggle('mini', next === 'mini');
  $('btnMini').textContent = next === 'mini' ? '▣' : '▫';
  $('btnMini').title = t(next === 'mini' ? 'restore' : 'miniMode');
  requestAnimationFrame(() => {
    const h = $('titlebar').offsetHeight + $('deck').offsetHeight + 2;
    window.nt.invoke('win', 'mode', { mode: next, height: h });
  });
}

$('btnPair').onclick = openPair;
$('btnSend').onclick = () => {
  S.tab = 'outbox';
  renderList();
  window.nt.invoke('outbox-pick');
};
$('btnText').onclick = () => openText();
$('btnFolder').onclick = () => window.nt.invoke('open-folder');
$('btnSettings').onclick = () => openSettings();
$('btnNewCode').onclick = () => window.nt.invoke('pair-new');
$('setLang').onchange = (e) => window.nt.invoke('set', 'lang', e.target.value);
$('setAutostart').onchange = (e) => window.nt.invoke('set', 'autostart', e.target.checked);
$('setTray').onchange = (e) => window.nt.invoke('set', 'closeToTray', e.target.checked);
$('setTop').onchange = (e) => window.nt.invoke('set', 'alwaysOnTop', e.target.checked);
$('setSounds').onchange = (e) => window.nt.invoke('set', 'sounds', e.target.checked);
$('setCopy').onchange = (e) => window.nt.invoke('set', 'autoCopyText', e.target.checked);
$('setSplit').onchange = (e) => window.nt.invoke('set', 'splitByType', e.target.checked);
$('setScale').onchange = (e) => window.nt.invoke('set', 'scale', Number(e.target.value));
$('setIp').onchange = (e) => window.nt.invoke('set', 'preferredIp', e.target.value);
$('setPcName').onchange = (e) => window.nt.invoke('set', 'pcName', e.target.value);
$('setPcName').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
for (const r of document.querySelectorAll('input[name=heic]')) r.onchange = () => window.nt.invoke('set', 'heicMode', r.value);
document.querySelector('#settingsDlg').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]')?.dataset.pick;
  if (pick) window.nt.invoke('pick-folder', pick);
  const reset = e.target.closest('[data-reset]')?.dataset.reset;
  if (reset) window.nt.invoke('reset-folder', reset);
  const skin = e.target.closest('[data-skin]')?.dataset.skin;
  if (skin) window.nt.invoke('set', 'skin', skin);
});
$('btnSkinsFolder').onclick = () => window.nt.invoke('skins-folder');
$('btnStatsReset').onclick = () => window.nt.invoke('stats-reset');
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
  if (outDrag || !e.dataTransfer.types.includes('Files')) return;
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
  if (outDrag) {
    outDrag = false; // se soltó dentro de la propia ventana: no es un envío al móvil
    return;
  }
  const paths = [...e.dataTransfer.files].map((f) => window.nt.pathForFile(f)).filter(Boolean);
  if (paths.length) {
    window.nt.invoke('outbox-add', paths);
    S.tab = 'outbox';
    renderList();
  } else {
    const text = e.dataTransfer.getData('text');
    if (text) openText(text);
  }
});

// ───────────── asistente «No conecta» ─────────────
let diagChecks = [];
function openDiag() {
  for (const d of document.querySelectorAll('.overlay')) d.hidden = true;
  $('diagDlg').hidden = false;
  runDiag();
}
async function runDiag() {
  $('diagList').replaceChildren(el('li', 'info', t('diagChecking')));
  diagChecks = await window.nt.invoke('diagnostics');
  renderDiag();
}
function diagRow(c) {
  const d = c.data || {};
  const acts = [];
  const act = (key, fn) => acts.push(btn(t(key), null, fn, 'nt-btn'));
  let text = '';
  switch (c.id) {
    case 'server':
      text = c.status === 'ok' ? t('dServerOk', { port: d.port }) : t('dServerErr', { port: d.port, error: d.error });
      break;
    case 'ip':
      text = c.status === 'error' ? t('dIpErr') : c.status === 'warn' ? t('dIpMulti', { ip: d.ip, all: d.all.join(', ') }) : t('dIpOk', { ip: d.ip });
      break;
    case 'profile': {
      const pub = (d.profiles || []).find((p) => p.category === 'Public');
      if (c.status === 'warn') {
        text = t('dProfileWarn', { name: pub?.name || '' });
        act('btnNetSettings', () => window.nt.invoke('open-network-settings'));
      } else if (c.status === 'info') text = t('dProfileInfo');
      else text = t('dProfileOk', { list: d.profiles.map((p) => `${p.name} (${p.category === 'DomainAuthenticated' ? 'Domain' : p.category})`).join(', ') });
      break;
    }
    case 'firewall':
      text = d.unknown ? t('dFwUnknown') : d.blocked ? t('dFwBlock') : d.allowed ? t('dFwOk') : t('dFwWarn');
      if (c.status !== 'ok') {
        act('btnFw', async () => {
          const ok = await window.nt.invoke('firewall-add');
          toast(ok ? t('fwAdded') : t('fwFailed'));
          runDiag();
        });
      }
      break;
    case 'mdns':
      text = c.status === 'ok' ? t('dMdnsOk', { host: d.host }) : t('dMdnsWarn', { host: d.host });
      break;
    case 'contact':
      text = d.contact ? t('dContactOk', { ip: d.contact.ip, when: timeAgo(t, d.contact.at).toLowerCase() }) : t('dContactWarn', { url: d.url });
      break;
    case 'tips':
      text = t('dTips');
      break;
  }
  return { text, acts };
}
function renderDiag() {
  const marks = { ok: '✓', warn: '!', error: '✗', info: 'i' };
  $('diagList').replaceChildren(...diagChecks.map((c) => {
    const li = el('li', c.status);
    const body = el('div');
    const { text, acts } = diagRow(c);
    body.append(el('div', '', text));
    if (acts.length) {
      const a = el('div', 'acts');
      a.append(...acts);
      body.append(a);
    }
    li.append(el('span', 'mark', marks[c.status]), body);
    return li;
  }));
}
$('btnDiagRun').onclick = runDiag;
$('btnPairDiag').onclick = openDiag;
$('btnPrefsDiag').onclick = openDiag;

// ───────────── editor de skins ─────────────
const EDITOR_FIELDS = [
  ['gFrame', [['frameTop', 'cTop', '--frame-bg', 0], ['frameBottom', 'cBottom', '--frame-bg', -1], ['text', 'cText', '--text', 0]]],
  ['gTitle', [['titleTop', 'cTop', '--title-bg', 0], ['titleBottom', 'cBottom', '--title-bg', -1], ['titleFg', 'cText', '--title-fg', 0]]],
  ['gLcd', [['lcdBg', 'cBg', '--lcd-bg', 0], ['lcdFg', 'cText', '--lcd-fg', 0], ['lcdDim', 'cDim', '--lcd-dim', 0]]],
  ['gButtons', [['btnTop', 'cTop', '--btn-bg', 0], ['btnBottom', 'cBottom', '--btn-bg', -1], ['btnFg', 'cText', '--btn-fg', 0]]],
  ['gList', [['listBg', 'cBg', '--list-bg', 0], ['listFg', 'cText', '--list-fg', 0], ['listSel', 'cSel', '--list-sel-bg', 0]]],
  ['gProgress', [['accent1', 'cTop', '--accent', 0], ['accent2', 'cBottom', '--accent', -1], ['viz1', 'cLow', '--viz-1', 0], ['viz2', 'cMid', '--viz-2', 0], ['viz3', 'cHigh', '--viz-3', 0]]],
];
const colorCtx = document.createElement('canvas').getContext('2d');
/** Cualquier color CSS → #rrggbb (sin transparencia). */
function toHex(c) {
  colorCtx.fillStyle = '#000';
  colorCtx.fillStyle = c;
  const v = colorCtx.fillStyle;
  if (v.startsWith('#')) return v;
  const m = v.match(/[\d.]+/g) || [0, 0, 0];
  return '#' + m.slice(0, 3).map((x) => Math.round(+x).toString(16).padStart(2, '0')).join('');
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (a) => '#' + a.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, k) => hex(rgb(a).map((x, i) => x + (rgb(b)[i] - x) * k));
const lighten = (a, k) => mix(a, '#ffffff', k);
const darken = (a, k) => mix(a, '#000000', k);
const alpha = (a, k) => `rgba(${rgb(a).join(', ')}, ${k})`;
const contrast = (a) => (rgb(a).reduce((s, x, i) => s + x * [0.299, 0.587, 0.114][i], 0) > 150 ? '#000000' : '#ffffff');
const grad = (a, b) => `linear-gradient(180deg, ${a} 0%, ${b} 100%)`;

function editorDefaults() {
  const cs = getComputedStyle(document.body);
  const v = {};
  for (const [, fields] of EDITOR_FIELDS) {
    for (const [key, , cssVar, pick] of fields) {
      const raw = cs.getPropertyValue(cssVar);
      const found = raw.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || [raw.trim() || '#000'];
      v[key] = toHex(pick === -1 ? found[found.length - 1] : found[0]);
    }
  }
  v.round = parseInt(cs.getPropertyValue('--btn-radius'), 10) >= 8;
  return v;
}

function skinVars(v) {
  const cs = getComputedStyle(document.body);
  return {
    '--font-ui': cs.getPropertyValue('--font-ui').trim(),
    '--font-lcd': cs.getPropertyValue('--font-lcd').trim(),
    '--text': v.text, '--text-dim': mix(v.text, v.frameBottom, 0.45),
    '--frame-bg': grad(v.frameTop, v.frameBottom), '--frame-hi': lighten(v.frameTop, 0.3), '--frame-lo': darken(v.frameBottom, 0.6),
    '--panel-bg': mix(v.frameTop, v.frameBottom, 0.5),
    '--title-bg': grad(v.titleTop, v.titleBottom), '--title-fg': v.titleFg,
    '--title-stripe': `repeating-linear-gradient(180deg, ${v.titleFg} 0 1px, transparent 1px 3px)`,
    '--lcd-bg': v.lcdBg, '--lcd-fg': v.lcdFg, '--lcd-dim': v.lcdDim, '--lcd-glow': `0 0 6px ${alpha(v.lcdFg, 0.55)}`,
    '--lcd-border': darken(v.lcdBg, 0.5), '--lcd-radius': v.round ? '8px' : '0',
    '--btn-bg': grad(v.btnTop, v.btnBottom), '--btn-hover': grad(lighten(v.btnTop, 0.12), lighten(v.btnBottom, 0.12)),
    '--btn-press': grad(darken(v.btnBottom, 0.2), v.btnTop), '--btn-fg': v.btnFg,
    '--btn-hi': lighten(v.btnTop, 0.35), '--btn-lo': darken(v.btnBottom, 0.6), '--btn-radius': v.round ? '12px' : '2px',
    '--accent': grad(v.accent1, v.accent2), '--track': darken(v.frameBottom, 0.55), '--progress-radius': v.round ? '5px' : '0',
    '--list-bg': v.listBg, '--list-fg': v.listFg, '--list-dim': mix(v.listFg, v.listBg, 0.45),
    '--list-sel-bg': v.listSel, '--list-sel-fg': contrast(v.listSel), '--list-active': contrast(v.listBg), '--list-alt': 'transparent',
    '--viz-1': v.viz1, '--viz-2': v.viz2, '--viz-3': v.viz3, '--viz-peak': lighten(v.viz3, 0.5),
    '--input-bg': v.listBg, '--input-fg': v.listFg, '--legend-fg': v.text, '--check-color': v.listSel,
    '--fieldset-radius': v.round ? '6px' : '0', '--input-radius': v.round ? '4px' : '0',
  };
}

let editor = null; // { id, values }
function previewSkin() {
  for (const [k, val] of Object.entries(skinVars(editor.values))) document.body.style.setProperty(k, val);
  viz.readColors();
}
function closeEditor() {
  document.body.removeAttribute('style');
  $('editorDlg').hidden = true;
  editor = null;
  requestAnimationFrame(() => viz.readColors());
}
function openEditor(id) {
  const custom = id && S.customSkins.find((s) => s.id === id);
  let values = editorDefaults();
  const saved = custom && /@editor\s+(\{.*?\})\s*\*\//s.exec(custom.css);
  if (saved) {
    try { values = { ...values, ...JSON.parse(saved[1]) }; } catch { /* hecha a mano: se parte de lo que se ve */ }
  }
  editor = { id: custom ? custom.id : null, values };
  $('edName').value = custom ? custom.name : `${t('skinName')} ${S.customSkins.length + 1}`;
  const groups = $('editorGroups');
  groups.replaceChildren(...EDITOR_FIELDS.map(([gKey, fields]) => {
    const fs = el('fieldset', 'nt-fieldset');
    fs.append(el('legend', '', t(gKey)));
    for (const [key, label] of fields) {
      const row = el('label', 'color-row');
      const input = el('input');
      input.type = 'color';
      input.value = values[key];
      input.oninput = () => {
        editor.values[key] = input.value;
        previewSkin();
      };
      row.append(el('span', '', t(label)), input);
      fs.append(row);
    }
    if (gKey === 'gButtons') {
      const row = el('label', 'nt-check color-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!values.round;
      cb.onchange = () => {
        editor.values.round = cb.checked;
        previewSkin();
      };
      row.append(cb, el('span', '', t('cRound')));
      fs.append(row);
    }
    return fs;
  }));
  for (const d of document.querySelectorAll('.overlay')) d.hidden = true;
  $('editorDlg').hidden = false;
  previewSkin();
}
async function saveEditor() {
  const name = $('edName').value.trim() || 'Mi skin';
  const vars = skinVars(editor.values);
  const css = `/* @name ${name.replace(/\*\//g, '')} */\n/* @editor ${JSON.stringify(editor.values)} */\n.skin-__ID__ {\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`;
  await window.nt.invoke('skin-save', { id: editor.id, name, css });
  closeEditor();
}
$('btnNewSkin').onclick = () => openEditor(null);
$('btnEditSkin').onclick = () => openEditor(S.settings.skin);
$('btnDeleteSkin').onclick = () => window.nt.invoke('skin-delete', S.settings.skin);
$('btnEditorCancel').onclick = closeEditor;
$('btnEditorX').onclick = closeEditor;
$('btnEditorSave').onclick = saveEditor;

// ───────────── visualizador ─────────────
const VIZ_MODES = ['bars', 'scope', 'off'];
$('viz').onclick = () => {
  const next = VIZ_MODES[(VIZ_MODES.indexOf(viz.mode) + 1) % VIZ_MODES.length];
  viz.setMode(next);
  sound.play('click');
  window.nt.invoke('set', 'vizMode', next);
};

// ───────────── eventos del proceso principal ─────────────
window.nt.on((name, p) => {
  switch (name) {
    case 'transfer-start':
      S.active.set(p.id, p);
      sound.play('start');
      break;
    case 'transfer-progress': {
      const a = S.active.get(p.id);
      if (!a) return;
      if (p.received > a.received) bytesTick += p.received - a.received;
      a.received = p.received;
      // Solo se actualiza la fila de esta transferencia, sin rehacer la lista.
      const row = S.tab === 'transfers' && $('list').querySelector(`li[data-id="${p.id}"]`);
      if (row) {
        row.querySelector('.pct').textContent = stateLabel(a);
        row.querySelector('.nt-progress > i').style.width = (a.size ? (a.received / a.size) * 100 : 0) + '%';
        return;
      }
      break;
    }
    case 'transfer-state': {
      const a = S.active.get(p.id);
      if (a) a.state = p.state;
      break;
    }
    case 'transfer-done': {
      const a = S.active.get(p.id);
      if (a && p.size > a.received) bytesTick += p.size - a.received;
      S.active.delete(p.id);
      S.history.unshift(p);
      S.history = S.history.slice(0, 200);
      sound.play('done');
      break;
    }
    case 'transfer-error':
      S.active.delete(p.id);
      sound.play('error');
      break;
    case 'transfer-cancelled':
      S.active.delete(p.id);
      break;
    case 'text-received':
      S.history.unshift(p);
      sound.play('text');
      toast(t('textReceived', { device: p.device }) + (p.copied ? ' · ' + t('textCopied') : ''));
      break;
    case 'stats':
      S.stats = p;
      if (!$('settingsDlg').hidden) renderStats();
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
      sound.play('pair');
      S.tab = 'devices';
      break;
    case 'skins':
      S.customSkins = p;
      applySkin();
      if (!$('settingsDlg').hidden) fillSettings();
      break;
    case 'settings': {
      const langChanged = p.lang !== S.settings.lang;
      const scaleChanged = p.scale !== S.settings.scale;
      S.settings = p;
      t = translator(p.lang);
      sound.setEnabled(p.sounds);
      viz.setMode(p.vizMode);
      applySkin();
      if (langChanged) applyI18n();
      if (!$('settingsDlg').hidden) fillSettings();
      if (scaleChanged && mode !== 'normal') setMode(mode); // recalcula la altura con el nuevo tamaño
      break;
    }
    case 'show-tab':
      S.tab = p;
      break;
    case 'open-diag':
      openDiag();
      break;
    case 'lan-contact': {
      const c = diagChecks.find((x) => x.id === 'contact');
      if (c && !$('diagDlg').hidden) {
        c.status = 'ok';
        c.data.contact = p;
        renderDiag();
      }
      break;
    }
    case 'open-pair':
      openPair();
      break;
    case 'open-text':
      openText();
      break;
    case 'open-settings':
      openSettings(p);
      break;
    case 'toggle-mini':
      setMode(mode === 'mini' ? 'normal' : 'mini');
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
  const state = await window.nt.invoke('state');
  const { active, startTab, ...rest } = state;
  Object.assign(S, rest);
  for (const a of active) S.active.set(a.id, a);
  if (startTab) S.tab = startTab;
  t = translator(S.settings.lang);
  sound.setEnabled(S.settings.sounds);
  viz.setMode(S.settings.vizMode);
  applySkin();
  applyI18n();
  renderList();
  renderLcd();
  tickMarquee();
  if (S.settings.viewMode && S.settings.viewMode !== 'normal') setMode(S.settings.viewMode);
  setInterval(() => !S.active.size && renderList(), 60000);
})();
