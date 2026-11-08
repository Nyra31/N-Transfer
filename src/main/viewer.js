'use strict';
// Visor integrado de fotos y vídeos: una ventana sin marco con la skin, que recorre el historial.
const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { isHeic } = require('../core/kinds');
const { convertHeic } = require('../core/heic');

function createViewer({ srcDir, cacheDir, getStore, getHistory, icon }) {
  let win = null;
  let items = [];

  function mediaItems() {
    const seen = new Set();
    return getHistory().filter((h) => {
      if (h.kind !== 'photo' && h.kind !== 'video') return false;
      if (!h.path || seen.has(h.path) || !fs.existsSync(h.path)) return false;
      seen.add(h.path);
      return true;
    });
  }

  function open(entryId) {
    items = mediaItems();
    const index = Math.max(0, items.findIndex((i) => i.id === entryId));
    if (win && !win.isDestroyed()) {
      win.webContents.send('evt', 'viewer-goto', index);
      win.show();
      win.focus();
      return;
    }
    const b = getStore().get('viewerBounds') || {};
    win = new BrowserWindow({
      width: b.width || 900, height: b.height || 640, x: b.x, y: b.y, minWidth: 420, minHeight: 320,
      frame: false, backgroundColor: '#000', icon, title: 'N-Transfer',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
    });
    win.setMenu(null);
    win.loadFile(path.join(srcDir, 'renderer', 'viewer.html'), { query: { i: String(index) } });
    const save = () => !win.isMinimized() && !win.isMaximized() && getStore().set('viewerBounds', win.getBounds());
    win.on('moved', save);
    win.on('resized', save);
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('closed', () => (win = null));
  }

  /** Lista para el visor, con las URLs que puede cargar (las HEIC se convierten a JPG en caché). */
  function list() {
    return items.map((i) => ({
      id: i.id, name: i.name, kind: i.kind, size: i.size, at: i.at, device: i.device, path: i.path,
      thumb: i.thumb || null, heic: isHeic(i.path),
    }));
  }

  async function source(id) {
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    if (!isHeic(item.path)) return pathToFileURL(item.path).href;
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, `${item.id}.jpg`);
    if (!fs.existsSync(cached)) await convertHeic(item.path, cached, 0.9);
    return pathToFileURL(cached).href;
  }

  function control(action) {
    if (!win || win.isDestroyed()) return;
    if (action === 'close') win.close();
    else if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
  }

  return { open, list, source, control, get window() { return win; } };
}

module.exports = { createViewer };
