'use strict';
/**
 * Servidor de N-Transfer. No depende de Electron: puede ejecutarse en Windows, macOS y Linux.
 *
 * API v1 (estable, la usarán también las futuras apps nativas de iOS/Android):
 *   GET  /api/v1/info                 público, CORS: datos del PC
 *   POST /api/v1/pair   {code,name,platform} → {token, deviceId}
 *   GET  /api/v1/me                   (auth) dispositivo + skin/idioma del PC
 *   PUT  /api/v1/upload               (auth) cuerpo = bytes del archivo;
 *                                     cabeceras X-File-Name (URI-encoded), X-File-Mtime (ms)
 *   GET  /api/v1/outbox               (auth) archivos que el PC ofrece al móvil
 *   GET  /api/v1/outbox/:id           (auth) descarga (admite Range)
 *   GET  /api/v1/events               (auth) Server-Sent Events: outbox, settings, unpaired
 * Autenticación: cabecera X-Device-Token o parámetro ?d=<token>.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { EventEmitter } = require('events');
const { getLanIPs, getMdnsHost } = require('./net');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.heic': 'image/heic', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_HISTORY = 300;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_PAIR_FAILURES = 10;
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Token, X-File-Name, X-File-Mtime');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
}

async function readJson(req, limit = 16 * 1024) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw new Error('body_too_large');
  }
  try {
    return JSON.parse(data || '{}');
  } catch {
    return null;
  }
}

/** Nombre de archivo seguro en Windows, macOS y Linux. */
function sanitizeName(raw) {
  let name = path.basename(String(raw || '').replace(/\\/g, '/'));
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!name) name = 'archivo';
  const ext = path.extname(name);
  let stem = name.slice(0, name.length - ext.length);
  if (WIN_RESERVED.test(stem)) stem = '_' + stem;
  return (stem.slice(0, 180) || 'archivo') + ext.slice(0, 20);
}

function publicDevice(d) {
  return { id: d.id, name: d.name, platform: d.platform, pairedAt: d.pairedAt, lastSeen: d.lastSeen };
}

class TransferServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./store').Store} o.store  claves: port, destDir, skin, lang, devices, outbox, history
   * @param {string} o.mobileDir  carpeta con la web app del móvil
   * @param {string} o.sharedDir  carpeta con skins e idiomas compartidos
   * @param {string} o.version
   */
  constructor({ store, mobileDir, sharedDir, version }) {
    super();
    this.store = store;
    this.mobileDir = mobileDir;
    this.sharedDir = sharedDir;
    this.version = version;
    this.port = store.get('port');
    this.clients = new Set();
    this.reserved = new Set();
    this.http = null;
    this.newPairCode();
  }

  // ───────────── estado público ─────────────
  get ip() {
    return getLanIPs()[0];
  }
  get mdnsHost() {
    return getMdnsHost();
  }
  pairUrl() {
    return `http://${this.ip}:${this.port}/pair?c=${this.pairCode}`;
  }
  /** Código de 8 caracteres sin ambigüedades (sin 0/O, 1/I/L), fácil de escribir a mano. */
  newPairCode() {
    const bytes = crypto.randomBytes(8);
    this.pairCode = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    this.pairFailures = 0;
    this.emit('pair-code', this.pairCode);
    return this.pairCode;
  }
  /** El código tal y como se muestra: K7QM-2XPA */
  get pairCodeDisplay() {
    return this.pairCode.slice(0, 4) + '-' + this.pairCode.slice(4);
  }
  devices() {
    return (this.store.get('devices') || []).map(publicDevice);
  }
  outbox() {
    return (this.store.get('outbox') || []).map(({ id, name, size, addedAt }) => ({ id, name, size, addedAt }));
  }
  history() {
    return this.store.get('history') || [];
  }

  // ───────────── ciclo de vida ─────────────
  start() {
    return new Promise((resolve, reject) => {
      this.http = http.createServer((req, res) => {
        this.handle(req, res).catch((e) => {
          if (!res.headersSent) json(res, 500, { error: e.message });
          else res.destroy();
        });
      });
      this.http.once('error', reject);
      this.http.listen(this.port, '0.0.0.0', () => {
        this.http.removeListener('error', reject);
        this.keepAlive = setInterval(() => this.broadcast('ping', {}), 25000);
        resolve();
      });
    });
  }

  stop() {
    clearInterval(this.keepAlive);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    return new Promise((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  // ───────────── dispositivos ─────────────
  /** Empareja un dispositivo y devuelve su token (solo se guarda el hash). */
  pairDevice(name, platform = '') {
    const token = crypto.randomBytes(24).toString('base64url');
    const dev = {
      id: crypto.randomUUID(),
      name: String(name || 'Dispositivo').trim().slice(0, 60) || 'Dispositivo',
      platform: String(platform).slice(0, 20),
      tokenHash: sha(token),
      pairedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.store.set('devices', [...(this.store.get('devices') || []), dev]);
    this.emit('device-paired', publicDevice(dev));
    this.emit('devices-changed', this.devices());
    return { token, device: dev };
  }

  forgetDevice(id) {
    this.store.set('devices', (this.store.get('devices') || []).filter((d) => d.id !== id));
    for (const c of this.clients) {
      if (c.deviceId === id) {
        this.sendEvent(c, 'unpaired', {});
        c.res.end();
      }
    }
    this.emit('devices-changed', this.devices());
  }

  authenticate(req, url) {
    const token = req.headers['x-device-token'] || url.searchParams.get('d');
    if (!token || !TOKEN_RE.test(token)) return null;
    const hash = sha(token);
    const dev = (this.store.get('devices') || []).find((d) => d.tokenHash === hash);
    if (dev) {
      dev.lastSeen = Date.now();
      this.store.save();
    }
    return dev || null;
  }

  // ───────────── PC → móvil ─────────────
  async addToOutbox(paths) {
    const items = [...(this.store.get('outbox') || [])];
    for (const p of paths) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isFile()) continue;
      if (items.some((i) => i.path === p)) continue;
      items.unshift({ id: crypto.randomUUID(), path: p, name: path.basename(p), size: st.size, addedAt: Date.now() });
    }
    this.store.set('outbox', items);
    this.outboxChanged();
  }

  removeFromOutbox(id) {
    this.store.set('outbox', (this.store.get('outbox') || []).filter((i) => i.id !== id));
    this.outboxChanged();
  }

  clearOutbox() {
    this.store.set('outbox', []);
    this.outboxChanged();
  }

  outboxChanged() {
    const items = this.outbox();
    this.emit('outbox-changed', items);
    this.broadcast('outbox', { items });
  }

  settingsChanged() {
    this.broadcast('settings', { skin: this.store.get('skin'), lang: this.store.get('lang') });
  }

  clearHistory() {
    this.store.set('history', []);
    this.emit('history-changed', []);
  }

  addHistory(entry) {
    const h = [entry, ...(this.store.get('history') || [])].slice(0, MAX_HISTORY);
    this.store.set('history', h);
  }

  // ───────────── Server-Sent Events ─────────────
  sendEvent(client, event, data) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event, data) {
    for (const c of this.clients) this.sendEvent(c, event, data);
  }

  // ───────────── enrutado ─────────────
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      return res.end();
    }

    if (p === '/api/v1/info') {
      cors(res);
      return json(res, 200, {
        app: 'N-Transfer', api: 1, version: this.version, name: os.hostname(), host: this.mdnsHost, port: this.port,
      });
    }

    if (p === '/api/v1/pair' && req.method === 'POST') {
      cors(res);
      const body = await readJson(req);
      if (!body || normalizeCode(body.code) !== this.pairCode) {
        // Contra fuerza bruta: tras varios intentos fallidos el código se renueva.
        if (++this.pairFailures >= MAX_PAIR_FAILURES) this.newPairCode();
        return json(res, 403, { error: 'bad_code' });
      }
      const { token, device } = this.pairDevice(body.name, body.platform);
      this.newPairCode(); // cada código QR sirve para un solo dispositivo
      return json(res, 200, { token, deviceId: device.id });
    }

    if (p.startsWith('/api/')) {
      cors(res);
      const dev = this.authenticate(req, url);
      if (!dev) return json(res, 401, { error: 'unauthorized' });

      if (p === '/api/v1/me') {
        return json(res, 200, {
          device: publicDevice(dev), pcName: os.hostname(), host: this.mdnsHost, port: this.port,
          skin: this.store.get('skin'), lang: this.store.get('lang'), version: this.version,
        });
      }
      if (p === '/api/v1/upload' && req.method === 'PUT') return this.receive(req, res, dev);
      if (p === '/api/v1/outbox' && req.method === 'GET') return json(res, 200, { items: this.outbox() });
      const m = p.match(/^\/api\/v1\/outbox\/([0-9a-f-]{36})$/);
      if (m && req.method === 'GET') return this.sendOutboxFile(req, res, dev, m[1]);
      if (p === '/api/v1/events') return this.openEvents(req, res, dev);
      return json(res, 404, { error: 'not_found' });
    }

    if (p === '/manifest.webmanifest') return this.manifest(res, url.searchParams.get('d'));
    if (p === '/' || p === '/pair' || p === '/index.html') return this.serveIndex(res, url.searchParams.get('d'));
    if (p.startsWith('/m/')) return this.serveStatic(res, this.mobileDir, p.slice(3));
    if (p.startsWith('/shared/')) return this.serveStatic(res, this.sharedDir, p.slice(8));
    if (p === '/favicon.ico') return this.serveStatic(res, this.mobileDir, 'icons/icon-192.png');
    return json(res, 404, { error: 'not_found' });
  }

  async serveStatic(res, root, rel) {
    const file = path.resolve(root, decodeURIComponent(rel));
    if (!file.startsWith(path.resolve(root) + path.sep)) return json(res, 403, { error: 'forbidden' });
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) return json(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  /**
   * La página del móvil, con el enlace al manifest ya escrito en el HTML. Safari lee el manifest al
   * cargar y no vuelve a leerlo si se cambia con JavaScript; por eso el token tiene que estar desde el principio.
   */
  async serveIndex(res, token) {
    let html = await fsp.readFile(path.join(this.mobileDir, 'index.html'), 'utf8');
    if (token && TOKEN_RE.test(token)) {
      html = html.replace('href="/manifest.webmanifest"', `href="/manifest.webmanifest?d=${token}"`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  /** Manifest por dispositivo: start_url lleva el token, así el icono de inicio funciona siempre. */
  manifest(res, token) {
    const start = token && TOKEN_RE.test(token) ? `/?d=${token}` : '/';
    json(res, 200, {
      name: 'N-Transfer', short_name: 'N-Transfer', start_url: start, scope: '/', display: 'standalone',
      background_color: '#1b1b24', theme_color: '#1b1b24',
      icons: [
        { src: '/m/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/m/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    }, { 'Content-Type': 'application/manifest+json' });
  }

  openEvents(req, res, dev) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { res, deviceId: dev.id };
    this.clients.add(client);
    this.sendEvent(client, 'outbox', { items: this.outbox() });
    req.on('close', () => this.clients.delete(client));
  }

  async uniqueName(dir, name) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? name : `${stem} (${i})${ext}`;
      const key = path.join(dir, candidate).toLowerCase();
      if (this.reserved.has(key)) continue;
      const exists = await fsp.access(path.join(dir, candidate)).then(() => true, () => false);
      if (!exists) {
        this.reserved.add(key);
        return candidate;
      }
    }
  }

  /** Móvil → PC: el cuerpo de la petición se escribe directamente en disco. */
  async receive(req, res, dev) {
    let rawName = '';
    try {
      rawName = decodeURIComponent(req.headers['x-file-name'] || '');
    } catch {
      rawName = String(req.headers['x-file-name'] || '');
    }
    const size = Number(req.headers['content-length']) || 0;
    const mtime = Number(req.headers['x-file-mtime']) || 0;
    const dir = this.store.get('destDir');
    await fsp.mkdir(dir, { recursive: true });
    const name = await this.uniqueName(dir, sanitizeName(rawName));
    const finalPath = path.join(dir, name);
    const partPath = finalPath + '.ntpart';
    const t = { id: crypto.randomUUID(), direction: 'in', name, size, received: 0, device: dev.name, startedAt: Date.now() };
    this.emit('transfer-start', { ...t });

    let lastEmit = 0;
    req.on('data', (chunk) => {
      t.received += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 120) {
        lastEmit = now;
        this.emit('transfer-progress', { id: t.id, received: t.received, size });
      }
    });

    try {
      await pipeline(req, fs.createWriteStream(partPath));
      if (size && t.received !== size) throw new Error('incomplete');
      await fsp.rename(partPath, finalPath);
      if (mtime > 0 && mtime < Date.now() + 86400000) {
        await fsp.utimes(finalPath, new Date(), new Date(mtime)).catch(() => {});
      }
      const entry = { id: t.id, direction: 'in', name, path: finalPath, size: t.received, device: dev.name, at: Date.now() };
      this.addHistory(entry);
      this.emit('transfer-done', entry);
      json(res, 200, { name, size: t.received });
    } catch (e) {
      await fsp.unlink(partPath).catch(() => {});
      this.emit('transfer-error', { id: t.id, error: e.message });
      if (!res.headersSent && !res.destroyed) json(res, 500, { error: e.message });
    } finally {
      this.reserved.delete(finalPath.toLowerCase());
    }
  }

  /** PC → móvil. Admite Range para que el móvil pueda reproducir vídeos. */
  async sendOutboxFile(req, res, dev, id) {
    const item = (this.store.get('outbox') || []).find((i) => i.id === id);
    const st = item && (await fsp.stat(item.path).catch(() => null));
    if (!st) return json(res, 404, { error: 'not_found' });

    const headers = {
      'Content-Type': mimeOf(item.path),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      'Cache-Control': 'no-store',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return pipeline(fs.createReadStream(item.path, { start, end }), res).catch(() => {});
    }

    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    const t = { id: crypto.randomUUID(), direction: 'out', name: item.name, size: st.size, received: 0, device: dev.name, startedAt: Date.now() };
    this.emit('transfer-start', { ...t });
    const stream = fs.createReadStream(item.path);
    let lastEmit = 0;
    stream.on('data', (chunk) => {
      t.received += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 120) {
        lastEmit = now;
        this.emit('transfer-progress', { id: t.id, received: t.received, size: st.size });
      }
    });
    try {
      await pipeline(stream, res);
      const entry = { id: t.id, direction: 'out', name: item.name, path: item.path, size: st.size, device: dev.name, at: Date.now() };
      this.addHistory(entry);
      this.emit('transfer-done', entry);
    } catch (e) {
      this.emit('transfer-error', { id: t.id, error: e.message });
    }
  }
}

module.exports = { TransferServer, sanitizeName };
