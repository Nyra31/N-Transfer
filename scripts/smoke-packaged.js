// Prueba de humo de la app YA EMPAQUETADA (dist/): que arranque, sirva la web del móvil y reciba un archivo.
// La usa GitHub Actions antes de publicar cada versión. Uso: npm run smoke  [HEIC_SAMPLE=foto.heic]
// En Linux sin pantalla: xvfb-run -a npm run smoke
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const PORT = 47877;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function findExecutable() {
  const candidates = {
    win32: ['win-unpacked/N-Transfer.exe'],
    darwin: ['mac-universal', 'mac-arm64', 'mac'].map((d) => `${d}/N-Transfer.app/Contents/MacOS/N-Transfer`),
    linux: ['linux-unpacked/n-transfer'],
  }[process.platform] || [];
  return candidates.map((c) => path.join(DIST, c)).find((p) => fs.existsSync(p));
}

(async () => {
  const exe = findExecutable();
  if (!exe) {
    console.error('✘ no se encuentra la app empaquetada en dist/ (¿se ha compilado?)');
    process.exit(1);
  }
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-smoke-'));
  const dest = path.join(ud, 'recibido');
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
    port: PORT, destDir: dest, heicMode: 'both', viewMode: 'normal',
    devices: [{ id: crypto.randomUUID(), name: 'Smoke', platform: 'ci', tokenHash: crypto.createHash('sha256').update(token).digest('hex'), pairedAt: Date.now(), lastSeen: Date.now() }],
  }));
  const env = { ...process.env, NT_USER_DATA: ud };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--hidden', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
  const child = spawn(exe, args, { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`;
  const api = (p, o = {}) => fetch(base + p, { ...o, headers: { 'X-Device-Token': token, ...(o.headers || {}) } });
  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? '✔' : '✘'} ${name}${extra ? ' — ' + extra : ''}`);

  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      await wait(500);
      info = await fetch(base + '/api/v1/info').then((r) => (r.ok ? r.json() : null), () => null);
    }
    check(`la app arranca (${path.relative(DIST, exe)})`, !!info, info ? `v${info.version}` : 'sin respuesta en 30 s');
    if (!info) throw new Error('no arrancó');

    for (const p of ['/', '/m/app.js', '/m/mobile.css', '/shared/skins/base.css', '/shared/i18n.js', '/m/icons/apple-touch-icon.png']) {
      const r = await fetch(base + p);
      check(`sirve ${p}`, r.status === 200, String(r.status));
    }

    const body = Buffer.from('N-Transfer smoke ' + Date.now());
    const s = await (await api('/api/v1/uploads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'prueba.txt', size: body.length }),
    })).json();
    const put = await (await api(`/api/v1/uploads/${s.id}?offset=0`, { method: 'PUT', body })).json();
    const saved = path.join(dest, 'prueba.txt');
    check('recibe un archivo', put.done && fs.existsSync(saved) && fs.readFileSync(saved).equals(body));

    const sample = process.env.HEIC_SAMPLE;
    if (sample && fs.existsSync(sample)) {
      const heic = fs.readFileSync(sample);
      const h = await (await api('/api/v1/uploads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'IMG_SMOKE.HEIC', size: heic.length }),
      })).json();
      await api(`/api/v1/uploads/${h.id}?offset=0`, { method: 'PUT', body: heic });
      const jpg = path.join(dest, 'IMG_SMOKE.jpg');
      check('convierte HEIC a JPG (hilo desempaquetado)', fs.existsSync(jpg) && fs.readFileSync(jpg).subarray(0, 2).toString('hex') === 'ffd8');
    }
  } catch (e) {
    results.push('✘ ' + e.message);
  } finally {
    child.kill();
    await wait(1500);
    fs.rmSync(ud, { recursive: true, force: true, maxRetries: 3 });
  }
  for (const r of results) console.log(r);
  process.exit(results.some((r) => r.startsWith('✘')) ? 1 : 0);
})();
