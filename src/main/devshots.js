'use strict';
/**
 * Solo para desarrollo (NT_SHOTS=<carpeta>): prueba la app de punta a punta con datos reales y guarda capturas.
 * - Sube archivos por la API reanudable (con miniaturas), deja una subida en curso y otra en pausa.
 * - Usa el código real del móvil en una ventana de 390×844 para subir un archivo y enviar un texto.
 * - Captura el PC (3 skins + skin personalizada), el móvil, el visor, el modo mini y las preferencias.
 */
const { BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Una «foto» de prueba: degradado de colores (BGRA) convertido a JPG. */
function fakePhoto(hue, w = 320, h = 240) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = (x / w + hue) % 1;
      buf[i] = Math.round(255 * Math.abs(Math.sin(a * Math.PI))); // B
      buf[i + 1] = Math.round(200 * (y / h)); // G
      buf[i + 2] = Math.round(255 * Math.abs(Math.cos(a * Math.PI))); // R
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h }).toJPEG(80);
}
const dataUrl = (jpg) => 'data:image/jpeg;base64,' + jpg.toString('base64');

function request(port, token, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'X-Device-Token': token, ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    if (body && body.slow) {
      // ~1 MB cada 100 ms, para que se vea en curso en las capturas
      let off = 0;
      const step = () => {
        if (off >= body.buf.length) return req.end();
        req.write(body.buf.subarray(off, off + 1048576));
        off += 1048576;
        setTimeout(step, 100);
      };
      return step();
    }
    req.end(body);
  });
}

async function upload(port, token, name, buf, { thumb, slow = false, mtime = 0 } = {}) {
  const meta = JSON.stringify({ name, size: buf.length, mtime, thumb: thumb ? dataUrl(thumb) : undefined });
  const s = JSON.parse((await request(port, token, 'POST', '/api/v1/uploads', meta, { 'Content-Type': 'application/json' })).data);
  const put = request(port, token, 'PUT', `/api/v1/uploads/${s.id}?offset=0`, slow ? { slow: true, buf } : buf);
  return { id: s.id, done: put };
}

async function capture(w, file) {
  fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
}

module.exports = async function devshots({ app, win, server, store, send, viewer, settings }) {
  const out = path.resolve(process.env.NT_SHOTS);
  fs.mkdirSync(out, { recursive: true });
  store.set('destDir', path.join(out, 'received'));
  const report = [];
  const check = (name, ok, extra = '') => report.push(`${ok ? '✔' : '✘'} ${name}${extra ? ' — ' + extra : ''}`);
  const fullSettings = settings;
  try {
    const { token } = server.pairDevice('iPhone de Ben', 'ios');
    const port = server.port;

    // ── Historial con miniaturas ──
    const photos = [0.0, 0.33, 0.66].map((h) => fakePhoto(h));
    for (const [i, jpg] of photos.entries()) {
      const u = await upload(port, token, `IMG_04${21 + i}.JPG`, jpg, { thumb: jpg });
      await u.done;
    }
    await (await upload(port, token, 'Factura marzo.pdf', Buffer.alloc(300000, 7))).done;
    const heicSample = process.env.HEIC_SAMPLE;
    if (heicSample && fs.existsSync(heicSample)) {
      store.set('heicMode', 'both');
      const u = await upload(port, token, 'IMG_0500.HEIC', fs.readFileSync(heicSample), { thumb: photos[1] });
      const r = await u.done;
      check('HEIC dentro de la app (modo both)', r.status === 200 && fs.existsSync(path.join(out, 'received', 'IMG_0500.jpg')), r.data);
      store.set('heicMode', 'original');
    }
    await request(port, token, 'POST', '/api/v1/text', JSON.stringify({ text: 'https://github.com/Nyra31/N-Transfer' }), { 'Content-Type': 'application/json' });
    await server.addToOutbox([path.join(out, 'received', 'IMG_0421.JPG'), path.join(out, 'received', 'Factura marzo.pdf')]);
    server.addTextToOutbox('Código del wifi: N-Transfer-2000');
    await wait(500);
    check('miniatura generada en el PC para «Para el móvil»', server.outbox().some((o) => o.thumb), JSON.stringify(server.outbox().map((o) => o.thumb || null)));

    // ── Una subida en pausa y otra en curso (vista previa en directo) ──
    const paused = await upload(port, token, 'VID_0530.MOV', Buffer.alloc(60 * 1048576, 2), { thumb: fakePhoto(0.85), slow: true });
    paused.done.catch(() => {}); // al pausar, el servidor corta esta conexión a propósito
    await wait(600);
    server.pauseUpload(paused.id);
    const slow = await upload(port, token, 'IMG_0599.MOV', Buffer.alloc(90 * 1048576, 1), { thumb: fakePhoto(0.12), slow: true });

    win.show();
    await wait(2500);
    for (const skin of ['winamp', 'chrome', 'luna']) {
      store.set('skin', skin);
      server.settingsChanged();
      send('settings', fullSettings());
      await wait(700);
      await capture(win, path.join(out, `pc-${skin}.png`));
    }

    // ── Modo mini ──
    send('toggle-mini');
    await wait(900);
    await capture(win, path.join(out, 'pc-mini.png'));
    send('toggle-mini');
    await wait(700);

    // ── Preferencias ──
    store.set('splitByType', true);
    send('settings', fullSettings());
    for (const page of ['folders', 'stats']) {
      send('open-settings', page);
      await wait(500);
      await capture(win, path.join(out, `pc-prefs-${page}.png`));
    }
    store.set('splitByType', false);
    send('settings', fullSettings());

    // ── Skin personalizada (la plantilla) ──
    const skinsDir = path.join(app.getPath('userData'), 'skins');
    fs.mkdirSync(skinsDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'shared', 'skins', 'template.css'), path.join(skinsDir, 'mi-skin.css'));
    await wait(1200);
    check('skin personalizada detectada', server.skinsList().some((s) => s.id === 'mi-skin'));
    store.set('skin', 'mi-skin');
    server.settingsChanged();
    send('settings', fullSettings());
    await wait(800);
    send('open-settings', 'skins');
    await wait(400);
    await capture(win, path.join(out, 'pc-custom-skin.png'));
    send('open-settings', 'general');
    await wait(100);

    // ── Móvil (código real) ──
    const mobile = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { partition: 'shots-mobile' } });
    await mobile.loadURL(`http://127.0.0.1:${port}/?d=${token}&skin=winamp`);
    await wait(1200);
    const before = server.history().length;
    // Sube una «foto» (PNG del icono + relleno) eligiéndola como haría el usuario
    await mobile.webContents.executeJavaScript(`(async () => {
      const png = await (await fetch('/m/icons/icon-512.png')).arrayBuffer();
      const file = new File([png, new Uint8Array(8 * 1048576)], 'IMG_0601.PNG', { type: 'image/png', lastModified: 1700000000000 });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('pickMedia'); input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    })()`);
    await wait(4000);
    const got = server.history().find((h) => h.name === 'IMG_0601.PNG');
    check('subida desde el móvil con miniatura', !!got && !!got.thumb && got.size === 8 * 1048576 + fs.statSync(path.join(__dirname, '..', 'mobile', 'icons', 'icon-512.png')).size,
      got ? `thumb=${got.thumb} size=${got.size}` : `historial ${before}→${server.history().length}`);
    // Texto desde el móvil
    await mobile.webContents.executeJavaScript(`(() => {
      document.getElementById('btnText').click();
      document.getElementById('textInput').value = 'Hola desde el móvil';
      document.getElementById('btnTextSend').click();
    })()`);
    await wait(1200);
    check('texto desde el móvil', server.history().some((h) => h.kind === 'text' && h.text === 'Hola desde el móvil'));
    const domCheck = await mobile.webContents.executeJavaScript(`({
      texts: [...document.querySelectorAll('#fromPc .text-body')].map((e) => e.textContent),
      thumbs: document.querySelectorAll('#fromPc .thumb img').length,
      queueThumbs: document.querySelectorAll('#queue .thumb img').length,
    })`);
    check('el móvil muestra el texto y las miniaturas del PC', domCheck.texts.includes('Código del wifi: N-Transfer-2000') && domCheck.thumbs >= 1, JSON.stringify(domCheck));
    for (const skin of ['winamp', 'luna', 'mi-skin']) {
      // Igual que elegirla en el menú del móvil
      await mobile.webContents.executeJavaScript(`document.querySelector('#skinRow [data-skin="${skin}"]').click(); window.scrollTo(0, 0);`);
      await wait(500);
      const vars = await mobile.webContents.executeJavaScript(`getComputedStyle(document.body).getPropertyValue('--lcd-fg').trim()`);
      check(`skin ${skin} aplicada en el móvil`, !!vars, vars);
      await capture(mobile, path.join(out, `mobile-${skin}.png`));
    }

    // ── Pausa/cancelación remotas desde el PC hacia el móvil ──
    await mobile.webContents.executeJavaScript(`(() => {
      const file = new File([new Uint8Array(400 * 1048576)], 'VID_GRANDE.MOV', { type: 'video/quicktime' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('pickFiles'); input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    })()`);
    let big = null;
    for (let i = 0; i < 40 && !big; i++) {
      await wait(50);
      big = server.activeTransfers().find((a) => a.name === 'VID_GRANDE.MOV');
    }
    if (big) {
      server.pauseUpload(big.id);
      await wait(800);
      const st = await mobile.webContents.executeJavaScript(`[...document.querySelectorAll('#queue li')].map((li) => li.querySelector('.name').textContent + ':' + li.querySelector('.state').textContent)`);
      check('pausa desde el PC llega al móvil', st.some((s) => /VID_GRANDE.*(pausa|Paused)/i.test(s)), JSON.stringify(st));
      server.resumeUpload(big.id);
      await wait(300);
      server.cancelUpload(big.id);
      await wait(800);
      const st2 = await mobile.webContents.executeJavaScript(`[...document.querySelectorAll('#queue li')].map((li) => li.querySelector('.name').textContent + ':' + li.querySelector('.state').textContent)`);
      check('cancelación desde el PC llega al móvil', st2.some((s) => /VID_GRANDE.*(Cancelado|Cancelled)/.test(s)), JSON.stringify(st2));
      check('sin .ntpart tras cancelar', !fs.existsSync(path.join(out, 'received', 'VID_GRANDE.MOV.ntpart')));
    } else {
      check('subida grande desde el móvil (para pausa remota)', false, 'no apareció');
    }

    // ── Visor ──
    const photoEntry = server.history().find((h) => h.name === 'IMG_0422.JPG');
    viewer.open(photoEntry.id);
    await wait(1800);
    await capture(viewer.window, path.join(out, 'viewer.png'));
    const heicEntry = server.history().find((h) => h.name === 'IMG_0500.HEIC');
    if (heicEntry) {
      viewer.open(heicEntry.id);
      await wait(2500);
      const shown = await viewer.window.webContents.executeJavaScript(`({ src: document.getElementById('photo').src, ok: !document.getElementById('photo').hidden && document.getElementById('photo').naturalWidth > 0 })`);
      check('el visor muestra una foto HEIC (convertida)', shown.ok, shown.src.slice(-40));
    }
    viewer.window?.close();

    // Restaurar skin clásica para dejar la configuración limpia
    store.set('skin', 'winamp');
    server.cancelUpload(paused.id);
    const r = await slow.done;
    check('subida lenta terminada', r.status === 200, r.data);
    report.push('stats: ' + JSON.stringify(server.stats()));
  } catch (e) {
    report.push('ERROR ' + e.stack);
  }
  fs.writeFileSync(path.join(out, 'report.txt'), report.join('\n'));
  store.flush();
  app.exit(0);
};
