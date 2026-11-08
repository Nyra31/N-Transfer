// Genera todos los iconos PNG a partir del SVG del logo. Uso: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function logo({ full = false, tray = false } = {}) {
  const frame = full
    ? '<rect width="512" height="512" fill="url(#m)"/>'
    : '<rect x="16" y="16" width="480" height="480" rx="96" fill="url(#m)" stroke="#07070b" stroke-width="10"/>';
  const inset = tray
    ? ''
    : `<rect x="${full ? 64 : 58}" y="${full ? 64 : 58}" width="${full ? 384 : 396}" height="${full ? 384 : 396}" rx="56"
         fill="#030603" stroke="#9a9db0" stroke-width="4"/>
       <g opacity=".22" stroke="#00e600" stroke-width="2">${Array.from({ length: 22 }, (_, i) =>
         `<line x1="90" x2="422" y1="${100 + i * 15}" y2="${100 + i * 15}"/>`).join('')}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="m" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7a7d92"/><stop offset=".45" stop-color="#34364a"/><stop offset="1" stop-color="#17181f"/>
    </linearGradient>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#b6ff8a"/><stop offset=".55" stop-color="#22e022"/><stop offset="1" stop-color="#0f9a12"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  ${frame}
  ${inset}
  <g filter="url(#glow)" fill="url(#g)">
    <path d="${tray ? 'M96 430V82h82l156 222V82h82v348h-82L178 208v222z' : 'M146 386V126h56l108 158V126h56v260h-56L202 228v158z'}"/>
    ${tray ? '' : '<path d="M374 112l34 40h-22v40h-24v-40h-22z"/><path d="M138 400l-34-40h22v-40h24v40h22z"/>'}
  </g>
</svg>`;
}

const targets = [
  { file: 'build/icon.png', size: 512 },
  { file: 'src/assets/icon.png', size: 256 },
  { file: 'src/assets/tray.png', size: 32, opts: { tray: true } },
  { file: 'src/mobile/icons/icon-192.png', size: 192 },
  { file: 'src/mobile/icons/icon-512.png', size: 512 },
  { file: 'src/mobile/icons/apple-touch-icon.png', size: 180, opts: { full: true } },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<canvas id=c></canvas>');
  for (const { file, size, opts } of targets) {
    const svg = Buffer.from(logo(opts)).toString('base64');
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const c = document.getElementById('c'); c.width = ${size}; c.height = ${size};
        const ctx = c.getContext('2d'); ctx.clearRect(0, 0, ${size}, ${size});
        ctx.drawImage(img, 0, 0, ${size}, ${size}); res(c.toDataURL('image/png'));
      };
      img.src = 'data:image/svg+xml;base64,${svg}';
    })`);
    const out = path.join(ROOT, file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('✔', file);
  }
  fs.writeFileSync(path.join(ROOT, 'build/icon.svg'), logo());
  app.quit();
});
