/* Visor de fotos y vídeos de N-Transfer. */
'use strict';
(function () {
  const { translator, formatSize } = window.NT_I18N;
  const $ = (id) => document.getElementById(id);
  let items = [];
  let index = Number(new URLSearchParams(location.search).get('i')) || 0;
  let thumbBase = '';
  let lang = 'es';
  let t = translator(lang);
  let loadSeq = 0;

  function applySettings(settings, customSkins) {
    lang = settings.lang;
    t = translator(lang);
    if (customSkins) $('customSkins').textContent = customSkins.map((s) => s.css).join('\n');
    document.body.className = 'nt skin-' + settings.skin;
    document.documentElement.lang = lang;
    for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
    for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  }

  function renderStrip() {
    const strip = $('strip');
    strip.replaceChildren(...items.map((it, i) => {
      const b = document.createElement('button');
      b.title = it.name;
      if (it.thumb) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = thumbBase + encodeURIComponent(it.thumb);
        b.append(img);
      } else {
        b.textContent = it.kind === 'video' ? '▶' : '▣';
      }
      b.onclick = () => show(i);
      return b;
    }));
  }

  async function show(i) {
    if (!items.length) return;
    index = (i + items.length) % items.length;
    const it = items[index];
    const seq = ++loadSeq;
    $('title').textContent = it.name;
    $('info').textContent = `${it.name} · ${formatSize(it.size)} · ${it.device} · ${new Date(it.at).toLocaleString(lang)}`;
    $('counter').textContent = `${index + 1} / ${items.length}`;
    [...$('strip').children].forEach((b, n) => b.classList.toggle('current', n === index));
    $('strip').children[index]?.scrollIntoView({ inline: 'center', block: 'nearest' });

    const video = $('video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    $('photo').hidden = true;
    video.hidden = true;
    $('noPlay').hidden = true;
    $('loading').hidden = false;

    const src = await window.nt.invoke('viewer-src', it.id).catch(() => null);
    if (seq !== loadSeq) return; // el usuario ya pasó a otra
    $('loading').hidden = true;
    if (!src) return showNoPlay(it);
    if (it.kind === 'video') {
      video.hidden = false;
      video.src = src;
      video.onerror = () => seq === loadSeq && showNoPlay(it);
      video.play().catch(() => {});
    } else {
      const img = $('photo');
      img.onerror = () => seq === loadSeq && showNoPlay(it);
      img.src = src;
      img.hidden = false;
    }
  }

  function showNoPlay(it) {
    $('video').hidden = true;
    $('photo').hidden = true;
    $('noPlayThumb').hidden = !it.thumb;
    if (it.thumb) $('noPlayThumb').src = thumbBase + encodeURIComponent(it.thumb);
    $('noPlay').hidden = false;
  }

  $('prev').onclick = () => show(index - 1);
  $('next').onclick = () => show(index + 1);
  $('btnOpen').onclick = () => window.nt.invoke('viewer-file', 'open', items[index]?.id);
  $('btnShow').onclick = () => window.nt.invoke('viewer-file', 'show', items[index]?.id);
  $('btnSystem').onclick = () => window.nt.invoke('viewer-file', 'open', items[index]?.id);
  $('titlebar').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) window.nt.invoke('viewer-win', act);
  });
  $('titlebar').addEventListener('dblclick', (e) => !e.target.closest('button') && window.nt.invoke('viewer-win', 'maximize'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
    else if (e.key === 'Escape') window.nt.invoke('viewer-win', 'close');
  });

  window.nt.on(async (name, p) => {
    if (name === 'settings') applySettings(p);
    else if (name === 'skins') $('customSkins').textContent = p.map((s) => s.css).join('\n');
    else if (name === 'viewer-goto') {
      const state = await window.nt.invoke('viewer-state');
      items = state.items;
      renderStrip();
      show(p);
    }
  });

  (async () => {
    const state = await window.nt.invoke('viewer-state');
    items = state.items;
    thumbBase = state.thumbBase;
    applySettings(state.settings, state.customSkins);
    renderStrip();
    show(index);
  })();
})();
