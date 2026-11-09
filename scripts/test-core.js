// Pruebas del núcleo (sin Electron). Uso: npm test   [HEIC_SAMPLE=ruta/a/foto.heic para probar la conversión]
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Store } = require('../src/core/store');
const { TransferServer } = require('../src/core/server');
const heic = require('../src/core/heic');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-test-'));
const PORT = 47890 + Math.floor(Math.random() * 8);
const results = [];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function test(name, fn) {
  try {
    await fn();
    results.push(['✔', name]);
  } catch (e) {
    results.push(['✘', name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n    ')]);
  }
}

function makeServer(extra = {}) {
  const store = new Store(path.join(tmp, 'config.json'), {
    port: PORT, destDir: path.join(tmp, 'recv'), lang: 'es', skin: 'winamp', devices: [], outbox: [], history: [], ...extra,
  });
  const root = path.join(__dirname, '..', 'src');
  return new TransferServer({
    store, mobileDir: path.join(root, 'mobile'), sharedDir: path.join(root, 'shared'), thumbsDir: path.join(tmp, 'thumbs'), version: 'test',
  });
}

const base = `http://127.0.0.1:${PORT}`;
let token;
const api = (p, opts = {}) => fetch(base + p, { ...opts, headers: { 'X-Device-Token': token, ...(opts.headers || {}) } });
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Envía `total` bytes declarados pero corta la conexión tras `sendBytes`. */
function putAndDrop(id, offset, data, sendBytes) {
  return new Promise((resolve) => {
    const req = http.request(`${base}/api/v1/uploads/${id}?offset=${offset}`, {
      method: 'PUT', headers: { 'X-Device-Token': token, 'Content-Length': data.length },
    });
    req.on('error', () => resolve());
    req.on('response', (r) => { r.resume(); r.on('end', resolve); });
    req.write(data.subarray(0, sendBytes), () => setTimeout(() => { req.destroy(); resolve(); }, 300));
  });
}

(async () => {
  const server = makeServer();
  await server.start();
  token = server.pairDevice('Test', 'ios').token;
  const file = crypto.randomBytes(3 * 1048576 + 123);
  let id;

  await test('crear subida con miniatura', async () => {
    const thumb = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    const r = await post('/api/v1/uploads', { name: 'VID_0001.MOV', size: file.length, mtime: 1700000000000, type: 'video/quicktime', thumb });
    assert.equal(r.status, 200);
    const j = await r.json();
    id = j.id;
    assert.equal(j.offset, 0);
    assert.ok(fs.existsSync(path.join(tmp, 'thumbs', `${id}.jpg`)));
  });

  await test('corte de red a mitad: se conserva lo recibido', async () => {
    await putAndDrop(id, 0, file, 1048576 + 7);
    await new Promise((r) => setTimeout(r, 300));
    const j = await (await api(`/api/v1/uploads/${id}`)).json();
    assert.ok(j.offset > 0 && j.offset <= 1048576 + 7, 'offset ' + j.offset);
    assert.equal(j.state, 'stalled');
  });

  await test('offset incorrecto → 409 con el offset bueno', async () => {
    const r = await api(`/api/v1/uploads/${id}?offset=5`, { method: 'PUT', body: file.subarray(5) });
    assert.equal(r.status, 409);
    assert.ok((await r.json()).offset > 0);
  });

  await test('volver a elegir el mismo archivo reanuda la misma subida', async () => {
    const j = await (await post('/api/v1/uploads', { name: 'VID_0001.MOV', size: file.length, mtime: 1700000000000 })).json();
    assert.equal(j.id, id);
    assert.ok(j.offset > 0);
  });

  await test('pausa desde el PC → 423; reanudar y terminar; archivo idéntico', async () => {
    server.pauseUpload(id);
    const { offset } = await (await api(`/api/v1/uploads/${id}`)).json();
    let r = await api(`/api/v1/uploads/${id}?offset=${offset}`, { method: 'PUT', body: file.subarray(offset) });
    assert.equal(r.status, 423);
    server.resumeUpload(id);
    r = await api(`/api/v1/uploads/${id}?offset=${offset}`, { method: 'PUT', body: file.subarray(offset) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.done, true);
    const saved = path.join(tmp, 'recv', 'VID_0001.MOV');
    assert.equal(sha(fs.readFileSync(saved)), sha(file));
    assert.equal(fs.statSync(saved).mtimeMs, 1700000000000);
    assert.ok(!fs.existsSync(saved + '.ntpart'));
    assert.equal(server.history()[0].thumb, `${id}.jpg`);
  });

  await test('cancelar desde el PC borra el .ntpart y responde 410', async () => {
    const j = await (await post('/api/v1/uploads', { name: 'big.bin', size: 2000000 })).json();
    await api(`/api/v1/uploads/${j.id}?offset=0`, { method: 'PUT', body: Buffer.alloc(1000) });
    const part = path.join(tmp, 'recv', 'big.bin.ntpart');
    assert.ok(fs.existsSync(part));
    server.cancelUpload(j.id);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!fs.existsSync(part));
    assert.equal((await api(`/api/v1/uploads/${j.id}`)).status, 410);
  });

  await test('carpetas por tipo', async () => {
    server.store.set('splitByType', true);
    for (const [name, sub] of [['a.jpg', 'Fotos'], ['b.mp4', 'Vídeos'], ['c.pdf', 'Otros']]) {
      const j = await (await post('/api/v1/uploads', { name, size: 3 })).json();
      await api(`/api/v1/uploads/${j.id}?offset=0`, { method: 'PUT', body: Buffer.from('abc') });
      assert.ok(fs.existsSync(path.join(tmp, 'recv', sub, name)), `${sub}/${name}`);
    }
    server.store.set('photoDir', path.join(tmp, 'mis-fotos'));
    const j = await (await post('/api/v1/uploads', { name: 'd.png', size: 1 })).json();
    await api(`/api/v1/uploads/${j.id}?offset=0`, { method: 'PUT', body: Buffer.from('x') });
    assert.ok(fs.existsSync(path.join(tmp, 'mis-fotos', 'd.png')));
    server.store.set('splitByType', false);
  });

  await test('texto del móvil al PC', async () => {
    let got = null;
    server.once('text-received', (e) => (got = e));
    const r = await post('/api/v1/text', { text: 'https://example.com\nsegunda línea' });
    assert.equal(r.status, 200);
    assert.equal(got.kind, 'text');
    assert.equal(got.name, 'https://example.com');
  });

  await test('texto del PC al móvil en la bandeja de salida', async () => {
    server.addTextToOutbox('hola móvil');
    const j = await (await api('/api/v1/outbox')).json();
    assert.equal(j.items[0].type, 'text');
    assert.equal(j.items[0].text, 'hola móvil');
  });

  await test('API antigua PUT /api/v1/upload sigue funcionando', async () => {
    const r = await api('/api/v1/upload', { method: 'PUT', headers: { 'X-File-Name': encodeURIComponent('viejo ñ.txt') }, body: Buffer.from('legacy') });
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(path.join(tmp, 'recv', 'viejo ñ.txt'), 'utf8'), 'legacy');
  });

  await test('el móvil recibe las hojas de estilo, incluidas las skins personalizadas', async () => {
    const skinFile = path.join(tmp, 'neon.css');
    fs.writeFileSync(skinFile, '/* @name Neón */ .skin-neon { --lcd-fg: #f0f; }');
    server.customSkins = () => [{ id: 'neon', name: 'Neón', file: skinFile }];
    for (const p of ['/shared/skins/base.css', '/shared/skins/winamp.css', '/m/mobile.css', '/skins/neon.css']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/css/, p);
    }
    assert.equal((await fetch(base + '/skins/nada.css')).status, 404);
    const me = await (await api('/api/v1/me')).json();
    assert.ok(me.skins.some((s) => s.id === 'neon' && s.custom));
  });

  await test('carpeta PC → móvil como ZIP (tamaño exacto y todos los archivos)', async () => {
    const dir = path.join(tmp, 'Vacaciones');
    fs.mkdirSync(path.join(dir, 'día 1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.jpg'), crypto.randomBytes(5000));
    fs.writeFileSync(path.join(dir, 'día 1', 'b.mov'), crypto.randomBytes(7000));
    fs.writeFileSync(path.join(dir, 'Thumbs.db'), 'x');
    await server.addToOutbox([dir]);
    const item = server.outbox().find((o) => o.type === 'folder');
    assert.equal(item.count, 2);
    assert.equal(item.size, 12000);
    const r = await api(`/api/v1/outbox/${item.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.length, Number(r.headers.get('content-length')));
    assert.equal(buf.readUInt32LE(0), 0x04034b50, 'cabecera ZIP');
    const text = buf.toString('utf8');
    assert.ok(text.includes('Vacaciones/a.jpg') && text.includes('Vacaciones/día 1/b.mov'), 'nombres en el ZIP');
    assert.ok(!text.includes('Thumbs.db'));
    server.removeFromOutbox(item.id);
  });

  await test('info/me con id y nombre del PC; nombre del icono', async () => {
    const info = await (await fetch(base + '/api/v1/info')).json();
    assert.match(info.id, /^[0-9a-f-]{36}$/);
    server.store.set('pcName', 'Casa');
    const me = await (await api('/api/v1/me')).json();
    assert.equal(me.pcName, 'Casa');
    assert.equal(me.pcId, info.id);
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('apple-mobile-web-app-title" content="Casa"'));
    const man = await (await fetch(base + '/manifest.webmanifest')).json();
    assert.equal(man.short_name, 'Casa');
    server.store.set('pcName', '');
  });

  await test('otros PCs: lista sin incluirse a sí mismo', async () => {
    server.peers = () => [{ id: server.pcId, name: 'yo' }, { id: 'otro', name: 'Trabajo', ip: '192.168.1.9', port: 47800 }];
    const j = await (await api('/api/v1/peers')).json();
    assert.deepEqual(j.peers.map((x) => x.name), ['Trabajo']);
  });

  await test('segundo PC: emparejar y subir desde otra página (CORS)', async () => {
    const PORT2 = PORT + 20;
    const store2 = new Store(path.join(tmp, 'config2.json'), {
      port: PORT2, destDir: path.join(tmp, 'recv2'), lang: 'es', skin: 'winamp', devices: [], outbox: [], history: [],
    });
    const root = path.join(__dirname, '..', 'src');
    const pc2 = new TransferServer({ store: store2, mobileDir: path.join(root, 'mobile'), sharedDir: path.join(root, 'shared'), thumbsDir: path.join(tmp, 'thumbs2'), version: 'test' });
    await pc2.start();
    const b2 = `http://127.0.0.1:${PORT2}`;
    const origin = { Origin: base };
    const pre = await fetch(b2 + '/api/v1/uploads', { method: 'OPTIONS', headers: { ...origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-device-token,content-type' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Device-Token/i);
    pc2.setPairing(true);
    const pr = await fetch(b2 + '/api/v1/pair', { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pc2.pairCodeDisplay, name: 'iPhone' }) });
    assert.equal(pr.status, 200);
    assert.equal(pr.headers.get('access-control-allow-origin'), '*');
    const tok2 = (await pr.json()).token;
    const h = { ...origin, 'X-Device-Token': tok2, 'Content-Type': 'application/json' };
    const s = await (await fetch(b2 + '/api/v1/uploads', { method: 'POST', headers: h, body: JSON.stringify({ name: 'otro.txt', size: 4 }) })).json();
    const put = await fetch(`${b2}/api/v1/uploads/${s.id}?offset=0`, { method: 'PUT', headers: { ...origin, 'X-Device-Token': tok2 }, body: 'hola' });
    assert.equal(put.status, 200);
    assert.equal(put.headers.get('access-control-allow-origin'), '*');
    assert.equal(fs.readFileSync(path.join(tmp, 'recv2', 'otro.txt'), 'utf8'), 'hola');
    await pc2.stop();
  });

  await test('quitar entradas del historial', async () => {
    const ids = server.history().slice(0, 2).map((h) => h.id);
    const before = server.history().length;
    server.removeHistory(ids);
    assert.equal(server.history().length, before - 2);
    assert.ok(!server.history().some((h) => ids.includes(h.id)));
  });

  await test('registra el contacto desde otro dispositivo de la red', async () => {
    const lanIp = require('../src/core/net').getLanIPs()[0];
    if (lanIp === '127.0.0.1') return; // sin red
    let seen = null;
    server.once('lan-contact', (c) => (seen = c));
    await fetch(`http://${lanIp}:${PORT}/api/v1/info`);
    assert.equal(seen?.ip, lanIp);
  });

  await test('emparejar solo con la ventana «Emparejar» abierta (y caduca)', async () => {
    const tryPair = () => fetch(base + '/api/v1/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.pairCodeDisplay, name: 'X' }),
    });
    server.setPairing(false);
    let r = await tryPair();
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'pairing_closed');
    assert.equal((await (await fetch(base + '/api/v1/info')).json()).pairing, false);
    server.setPairing(true);
    r = await tryPair();
    assert.equal(r.status, 200);
    server.setPairing(true, 50); // caduca a los 50 ms
    await new Promise((res) => setTimeout(res, 80));
    r = await tryPair();
    assert.equal((await r.json()).error, 'pairing_closed');
  });

  await test('sin espacio en disco: avisa al empezar (y al reanudar), sin crear nada', async () => {
    const free = 300 * 1048576; // simula 300 MB libres
    server.freeSpaceOverride = () => free;
    let alert = null;
    server.once('disk-full', (e) => (alert = e));
    let r = await post('/api/v1/uploads', { name: 'enorme.mov', size: 500 * 1048576 });
    assert.equal(r.status, 507);
    assert.equal(alert?.name, 'enorme.mov');
    assert.ok(!fs.existsSync(path.join(tmp, 'recv', 'enorme.mov.ntpart')));
    // Un archivo que sí cabe
    r = await post('/api/v1/uploads', { name: 'cabe.mov', size: 150 * 1048576 });
    assert.equal(r.status, 200);
    const s = await r.json();
    // Al reanudar se vuelve a comprobar lo que falta
    server.freeSpaceOverride = () => 50 * 1048576;
    r = await post('/api/v1/uploads', { name: 'cabe.mov', size: 150 * 1048576 });
    assert.equal(r.status, 507);
    server.freeSpaceOverride = null;
    server.cancelUpload(s.id);
  });

  await test('espacio libre real del disco legible', async () => {
    const free = await server.freeSpace(tmp);
    assert.ok(free === null || free > 0);
  });

  await test('estadísticas', async () => {
    const s = server.stats();
    assert.ok(s.filesIn >= 6, 'filesIn ' + s.filesIn);
    assert.equal(s.videos, 2);
    assert.equal(s.texts, 1);
    assert.ok(s.bytesIn >= file.length);
  });

  const sample = process.env.HEIC_SAMPLE;
  if (sample && fs.existsSync(sample)) {
    const heicBuf = fs.readFileSync(sample);
    for (const mode of ['both', 'jpg']) {
      await test(`HEIC → JPG (modo ${mode})`, async () => {
        server.store.set('heicMode', mode);
        const name = `IMG_${mode}.HEIC`;
        const j = await (await post('/api/v1/uploads', { name, size: heicBuf.length })).json();
        const r = await (await api(`/api/v1/uploads/${j.id}?offset=0`, { method: 'PUT', body: heicBuf })).json();
        assert.equal(r.done, true);
        const jpg = path.join(tmp, 'recv', `IMG_${mode}.jpg`);
        assert.ok(fs.existsSync(jpg), 'falta el JPG');
        assert.deepEqual([...fs.readFileSync(jpg).subarray(0, 2)], [0xff, 0xd8]);
        assert.equal(fs.existsSync(path.join(tmp, 'recv', name)), mode === 'both');
        assert.equal(server.history()[0].name, mode === 'jpg' ? `IMG_${mode}.jpg` : name);
      });
    }
  } else {
    results.push(['-', 'HEIC → JPG (sin HEIC_SAMPLE, omitida)']);
  }

  await test('subida a medias se recupera al reiniciar el servidor', async () => {
    const j = await (await post('/api/v1/uploads', { name: 'reinicio.bin', size: 10 })).json();
    await api(`/api/v1/uploads/${j.id}?offset=0`, { method: 'PUT', body: Buffer.from('12345') });
    await server.stop();
    server.store.flush();
    const again = makeServer();
    await again.start();
    const st = await (await api(`/api/v1/uploads/${j.id}`)).json();
    assert.equal(st.offset, 5);
    const done = await (await api(`/api/v1/uploads/${j.id}?offset=5`, { method: 'PUT', body: Buffer.from('67890') })).json();
    assert.equal(done.done, true);
    assert.equal(fs.readFileSync(path.join(tmp, 'recv', 'reinicio.bin'), 'utf8'), '1234567890');
    await again.stop();
  });

  if (process.env.CI) results.push(['-', 'mDNS (omitida en CI: los servidores de GitHub no siempre permiten multicast)']);
  else await test('mDNS: un PC descubre a otro N-Transfer en la red', async () => {
    const { spawn } = require('child_process');
    const otherId = crypto.randomUUID();
    const child = spawn(process.execPath, ['-e', `
      const m = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'core', 'mdns.js'))});
      m.advertise({ id: '${otherId}', name: 'PC-Prueba', port: 47999, version: 't' });
      setTimeout(() => { m.stop(); process.exit(0); }, 8000);`], { stdio: 'ignore' });
    const mdns = require('../src/core/mdns');
    mdns.advertise({ id: 'self', name: 'Yo', port: 47998, version: 't' });
    let found = null;
    mdns.browse('self', (list) => (found = list.find((p) => p.id === otherId) || found));
    for (let i = 0; i < 30 && !found; i++) await new Promise((r) => setTimeout(r, 200));
    mdns.stop();
    child.kill();
    assert.ok(found, 'no se encontró el otro PC');
    assert.equal(found.name, 'PC-Prueba');
    assert.equal(found.port, 47999);
  });

  heic.stop();
  for (const [mark, name] of results) console.log(`${mark} ${name}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(results.some(([m]) => m === '✘') ? 1 : 0);
})();
