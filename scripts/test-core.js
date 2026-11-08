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

  heic.stop();
  for (const [mark, name] of results) console.log(`${mark} ${name}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(results.some(([m]) => m === '✘') ? 1 : 0);
})();
