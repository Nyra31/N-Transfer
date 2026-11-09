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

/** Captura con reintentos: si la ventana aún no se ha pintado, Chromium devuelve «UnknownVizError». */
async function capture(w, file) {
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
      return;
    } catch (e) {
      if (i >= 4) throw e;
      w.show();
      await wait(500);
    }
  }
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

    // ── Emparejamiento: solo con la ventana «Emparejar» abierta ──
    await win.webContents.executeJavaScript(`document.querySelectorAll('.overlay').forEach((d) => (d.hidden = true))`);
    await wait(300);
    check('emparejamiento cerrado con la ventana cerrada', !server.pairingOpen);
    const closedTry = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { partition: 'shots-closed' } });
    await closedTry.loadURL(`http://127.0.0.1:${port}/pair?c=${server.pairCode}`);
    await wait(500);
    await closedTry.webContents.executeJavaScript(`document.getElementById('btnPair').click()`);
    await wait(1200);
    const closedMsg = await closedTry.webContents.executeJavaScript(`document.getElementById('pairMsg').textContent`);
    check('el móvil explica que hay que abrir «Emparejar» en el PC', /Emparejar/.test(closedMsg), closedMsg);
    closedTry.destroy();

    send('open-pair');
    await wait(500);
    check('la ventana «Emparejar» abre el emparejamiento', server.pairingOpen);
    // Desde la página del QR (como Safari): tras emparejar, la página se recarga con el token
    const safari = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { partition: 'shots-safari' } });
    await safari.loadURL(`http://127.0.0.1:${port}/pair?c=${server.pairCode}`);
    await wait(500);
    await safari.webContents.executeJavaScript(`document.getElementById('btnPair').click()`);
    await wait(2500);
    const after = await safari.webContents.executeJavaScript(
      `({ url: location.href, manifest: document.getElementById('manifest').getAttribute('href'),
          view: ['viewPair','viewNone','viewMain'].find((v) => !document.getElementById(v).hidden) })`);
    check('emparejar desde el QR deja el token en la URL y en el manifest',
      after.view === 'viewMain' && /[?&]d=/.test(after.url) && /\?d=/.test(after.manifest), `${after.view} ${after.manifest.replace(/d=.*/, 'd=…')}`);
    safari.destroy();
    check('tras emparejar, la ventana se cierra y el emparejamiento también', !server.pairingOpen);
    send('open-pair'); // para el siguiente móvil hay que volver a abrirla
    await wait(500);
    // Desde la app de la pantalla de inicio (sin almacenamiento): escribiendo el código
    const homeApp = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { partition: 'shots-home' } });
    await homeApp.loadURL(`http://127.0.0.1:${port}/`);
    await wait(800);
    await homeApp.webContents.executeJavaScript(`(() => { const i = document.getElementById('codeInput');
      i.value = ${JSON.stringify(server.pairCodeDisplay.toLowerCase())}; i.dispatchEvent(new Event('input')); document.getElementById('btnCode').click(); })()`);
    await wait(2500);
    const viaCode = await homeApp.webContents.executeJavaScript(`['viewPair','viewNone','viewMain'].find((v) => !document.getElementById(v).hidden)`);
    check('emparejar escribiendo el código (app de inicio)', viaCode === 'viewMain', viaCode);
    homeApp.destroy();
    await win.webContents.executeJavaScript(`document.getElementById('pairDlg').hidden = true`);
    await wait(300);
    check('al cerrar «Emparejar» se cierra el emparejamiento', !server.pairingOpen);

    // ── Sin espacio en el disco ──
    server.freeSpaceOverride = () => 120 * 1048576;
    await mobile.webContents.executeJavaScript(`(() => {
      const file = new File([new Uint8Array(64 * 1048576)], 'no-cabe.mov', { type: 'video/quicktime' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('pickFiles'); input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    })()`);
    await wait(1500);
    const full = await mobile.webContents.executeJavaScript(`[...document.querySelectorAll('#queue li')].map((li) => li.querySelector('.name').textContent + ':' + li.querySelector('.state').textContent).find((x) => x.startsWith('no-cabe'))`);
    check('sin espacio: el móvil lo dice y no reintenta', /Sin espacio/.test(full || ''), full);
    await capture(win, path.join(out, 'pc-disk-full.png'));
    server.freeSpaceOverride = null;

    // ── Varios PCs: un segundo servidor en la «red» al que el móvil se empareja desde el menú ──
    const { Store } = require('../core/store');
    const { TransferServer } = require('../core/server');
    const P2 = port + 1;
    const store2 = new Store(path.join(out, 'pc2', 'config.json'), {
      port: P2, destDir: path.join(out, 'pc2', 'recv'), lang: 'es', skin: 'luna', pcName: 'Trabajo', devices: [], outbox: [], history: [],
    });
    const pc2 = new TransferServer({
      store: store2, mobileDir: path.join(__dirname, '..', 'mobile'), sharedDir: path.join(__dirname, '..', 'shared'),
      thumbsDir: path.join(out, 'pc2', 'thumbs'), version: 'test',
    });
    await pc2.start();
    pc2.addTextToOutbox('Hola desde el PC del trabajo');
    pc2.setPairing(true); // en el otro PC, el usuario tendría abierta su ventana «Emparejar»
    server.peers = () => [{ id: pc2.pcId, name: 'Trabajo', ip: '127.0.0.1', port: P2, host: 'trabajo.local', version: 'test' }];
    await mobile.webContents.executeJavaScript(`(async () => {
      window.prompt = () => ${JSON.stringify(pc2.pairCodeDisplay)};
      document.getElementById('btnMenu').click();
      for (let i = 0; i < 40 && !document.querySelector('#pcList button'); i++) await new Promise((r) => setTimeout(r, 100));
      document.querySelector('#pcList button').click();
    })()`);
    await wait(1500);
    await capture(mobile, path.join(out, 'mobile-menu-pcs.png'));
    await mobile.webContents.executeJavaScript(`document.getElementById('btnCloseSheet').click()`);
    const multi = await mobile.webContents.executeJavaScript(`({
      target: document.getElementById('targetSel').selectedOptions[0]?.textContent,
      visible: !document.getElementById('targetRow').hidden,
      texts: [...document.querySelectorAll('#fromPc .text-body')].map((e) => e.textContent),
    })`);
    check('segundo PC emparejado y elegido como destino', multi.visible && /Trabajo/.test(multi.target || ''), JSON.stringify(multi));
    check('el móvil ve lo que ofrece el segundo PC', multi.texts.includes('Hola desde el PC del trabajo'));
    await mobile.webContents.executeJavaScript(`(() => {
      const file = new File([new Uint8Array(300000)], 'para-trabajo.pdf', { type: 'application/pdf' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('pickFiles'); input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    })()`);
    await wait(2000);
    check('subida al segundo PC', fs.existsSync(path.join(out, 'pc2', 'recv', 'para-trabajo.pdf')));
    await capture(mobile, path.join(out, 'mobile-multi-pc.png'));
    await pc2.stop();

    // ── Historial guardado en el móvil (sobrevive a recargar) ──
    await mobile.reload();
    await wait(2000);
    const hist = await mobile.webContents.executeJavaScript(`[...document.querySelectorAll('#histList li:not(.day) .name')].map((e) => e.textContent)`);
    check('historial del móvil tras recargar', hist.includes('IMG_0601.PNG') && hist.includes('para-trabajo.pdf') && hist.includes('Hola desde el móvil'), JSON.stringify(hist));

    // ── Carpeta PC → móvil (ZIP) y «Enviar a → N-Transfer» (segunda copia con --send) ──
    const folder = path.join(out, 'Vacaciones 2026');
    fs.mkdirSync(path.join(folder, 'día 1'), { recursive: true });
    for (const [i, jpg] of photos.entries()) fs.writeFileSync(path.join(folder, i ? 'día 1' : '', `foto${i}.jpg`), jpg);
    const sendFile = path.join(out, 'received', 'Factura marzo.pdf');
    server.removeFromOutbox(server.outbox().find((o) => o.name === 'Factura marzo.pdf')?.id);
    const { spawn } = require('child_process');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NT_SHOTS;
    const second = spawn(process.execPath, [app.getAppPath(), '--send', folder, sendFile], { env, stdio: 'ignore' });
    await new Promise((r) => second.on('exit', r));
    await wait(1500);
    const ob = server.outbox();
    check('«Enviar a»: la segunda copia pasa archivos y carpetas a la primera',
      ob.some((o) => o.type === 'folder' && o.count === 3) && ob.some((o) => o.name === 'Factura marzo.pdf'), JSON.stringify(ob.map((o) => `${o.type}:${o.name}`)));
    await wait(500);
    await capture(win, path.join(out, 'pc-outbox-folder.png'));
    // Volver a enviar a este PC (el destino seguía siendo el segundo PC)
    await mobile.webContents.executeJavaScript(`(() => { const s = document.getElementById('targetSel'); s.value = ''; s.dispatchEvent(new Event('change')); window.scrollTo(0, 0); })()`);
    await wait(500);
    const zipRow = await mobile.webContents.executeJavaScript(`[...document.querySelectorAll('#fromPc li')].map((li) => li.textContent).find((x) => x.includes('Vacaciones'))`);
    check('el móvil ofrece la carpeta como ZIP', /ZIP/.test(zipRow || '') && /3 archivos/.test(zipRow || ''), zipRow);

    // ── Búsqueda, filtros y selección múltiple en el PC ──
    send('show-tab', 'transfers');
    await win.webContents.executeJavaScript(`document.querySelectorAll('.overlay').forEach((d) => (d.hidden = true))`);
    await wait(300);
    const found = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('.tab[data-tab="transfers"]').click(); // por si llegó tarde otro «show-tab»
      const s = document.getElementById('search'); s.value = 'img_042'; s.dispatchEvent(new Event('input'));
      await new Promise((r) => requestAnimationFrame(r));
      const rows = document.querySelectorAll('#list li:not(.active)');
      rows[0].click();
      rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      await new Promise((r) => setTimeout(r, 100));
      return { rows: rows.length, names: [...rows].map((r) => r.querySelector('.name').textContent + '|' + r.className),
               overlays: [...document.querySelectorAll('.overlay')].filter((d) => !d.hidden).map((d) => d.id),
               summary: document.getElementById('summary').textContent,
               actions: [...document.querySelectorAll('#actions button')].map((b) => b.textContent) };
    })()`);
    check('búsqueda + selección múltiple', found.rows === 3 && /2 seleccionados/.test(found.summary) && found.actions.includes('Papelera'), JSON.stringify(found));
    await capture(win, path.join(out, 'pc-search.png'));
    await win.webContents.executeJavaScript(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);

    // ── Asistente «No conecta» ──
    send('open-diag');
    await wait(9000); // las comprobaciones de firewall tardan unos segundos
    const diag = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#diagList li')].map((li) => li.className + ':' + li.textContent.slice(0, 60))`);
    check('asistente «No conecta» con todas las comprobaciones', diag.length >= 6, JSON.stringify(diag));
    await capture(win, path.join(out, 'pc-diag.png'));
    await win.webContents.executeJavaScript(`document.getElementById('diagDlg').hidden = true`);

    // ── Tamaño doble y osciloscopio ──
    const w1 = win.getBounds().width;
    await win.webContents.executeJavaScript(`window.nt.invoke('set', 'scale', 2)`);
    await wait(800);
    const w2 = win.getBounds().width;
    check('tamaño doble', Math.abs(w2 - w1 * 2) <= 2 && win.webContents.getZoomFactor() === 2, `${w1} → ${w2}, zoom ${win.webContents.getZoomFactor()}`);
    await win.webContents.executeJavaScript(`window.nt.invoke('set', 'scale', 1)`);
    await wait(500);
    await win.webContents.executeJavaScript(`document.getElementById('viz').click()`);
    await wait(400);
    check('visualizador en modo osciloscopio', store.get('vizMode') === 'scope');

    // ── Editor de skins ──
    send('open-settings', 'skins');
    await wait(400);
    await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('btnNewSkin').click();
      await new Promise((r) => setTimeout(r, 200));
      document.getElementById('edName').value = 'Atardecer';
      const inputs = document.querySelectorAll('#editorGroups input[type=color]');
      const set = (i, v) => { inputs[i].value = v; inputs[i].dispatchEvent(new Event('input')); };
      set(0, '#ff8a3d'); set(1, '#5b1a3a'); set(6, '#1a0a12'); set(7, '#ffb347'); set(15, '#ff6a00'); set(16, '#ffd000');
    })()`);
    await wait(500);
    await capture(win, path.join(out, 'pc-skin-editor.png'));
    await win.webContents.executeJavaScript(`document.getElementById('btnEditorSave').click()`);
    await wait(1500);
    const saved = path.join(app.getPath('userData'), 'skins', 'atardecer.css');
    check('editor de skins guarda la skin y la aplica', fs.existsSync(saved) && /@editor/.test(fs.readFileSync(saved, 'utf8')) && store.get('skin') === 'atardecer');
    send('open-settings', 'general');
    await win.webContents.executeJavaScript(`document.getElementById('settingsDlg').hidden = true`);
    await wait(500);
    await capture(win, path.join(out, 'pc-custom-saved.png'));
    store.set('vizMode', 'bars');

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
