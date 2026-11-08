// iOS → PC Transfer: servidor local para recibir fotos, vídeos y archivos desde el iPhone por Wi-Fi.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const busboy = require('busboy');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 8080;
const DEST = process.env.DEST_DIR || path.join(os.homedir(), 'Downloads', 'iPhone Transfer');
// Token aleatorio por sesión: solo quien escanee el QR puede subir archivos.
const TOKEN = crypto.randomBytes(6).toString('hex');

fs.mkdirSync(DEST, { recursive: true });

function getLanIPs() {
  const ips = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !/vEthernet|VirtualBox|VMware|WSL/i.test(name)) {
        ips.push(a.address);
      }
    }
  }
  return ips.length ? ips : ['127.0.0.1'];
}

function safeName(name) {
  const base = path.basename(name || 'archivo').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'archivo';
  let candidate = base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 1; fs.existsSync(path.join(DEST, candidate)); i++) {
    candidate = `${stem} (${i})${ext}`;
  }
  return candidate;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const ips = getLanIPs();
const uploadUrl = `http://${ips[0]}:${PORT}/?t=${TOKEN}`;
const received = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Panel del PC (solo accesible desde el propio PC)
  if (req.method === 'GET' && url.pathname === '/pc') {
    if (!isLocal(req)) return send(res, 403, 'Solo disponible en el PC');
    return fs.createReadStream(path.join(__dirname, 'public', 'pc.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    if (!isLocal(req)) return send(res, 403, 'Forbidden');
    const qr = await QRCode.toDataURL(uploadUrl, { margin: 1, width: 320 });
    return send(res, 200, JSON.stringify({ uploadUrl, qr, dest: DEST, received }), 'application/json');
  }
  if (req.method === 'POST' && url.pathname === '/api/open-folder') {
    if (!isLocal(req)) return send(res, 403, 'Forbidden');
    exec(`explorer "${DEST}"`);
    return send(res, 200, 'ok');
  }

  // Página del iPhone
  if (req.method === 'GET' && url.pathname === '/') {
    if (url.searchParams.get('t') !== TOKEN) {
      return send(res, 403, 'Enlace no válido. Escanea de nuevo el código QR que aparece en el PC.');
    }
    return fs.createReadStream(path.join(__dirname, 'public', 'upload.html')).pipe(res);
  }

  // Subida de archivos (streaming directo a disco, sirve para vídeos grandes)
  if (req.method === 'POST' && url.pathname === '/upload') {
    if (url.searchParams.get('t') !== TOKEN) return send(res, 403, 'Token no válido');
    const saved = [];
    const pending = [];
    let bb;
    try {
      bb = busboy({ headers: req.headers, defParamCharset: 'utf8' });
    } catch {
      return send(res, 400, 'Petición no válida');
    }
    bb.on('file', (_field, file, info) => {
      const name = safeName(info.filename);
      const target = path.join(DEST, name);
      const out = fs.createWriteStream(target);
      let size = 0;
      file.on('data', (d) => (size += d.length));
      pending.push(new Promise((resolve, reject) => {
        out.on('finish', () => {
          const entry = { name, size, at: new Date().toISOString() };
          saved.push(entry);
          received.unshift(entry);
          console.log(`  ✔ ${name} (${(size / 1048576).toFixed(1)} MB)`);
          resolve();
        });
        out.on('error', reject);
      }));
      file.pipe(out);
    });
    bb.on('close', async () => {
      try {
        await Promise.all(pending);
        send(res, 200, JSON.stringify({ saved }), 'application/json');
      } catch (e) {
        send(res, 500, 'Error guardando: ' + e.message);
      }
    });
    bb.on('error', (e) => send(res, 500, 'Error: ' + e.message));
    return req.pipe(bb);
  }

  send(res, 404, 'No encontrado');
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n  iOS → PC Transfer');
  console.log('  ─────────────────');
  console.log(`  Carpeta destino: ${DEST}`);
  console.log(`  Escanea este QR con la cámara del iPhone (misma red Wi-Fi):\n`);
  console.log(await QRCode.toString(uploadUrl, { type: 'terminal', small: true }));
  console.log(`  O abre en Safari: ${uploadUrl}\n`);
  if (!process.env.NO_BROWSER) exec(`start "" "http://localhost:${PORT}/pc"`);
});
