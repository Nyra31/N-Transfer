'use strict';
/**
 * Solo para desarrollo (NT_SHOTS=<carpeta>): empareja un dispositivo de prueba, sube archivos de verdad
 * por HTTP, deja una subida a medias y guarda capturas del PC y del móvil con cada skin.
 */
const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function put(port, token, name, body, { slow = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/v1/upload', method: 'PUT',
      headers: { 'X-Device-Token': token, 'X-File-Name': encodeURIComponent(name), 'Content-Length': body.length },
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    if (!slow) return req.end(body);
    // Subida lenta: ~1 MB cada 100 ms, para que se vea en curso en la captura.
    let off = 0;
    const step = () => {
      if (off >= body.length) return req.end();
      req.write(body.subarray(off, off + 1048576));
      off += 1048576;
      setTimeout(step, 100);
    };
    step();
  });
}

module.exports = async function devshots({ app, win, server, store, send }) {
  const out = path.resolve(process.env.NT_SHOTS);
  fs.mkdirSync(out, { recursive: true });
  store.set('destDir', path.join(out, 'received'));
  const report = [];
  try {
    const { token } = server.pairDevice('iPhone de Ben', 'ios');
    const port = server.port;
    for (const [name, size] of [['IMG_0421.HEIC', 2.1], ['IMG_0422.HEIC', 1.9], ['Factura marzo.pdf', 0.3]]) {
      const r = await put(port, token, name, Buffer.alloc(Math.round(size * 1048576), 7));
      report.push(`upload ${name}: ${r.status} ${r.data}`);
    }
    const dup = await put(port, token, 'IMG_0421.HEIC', Buffer.from('dup'));
    report.push(`duplicate name: ${dup.data}`);
    const bad = await new Promise((res) => {
      http.request({ host: '127.0.0.1', port, path: '/api/v1/upload', method: 'PUT', headers: { 'X-Device-Token': 'x'.repeat(32) } },
        (r) => res(r.statusCode)).end('x');
    });
    report.push(`bad token: ${bad}`);
    await server.addToOutbox([path.join(out, 'received', 'Factura marzo.pdf')]);

    const slow = put(port, token, 'IMG_0423.MOV', Buffer.alloc(80 * 1048576, 1), { slow: true });
    win.show();
    await wait(2500);

    const mobile = new BrowserWindow({
      width: 390, height: 844, show: false, webPreferences: { partition: 'shots-mobile' },
    });
    for (const skin of ['winamp', 'chrome', 'luna']) {
      store.set('skin', skin);
      server.settingsChanged();
      send('settings', { skin, lang: store.get('lang'), destDir: store.get('destDir'), closeToTray: true, autostart: false, port });
      await wait(700);
      fs.writeFileSync(path.join(out, `pc-${skin}.png`), (await win.webContents.capturePage()).toPNG());
      await mobile.loadURL(`http://127.0.0.1:${port}/?d=${token}&skin=${skin}`);
      await wait(1200);
      fs.writeFileSync(path.join(out, `mobile-${skin}.png`), (await mobile.webContents.capturePage()).toPNG());
    }
    // Pantalla de emparejamiento del móvil y diálogo QR del PC
    await mobile.loadURL(`http://127.0.0.1:${port}/pair?c=${server.pairCode}&skin=winamp`);
    await wait(1000);
    fs.writeFileSync(path.join(out, 'mobile-pair.png'), (await mobile.webContents.capturePage()).toPNG());
    send('open-pair');
    await wait(600);
    fs.writeFileSync(path.join(out, 'pc-pair.png'), (await win.webContents.capturePage()).toPNG());

    // ── Flujo «añadir a pantalla de inicio» ──
    // 1) Emparejar desde la página del QR (sesión limpia, como Safari)
    const safari = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { partition: 'shots-safari' } });
    await safari.loadURL(`http://127.0.0.1:${port}/pair?c=${server.pairCode}`);
    await wait(500);
    await safari.webContents.executeJavaScript(`document.getElementById('btnPair').click()`);
    await wait(2500);
    const after = await safari.webContents.executeJavaScript(
      `({ url: location.href, manifest: document.getElementById('manifest').getAttribute('href'),
          view: ['viewPair','viewNone','viewMain'].find((v) => !document.getElementById(v).hidden) })`);
    report.push(`after pairing: view=${after.view} url-has-token=${/[?&]d=/.test(after.url)} manifest=${after.manifest.replace(/d=.*/, 'd=<token>')}`);
    const newToken = new URL(after.url).searchParams.get('d');
    const man = await (await fetch(`http://127.0.0.1:${port}${after.manifest}`)).json();
    report.push(`manifest start_url has token: ${man.start_url === '/?d=' + newToken}`);
    // 2) La app de inicio arranca en «/» sin almacenamiento: debe ofrecer escribir el código
    const homeApp = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { partition: 'shots-home' } });
    await homeApp.loadURL(`http://127.0.0.1:${port}/`);
    await wait(800);
    fs.writeFileSync(path.join(out, 'mobile-code.png'), (await homeApp.webContents.capturePage()).toPNG());
    const typed = server.pairCodeDisplay.toLowerCase(); // minúsculas y con guion: debe aceptarse igual
    await homeApp.webContents.executeJavaScript(`(() => { const i = document.getElementById('codeInput');
      i.value = ${JSON.stringify(typed)}; i.dispatchEvent(new Event('input')); document.getElementById('btnCode').click(); })()`);
    await wait(2500);
    const viaCode = await homeApp.webContents.executeJavaScript(
      `({ url: location.href, view: ['viewPair','viewNone','viewMain'].find((v) => !document.getElementById(v).hidden) })`);
    report.push(`pair by typed code: view=${viaCode.view} url-has-token=${/[?&]d=/.test(viaCode.url)}`);
    // 3) Código incorrecto
    const wrong = await fetch(`http://127.0.0.1:${port}/api/v1/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-AAAA', name: 'x' }),
    });
    report.push(`wrong code: ${wrong.status}`);
    report.push(`devices: ${server.devices().map((d) => d.name).join(', ')}`);

    const r = await slow;
    report.push(`slow upload: ${r.status} ${r.data}`);
    report.push('files: ' + fs.readdirSync(path.join(out, 'received')).join(', '));
  } catch (e) {
    report.push('ERROR ' + e.stack);
  }
  fs.writeFileSync(path.join(out, 'report.txt'), report.join('\n'));
  store.flush();
  app.exit(0);
};
