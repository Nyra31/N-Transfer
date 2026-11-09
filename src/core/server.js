'use strict';
/**
 * Servidor de N-Transfer. No depende de Electron: puede ejecutarse en Windows, macOS y Linux.
 *
 * API v1 (estable, la usarán también las futuras apps nativas de iOS/Android):
 *   GET    /api/v1/info                     público, CORS: datos del PC
 *   POST   /api/v1/pair     {code,name,platform} → {token, deviceId}
 *   GET    /api/v1/me                       dispositivo, skin, idioma y skins disponibles
 *
 *   Subidas reanudables (móvil → PC):
 *   POST   /api/v1/uploads  {name,size,mtime,type,thumb?} → {id, offset, name}
 *          Si ya existe una subida a medias del mismo archivo (nombre+tamaño+fecha), se reanuda.
 *   PUT    /api/v1/uploads/:id?offset=N     cuerpo = bytes desde N → {done, offset}
 *          409 {offset} si N no coincide · 423 si el PC la ha pausado · 410 si se canceló
 *   GET    /api/v1/uploads/:id              → {offset, size, state}
 *   POST   /api/v1/uploads/:id/state {state: paused|active}
 *   DELETE /api/v1/uploads/:id              cancelar
 *   PUT    /api/v1/upload                   subida simple de una vez (cabeceras X-File-Name, X-File-Mtime)
 *
 *   POST   /api/v1/text     {text}          enviar texto o un enlace al PC
 *   GET    /api/v1/outbox                   lo que el PC ofrece: archivos y textos
 *   GET    /api/v1/outbox/:id               descarga (admite Range)
 *   GET    /api/v1/outbox/:id/thumb         miniatura JPG
 *   GET    /api/v1/events                   SSE: outbox, settings, control {id, action}, unpaired
 * Autenticación: cabecera X-Device-Token o parámetro ?d=<token>.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { once, EventEmitter } = require('events');
const { pipeline } = require('stream/promises');
const { getLanIPs, getMdnsHost } = require('./net');
const { kindOf, isHeic } = require('./kinds');
const { convertHeic } = require('./heic');
const { folderInfo, zipFolder } = require('./folders');

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
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_HISTORY = 300;
const MAX_TEXT = 64 * 1024;
const MAX_THUMB = 300 * 1024;
const STALE_UPLOAD_MS = 48 * 3600 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_PAIR_FAILURES = 10;
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const TYPE_FOLDERS = { es: { photo: 'Fotos', video: 'Vídeos', other: 'Otros' }, en: { photo: 'Photos', video: 'Videos', other: 'Other' } };

function json(res, status, body, extra = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Token, X-File-Name, X-File-Mtime');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
}

async function readJson(req, limit = 16 * 1024) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw Object.assign(new Error('body_too_large'), { status: 413 });
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

function emptyStats() {
  return {
    since: Date.now(), bytesIn: 0, bytesOut: 0, filesIn: 0, filesOut: 0,
    photos: 0, videos: 0, others: 0, texts: 0, maxSpeed: 0,
  };
}

class TransferServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./store').Store} o.store
   * @param {string} o.mobileDir   web app del móvil
   * @param {string} o.sharedDir   skins e idiomas compartidos
   * @param {string} o.thumbsDir   miniaturas (JPG) de lo transferido
   * @param {string} o.version
   * @param {() => {id:string,name:string,file:string}[]} [o.customSkins]
   * @param {(file:string, out:string) => Promise<boolean>} [o.thumbnailer]  miniaturas de archivos del PC
   * @param {() => object[]} [o.peers]  otros PCs con N-Transfer en la red (mDNS)
   */
  constructor({ store, mobileDir, sharedDir, thumbsDir, version, customSkins, thumbnailer, peers }) {
    super();
    this.store = store;
    this.mobileDir = mobileDir;
    this.sharedDir = sharedDir;
    this.thumbsDir = thumbsDir;
    this.version = version;
    this.customSkins = customSkins || (() => []);
    this.thumbnailer = thumbnailer || null;
    this.peers = peers || (() => []);
    if (!store.get('pcId')) store.set('pcId', crypto.randomUUID());
    this.lastContact = null; // última petición desde otro dispositivo de la red (para el asistente «No conecta»)
    this.port = store.get('port');
    this.clients = new Set();
    this.reserved = new Set();
    this.sessions = new Map(); // subidas en curso o a medias
    this.uploadReqs = new Map(); // id → petición HTTP activa
    this.downloads = new Map(); // id → respuesta HTTP activa (PC → móvil)
    this.http = null;
    if (!store.get('stats')) store.set('stats', emptyStats());
    fs.mkdirSync(thumbsDir, { recursive: true });
    this.newPairCode();
  }

  // ───────────── estado público ─────────────
  get ip() {
    const ips = getLanIPs();
    const preferred = this.store.get('preferredIp');
    return preferred && ips.includes(preferred) ? preferred : ips[0];
  }
  get pcId() {
    return this.store.get('pcId');
  }
  /** Nombre visible del PC: el que elija el usuario o el del equipo. */
  get pcLabel() {
    return (this.store.get('pcName') || '').trim() || os.hostname();
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
    return (this.store.get('outbox') || []).map((i) => {
      if (i.type === 'text') return { id: i.id, type: 'text', text: i.text, addedAt: i.addedAt };
      if (i.type === 'folder') return { id: i.id, type: 'folder', name: i.name, size: i.size, count: i.count, addedAt: i.addedAt };
      return { id: i.id, type: 'file', name: i.name, size: i.size, kind: i.kind, thumb: i.thumb || null, addedAt: i.addedAt };
    });
  }
  history() {
    return this.store.get('history') || [];
  }
  stats() {
    return this.store.get('stats');
  }
  /** Transferencias en curso, para la interfaz del PC. */
  activeTransfers() {
    return [...this.sessions.values()].map((s) => this.sessionInfo(s));
  }
  sessionInfo(s) {
    return {
      id: s.id, direction: 'in', name: s.name, size: s.size, received: s.received, device: s.device,
      kind: s.kind, thumb: s.thumb, state: s.state, startedAt: s.startedAt,
    };
  }
  thumbPath(name) {
    return name ? path.join(this.thumbsDir, path.basename(name)) : null;
  }
  skinsList() {
    const builtIn = ['winamp', 'chrome', 'luna'].map((id) => ({ id, custom: false }));
    return [...builtIn, ...this.customSkins().map(({ id, name }) => ({ id, name, custom: true }))];
  }

  /** Carpeta de destino según el tipo (si está activado «Carpetas por tipo»). */
  dirFor(kind) {
    const base = this.store.get('destDir');
    if (!this.store.get('splitByType')) return base;
    const custom = this.store.get(kind + 'Dir');
    if (custom) return custom;
    const names = TYPE_FOLDERS[this.store.get('lang')] || TYPE_FOLDERS.en;
    return path.join(base, names[kind]);
  }
  defaultTypeDir(kind) {
    const names = TYPE_FOLDERS[this.store.get('lang')] || TYPE_FOLDERS.en;
    return path.join(this.store.get('destDir'), names[kind]);
  }

  // ───────────── ciclo de vida ─────────────
  async start() {
    await this.restoreSessions();
    await new Promise((resolve, reject) => {
      this.http = http.createServer((req, res) => {
        this.handle(req, res).catch((e) => {
          if (!res.headersSent) json(res, e.status || 500, { error: e.message });
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
    this.persistSessions();
    return new Promise((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  /** Recupera las subidas a medias de la última vez (el tamaño real del .ntpart manda). */
  async restoreSessions() {
    for (const s of this.store.get('uploads') || []) {
      const st = await fsp.stat(s.partPath).catch(() => null);
      if (!st || Date.now() - (s.updatedAt || 0) > STALE_UPLOAD_MS) {
        await fsp.unlink(s.partPath).catch(() => {});
        continue;
      }
      s.received = Math.min(st.size, s.size);
      if (s.state !== 'paused') s.state = 'stalled';
      this.sessions.set(s.id, s);
      this.reserved.add(s.finalPath.toLowerCase());
    }
    this.persistSessions();
  }

  persistSessions() {
    this.store.set('uploads', [...this.sessions.values()]);
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
    for (const s of [...this.sessions.values()]) if (s.deviceId === id) this.cancelUpload(s.id);
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
    const added = [];
    for (const p of paths) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st || items.some((i) => i.path === p)) continue;
      if (st.isDirectory()) {
        // Carpetas: el móvil las descarga como ZIP
        const { count, size } = await folderInfo(p);
        if (!count) continue;
        const item = { id: crypto.randomUUID(), type: 'folder', path: p, name: path.basename(p) || p, size, count, addedAt: Date.now() };
        items.unshift(item);
        continue;
      }
      if (!st.isFile()) continue;
      const item = { id: crypto.randomUUID(), type: 'file', path: p, name: path.basename(p), size: st.size, kind: kindOf(p), addedAt: Date.now() };
      items.unshift(item);
      added.push(item);
    }
    this.store.set('outbox', items);
    this.outboxChanged();
    // Miniaturas en segundo plano: la lista aparece al momento y las imágenes después.
    if (this.thumbnailer) {
      for (const item of added.filter((i) => i.kind !== 'other')) {
        const name = `o-${item.id}.jpg`;
        const ok = await this.thumbnailer(item.path, this.thumbPath(name)).catch(() => false);
        if (ok) {
          item.thumb = name;
          this.store.save();
          this.outboxChanged();
        }
      }
    }
  }

  addTextToOutbox(text) {
    text = String(text || '').slice(0, MAX_TEXT);
    if (!text.trim()) return;
    const items = [{ id: crypto.randomUUID(), type: 'text', text, addedAt: Date.now() }, ...(this.store.get('outbox') || [])];
    this.store.set('outbox', items);
    this.outboxChanged();
  }

  removeFromOutbox(id) {
    const items = this.store.get('outbox') || [];
    const item = items.find((i) => i.id === id);
    if (item?.thumb && !this.history().some((h) => h.thumb === item.thumb)) fsp.unlink(this.thumbPath(item.thumb)).catch(() => {});
    this.store.set('outbox', items.filter((i) => i.id !== id));
    this.outboxChanged();
  }

  clearOutbox() {
    for (const i of [...(this.store.get('outbox') || [])]) this.removeFromOutbox(i.id);
  }

  outboxChanged() {
    const items = this.outbox();
    this.emit('outbox-changed', items);
    this.broadcast('outbox', { items });
  }

  settingsChanged() {
    this.broadcast('settings', { skin: this.store.get('skin'), lang: this.store.get('lang'), skins: this.skinsList() });
  }

  clearHistory() {
    const keep = new Set((this.store.get('outbox') || []).map((i) => i.thumb).filter(Boolean));
    for (const h of this.history()) if (h.thumb && !keep.has(h.thumb)) fsp.unlink(this.thumbPath(h.thumb)).catch(() => {});
    this.store.set('history', []);
    this.emit('history-changed', []);
  }

  /** Quita entradas del historial (los archivos no se tocan). */
  removeHistory(ids) {
    const drop = new Set(ids);
    const keepThumbs = new Set((this.store.get('outbox') || []).map((i) => i.thumb).filter(Boolean));
    const history = this.history();
    for (const h of history) {
      if (drop.has(h.id) && h.thumb && !keepThumbs.has(h.thumb)) fsp.unlink(this.thumbPath(h.thumb)).catch(() => {});
    }
    const rest = history.filter((h) => !drop.has(h.id));
    this.store.set('history', rest);
    this.emit('history-changed', rest);
  }

  addHistory(entry) {
    const all = [entry, ...(this.store.get('history') || [])];
    for (const old of all.slice(MAX_HISTORY)) {
      if (old.thumb) fsp.unlink(this.thumbPath(old.thumb)).catch(() => {});
    }
    this.store.set('history', all.slice(0, MAX_HISTORY));
  }

  resetStats() {
    this.store.set('stats', emptyStats());
    this.emit('stats-changed', this.stats());
  }

  bumpStats(entry, ms) {
    const s = this.store.get('stats') || emptyStats();
    if (entry.kind === 'text') s.texts++;
    else {
      if (entry.direction === 'in') { s.bytesIn += entry.size; s.filesIn++; } else { s.bytesOut += entry.size; s.filesOut++; }
      if (entry.kind === 'photo') s.photos++;
      else if (entry.kind === 'video') s.videos++;
      else s.others++;
      // Solo cuenta para el récord si el archivo es lo bastante grande como para medir bien.
      if (entry.size >= 4 * 1048576 && ms > 0) s.maxSpeed = Math.max(s.maxSpeed, Math.round(entry.size / (ms / 1000)));
    }
    this.store.set('stats', s);
    this.emit('stats-changed', s);
  }

  // ───────────── Server-Sent Events ─────────────
  sendEvent(client, event, data) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  broadcast(event, data) {
    for (const c of this.clients) this.sendEvent(c, event, data);
  }
  sendTo(deviceId, event, data) {
    for (const c of this.clients) if (c.deviceId === deviceId) this.sendEvent(c, event, data);
  }

  // ───────────── enrutado ─────────────
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    let m;
    this.noteContact(req, p);

    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      return res.end();
    }

    if (p === '/api/v1/info') {
      cors(res);
      return json(res, 200, {
        app: 'N-Transfer', api: 1, version: this.version, id: this.pcId, name: this.pcLabel, host: this.mdnsHost, port: this.port,
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
      this.newPairCode(); // cada código sirve para un solo dispositivo
      return json(res, 200, { token, deviceId: device.id });
    }

    if (p.startsWith('/api/')) {
      cors(res);
      const dev = this.authenticate(req, url);
      if (!dev) return json(res, 401, { error: 'unauthorized' });

      if (p === '/api/v1/me') {
        return json(res, 200, {
          device: publicDevice(dev), pcId: this.pcId, pcName: this.pcLabel, host: this.mdnsHost, port: this.port,
          skin: this.store.get('skin'), lang: this.store.get('lang'), version: this.version, skins: this.skinsList(),
        });
      }
      if (p === '/api/v1/peers') {
        return json(res, 200, { peers: this.peers().filter((x) => x.id !== this.pcId) });
      }
      if (p === '/api/v1/uploads' && req.method === 'POST') return this.createUpload(req, res, dev);
      if ((m = p.match(new RegExp(`^/api/v1/uploads/(${UUID})$`)))) {
        if (req.method === 'PUT') return this.putUpload(req, res, dev, m[1], Number(url.searchParams.get('offset') || 0));
        if (req.method === 'GET') return this.getUpload(res, dev, m[1]);
        if (req.method === 'DELETE') {
          const s = this.sessions.get(m[1]);
          if (s && s.deviceId === dev.id) this.cancelUpload(s.id, { notify: false });
          return json(res, 200, { ok: true });
        }
      }
      if ((m = p.match(new RegExp(`^/api/v1/uploads/(${UUID})/state$`))) && req.method === 'POST') {
        const s = this.sessions.get(m[1]);
        if (!s || s.deviceId !== dev.id) return json(res, 410, { error: 'gone' });
        const body = await readJson(req);
        if (body?.state === 'paused') this.setUploadState(s, 'paused');
        else if (body?.state === 'active' && s.state === 'paused') this.setUploadState(s, 'stalled');
        return json(res, 200, { state: s.state });
      }
      if (p === '/api/v1/upload' && req.method === 'PUT') return this.simpleUpload(req, res, dev);
      if (p === '/api/v1/text' && req.method === 'POST') return this.receiveText(req, res, dev);
      if (p === '/api/v1/outbox' && req.method === 'GET') return json(res, 200, { items: this.outbox() });
      if ((m = p.match(new RegExp(`^/api/v1/outbox/(${UUID})$`))) && req.method === 'GET') {
        return this.sendOutboxFile(req, res, dev, m[1]);
      }
      if ((m = p.match(new RegExp(`^/api/v1/outbox/(${UUID})/thumb$`))) && req.method === 'GET') {
        const item = (this.store.get('outbox') || []).find((i) => i.id === m[1]);
        if (!item?.thumb) return json(res, 404, { error: 'not_found' });
        return this.serveStatic(res, this.thumbsDir, item.thumb);
      }
      if (p === '/api/v1/events') return this.openEvents(req, res, dev);
      return json(res, 404, { error: 'not_found' });
    }

    if (p === '/manifest.webmanifest') return this.manifest(res, url.searchParams.get('d'));
    if (p === '/' || p === '/pair' || p === '/index.html') return this.serveIndex(res, url.searchParams.get('d'));
    if (p.startsWith('/m/')) return this.serveStatic(res, this.mobileDir, p.slice(3));
    if (p.startsWith('/shared/')) return this.serveStatic(res, this.sharedDir, p.slice(8));
    if ((m = p.match(/^\/skins\/([a-z0-9-]+)\.css$/))) {
      const skin = this.customSkins().find((s) => s.id === m[1]);
      if (!skin) return json(res, 404, { error: 'not_found' });
      return this.serveStatic(res, path.dirname(skin.file), path.basename(skin.file));
    }
    if (p === '/favicon.ico') return this.serveStatic(res, this.mobileDir, 'icons/icon-192.png');
    return json(res, 404, { error: 'not_found' });
  }

  /** Recuerda la última petición llegada desde otro dispositivo (si llega, la red y el firewall están bien). */
  noteContact(req, p) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!ip || ip === '127.0.0.1' || ip === '::1') return;
    const now = Date.now();
    const throttled = this.lastContact && now - this.lastContact.at < 1000 && this.lastContact.ip === ip;
    this.lastContact = { ip, at: now, path: p };
    if (!throttled) this.emit('lan-contact', this.lastContact);
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
    // Nombre bajo el icono de la pantalla de inicio: útil si tienes un icono por PC.
    const title = this.iconTitle().replace(/[<>"&]/g, '');
    html = html.replace('content="N-Transfer">', `content="${title}">`);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      // http: hace falta para hablar con otros PCs de la red (varios PCs). Las skins personalizadas son CSS:
      // no pueden ejecutar código, y los scripts solo vienen de este PC.
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' http:; img-src 'self' data: blob: http:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    });
    res.end(html);
  }

  /** «N-Transfer» salvo que el usuario haya puesto nombre al PC. */
  iconTitle() {
    return ((this.store.get('pcName') || '').trim() || 'N-Transfer').slice(0, 24);
  }

  /** Manifest por dispositivo: start_url lleva el token, así el icono de inicio funciona siempre. */
  manifest(res, token) {
    const start = token && TOKEN_RE.test(token) ? `/?d=${token}` : '/';
    json(res, 200, {
      name: `N-Transfer (${this.pcLabel})`, short_name: this.iconTitle(), start_url: start, scope: '/', display: 'standalone',
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

  // ───────────── móvil → PC: subidas reanudables ─────────────
  async createUpload(req, res, dev) {
    const body = await readJson(req, MAX_THUMB + 4096);
    const size = Number(body?.size);
    if (!body || !Number.isSafeInteger(size) || size < 0) return json(res, 400, { error: 'bad_request' });
    const s = await this.openSession(dev, {
      name: body.name, size, mtime: Number(body.mtime) || 0, type: String(body.type || ''), thumb: body.thumb,
    });
    return json(res, 200, { id: s.id, offset: s.received, name: s.name });
  }

  async openSession(dev, { name, size, mtime, type, thumb }) {
    const clean = sanitizeName(name);
    const fp = `${clean}|${size}|${mtime}`;
    // ¿El mismo archivo ya estaba a medias? Se reanuda en vez de empezar de cero.
    const existing = [...this.sessions.values()].find((x) => x.deviceId === dev.id && x.fp === fp);
    if (existing) {
      if (existing.state !== 'paused') this.setUploadState(existing, 'stalled');
      return existing;
    }
    const kind = kindOf(clean, type);
    const dir = this.dirFor(kind);
    await fsp.mkdir(dir, { recursive: true });
    const finalName = await this.uniqueName(dir, clean);
    const id = crypto.randomUUID();
    const finalPath = path.join(dir, finalName);
    let thumbName = null;
    if (typeof thumb === 'string' && /^data:image\/jpeg;base64,/.test(thumb) && thumb.length < MAX_THUMB) {
      thumbName = `${id}.jpg`;
      await fsp.writeFile(this.thumbPath(thumbName), Buffer.from(thumb.split(',')[1], 'base64')).catch(() => (thumbName = null));
    }
    const s = {
      id, deviceId: dev.id, device: dev.name, fp, name: finalName, kind, finalPath, partPath: finalPath + '.ntpart',
      size, received: 0, mtime, thumb: thumbName, state: 'stalled', startedAt: Date.now(), updatedAt: Date.now(),
    };
    this.sessions.set(id, s);
    this.persistSessions();
    this.emit('transfer-start', this.sessionInfo(s));
    return s;
  }

  getUpload(res, dev, id) {
    const s = this.sessions.get(id);
    if (!s || s.deviceId !== dev.id) return json(res, 410, { error: 'gone' });
    return json(res, 200, { offset: s.received, size: s.size, state: s.state });
  }

  setUploadState(s, state) {
    if (s.state === state) return;
    s.state = state;
    s.updatedAt = Date.now();
    this.persistSessions();
    this.emit('transfer-state', { id: s.id, state });
  }

  async putUpload(req, res, dev, id, offset) {
    const s = this.sessions.get(id);
    if (!s || s.deviceId !== dev.id) return json(res, 410, { error: 'gone' });
    if (s.state === 'paused') return json(res, 423, { state: 'paused', offset: s.received });
    if (offset !== s.received) return json(res, 409, { offset: s.received });
    this.uploadReqs.get(id)?.destroy(); // una conexión antigua que se quedó colgada
    this.uploadReqs.set(id, req);
    this.setUploadState(s, 'active');
    const started = Date.now();

    const out = fs.createWriteStream(s.partPath, { flags: offset === 0 ? 'w' : 'a' });
    let lastEmit = 0;
    req.on('data', (chunk) => {
      s.received += chunk.length;
      if (s.received > s.size) req.destroy(new Error('too_much_data'));
      const now = Date.now();
      if (now - lastEmit > 120) {
        lastEmit = now;
        this.emit('transfer-progress', { id, received: s.received, size: s.size });
      }
    });

    try {
      await pipeline(req, out);
      this.uploadReqs.delete(id);
      s.activeMs = (s.activeMs || 0) + (Date.now() - started);
      if (s.received === s.size) {
        const entry = await this.finishUpload(s);
        return json(res, 200, { done: true, name: entry.name, offset: s.size });
      }
      s.updatedAt = Date.now();
      this.setUploadState(s, 'stalled');
      return json(res, 200, { done: false, offset: s.received });
    } catch {
      if (this.uploadReqs.get(id) === req) this.uploadReqs.delete(id);
      if (!out.closed) await once(out, 'close').catch(() => {});
      if (!this.sessions.has(id)) return json(res, 410, { error: 'gone' }); // cancelada
      // Lo que manda es lo que realmente llegó al disco.
      const st = await fsp.stat(s.partPath).catch(() => null);
      s.received = st ? Math.min(st.size, s.size) : 0;
      s.activeMs = (s.activeMs || 0) + (Date.now() - started);
      if (s.state !== 'paused') this.setUploadState(s, 'stalled');
      this.emit('transfer-progress', { id, received: s.received, size: s.size });
      return json(res, s.state === 'paused' ? 423 : 500, { error: 'interrupted', offset: s.received, state: s.state });
    }
  }

  async finishUpload(s) {
    this.sessions.delete(s.id);
    this.persistSessions();
    await fsp.rename(s.partPath, s.finalPath);
    const mtime = s.mtime > 0 && s.mtime < Date.now() + 86400000 ? new Date(s.mtime) : null;
    if (mtime) await fsp.utimes(s.finalPath, new Date(), mtime).catch(() => {});
    const entry = {
      id: s.id, direction: 'in', kind: s.kind, name: s.name, path: s.finalPath, size: s.size,
      device: s.device, at: Date.now(), thumb: s.thumb,
    };

    const mode = this.store.get('heicMode') || 'original';
    if (s.kind === 'photo' && isHeic(s.finalPath) && mode !== 'original') {
      this.emit('transfer-state', { id: s.id, state: 'converting' });
      const dir = path.dirname(s.finalPath);
      const jpgName = await this.uniqueName(dir, s.name.replace(/\.(heic|heif)$/i, '.jpg'));
      const jpgPath = path.join(dir, jpgName);
      try {
        await convertHeic(s.finalPath, jpgPath);
        if (mtime) await fsp.utimes(jpgPath, new Date(), mtime).catch(() => {});
        if (mode === 'jpg') {
          await fsp.unlink(s.finalPath).catch(() => {});
          Object.assign(entry, { name: jpgName, path: jpgPath });
          const st = await fsp.stat(jpgPath).catch(() => null);
          if (st) entry.size = st.size;
        } else {
          entry.extra = { name: jpgName, path: jpgPath };
        }
      } catch (e) {
        entry.convertError = e.message;
      } finally {
        this.reserved.delete(jpgPath.toLowerCase());
      }
    }

    this.reserved.delete(s.finalPath.toLowerCase());
    this.addHistory(entry);
    this.bumpStats(entry, s.activeMs || 0);
    this.emit('transfer-done', entry);
    return entry;
  }

  pauseUpload(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.setUploadState(s, 'paused');
    this.uploadReqs.get(id)?.destroy();
    this.sendTo(s.deviceId, 'control', { id, action: 'pause' });
  }

  resumeUpload(id) {
    const s = this.sessions.get(id);
    if (!s || s.state !== 'paused') return;
    this.setUploadState(s, 'stalled');
    this.sendTo(s.deviceId, 'control', { id, action: 'resume' });
  }

  cancelUpload(id, { notify = true } = {}) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.persistSessions();
    this.uploadReqs.get(id)?.destroy();
    this.uploadReqs.delete(id);
    fsp.unlink(s.partPath).catch(() => {});
    if (s.thumb) fsp.unlink(this.thumbPath(s.thumb)).catch(() => {});
    this.reserved.delete(s.finalPath.toLowerCase());
    if (notify) this.sendTo(s.deviceId, 'control', { id, action: 'cancel' });
    this.emit('transfer-cancelled', { id });
  }

  /** PUT /api/v1/upload: subida de una sola vez (compatibilidad con la primera versión de la API). */
  async simpleUpload(req, res, dev) {
    let name = '';
    try {
      name = decodeURIComponent(req.headers['x-file-name'] || '');
    } catch {
      name = String(req.headers['x-file-name'] || '');
    }
    const size = Number(req.headers['content-length']) || 0;
    const s = await this.openSession(dev, { name, size, mtime: Number(req.headers['x-file-mtime']) || 0, type: '' });
    if (s.received !== 0) {
      // Había una subida a medias del mismo archivo: esta API no sabe reanudar, se empieza de cero.
      s.received = 0;
    }
    return this.putUpload(req, res, dev, s.id, 0);
  }

  // ───────────── texto ─────────────
  async receiveText(req, res, dev) {
    const body = await readJson(req, MAX_TEXT * 2);
    const text = typeof body?.text === 'string' ? body.text.slice(0, MAX_TEXT) : '';
    if (!text.trim()) return json(res, 400, { error: 'empty' });
    const entry = {
      id: crypto.randomUUID(), direction: 'in', kind: 'text', text, name: text.trim().split('\n')[0].slice(0, 120),
      size: Buffer.byteLength(text), device: dev.name, at: Date.now(),
    };
    this.addHistory(entry);
    this.bumpStats(entry, 0);
    this.emit('text-received', entry);
    return json(res, 200, { ok: true });
  }

  // ───────────── PC → móvil: descargas ─────────────
  /** Admite Range para que el móvil pueda reproducir vídeos. */
  async sendOutboxFile(req, res, dev, id) {
    const item = (this.store.get('outbox') || []).find((i) => i.id === id && i.type !== 'text');
    const st = item && (await fsp.stat(item.path).catch(() => null));
    if (!st) return json(res, 404, { error: 'not_found' });
    if (item.type === 'folder') return this.sendFolderZip(res, dev, item);

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
    const tid = crypto.randomUUID();
    const kind = kindOf(item.path);
    const started = Date.now();
    this.downloads.set(tid, res);
    this.emit('transfer-start', {
      id: tid, direction: 'out', name: item.name, size: st.size, received: 0, device: dev.name, kind,
      thumb: item.thumb || null, state: 'active', startedAt: started,
    });
    const stream = fs.createReadStream(item.path);
    let sent = 0;
    let lastEmit = 0;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 120) {
        lastEmit = now;
        this.emit('transfer-progress', { id: tid, received: sent, size: st.size });
      }
    });
    try {
      await pipeline(stream, res);
      const entry = {
        id: tid, direction: 'out', kind, name: item.name, path: item.path, size: st.size, device: dev.name,
        at: Date.now(), thumb: item.thumb || null,
      };
      this.addHistory(entry);
      this.bumpStats(entry, Date.now() - started);
      this.emit('transfer-done', entry);
    } catch (e) {
      this.emit(this.downloads.has(tid) ? 'transfer-error' : 'transfer-cancelled', { id: tid, error: e.message });
    } finally {
      this.downloads.delete(tid);
    }
  }

  /** Carpeta → ZIP generado sobre la marcha (con su tamaño exacto, para que el móvil muestre el progreso). */
  async sendFolderZip(res, dev, item) {
    const { stream, size } = await zipFolder(item.path);
    const zipName = `${item.name}.zip`;
    const headers = {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      'Cache-Control': 'no-store',
    };
    if (size >= 0) headers['Content-Length'] = size;
    res.writeHead(200, headers);
    const tid = crypto.randomUUID();
    const started = Date.now();
    const total = size >= 0 ? size : item.size;
    this.downloads.set(tid, res);
    this.emit('transfer-start', {
      id: tid, direction: 'out', name: zipName, size: total, received: 0, device: dev.name, kind: 'other',
      thumb: null, state: 'active', startedAt: started,
    });
    let sent = 0;
    let lastEmit = 0;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 120) {
        lastEmit = now;
        this.emit('transfer-progress', { id: tid, received: sent, size: total });
      }
    });
    try {
      await pipeline(stream, res);
      const entry = {
        id: tid, direction: 'out', kind: 'other', name: zipName, path: item.path, size: sent, device: dev.name, at: Date.now(), thumb: null,
      };
      this.addHistory(entry);
      this.bumpStats(entry, Date.now() - started);
      this.emit('transfer-done', entry);
    } catch (e) {
      this.emit(this.downloads.has(tid) ? 'transfer-error' : 'transfer-cancelled', { id: tid, error: e.message });
    } finally {
      this.downloads.delete(tid);
    }
  }

  cancelDownload(id) {
    const res = this.downloads.get(id);
    if (!res) return;
    this.downloads.delete(id);
    res.destroy();
  }
}

module.exports = { TransferServer, sanitizeName };
