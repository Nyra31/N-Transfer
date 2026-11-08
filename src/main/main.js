'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, Notification } = require('electron');
const path = require('path');
const QRCode = require('qrcode');
const { Store } = require('../core/store');
const { TransferServer } = require('../core/server');
const mdns = require('../core/mdns');
const autostart = require('./autostart');
const i18n = require('../shared/i18n');

const SRC = path.join(__dirname, '..');
const ICON = path.join(SRC, 'assets', 'icon.png');
const TRAY_ICON = path.join(SRC, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
const SKINS = ['winamp', 'chrome', 'luna'];
const WIDTH = 480;

if (process.env.NT_USER_DATA) app.setPath('userData', process.env.NT_USER_DATA);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(init);
}
app.setAppUserModelId('com.nyra31.ntransfer');

let win = null;
let tray = null;
let store = null;
let server = null;
let serverError = null;
let quitting = false;
let updateReady = false;
let shaded = false;
let fullHeight = 620;
let batch = { count: 0, timer: null };

const t = (key, vars) => i18n.translator(store.get('lang'))(key, vars);
const send = (name, payload) => win && !win.isDestroyed() && win.webContents.send('evt', name, payload);

async function init() {
  store = new Store(path.join(app.getPath('userData'), 'config.json'), {
    port: 47800,
    destDir: path.join(app.getPath('downloads'), 'N-Transfer'),
    skin: 'winamp',
    lang: app.getLocale().toLowerCase().startsWith('es') ? 'es' : 'en',
    closeToTray: true,
    trayHintShown: false,
    devices: [],
    outbox: [],
    history: [],
    bounds: null,
  });
  if (process.env.NT_PORT) store.set('port', Number(process.env.NT_PORT));

  server = new TransferServer({
    store,
    mobileDir: path.join(SRC, 'mobile'),
    sharedDir: path.join(SRC, 'shared'),
    version: app.getVersion(),
  });
  wireServerEvents();
  try {
    await server.start();
    mdns.advertise({ name: require('os').hostname(), port: server.port, version: app.getVersion() });
  } catch (e) {
    serverError = e.code === 'EADDRINUSE' ? t('serverError', { port: server.port }) : e.message;
  }

  createWindow();
  createTray();
  setupUpdater();

  if (process.env.NT_SHOTS) require('./devshots')({ app, win, server, store, send });
}

// ───────────── ventana ─────────────
function createWindow() {
  const b = store.get('bounds') || {};
  fullHeight = b.height || 620;
  win = new BrowserWindow({
    width: WIDTH,
    height: fullHeight,
    x: b.x,
    y: b.y,
    minWidth: 420,
    minHeight: 420,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#22232f',
    icon: ICON,
    title: 'N-Transfer',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(SRC, 'renderer', 'index.html'));

  const startHidden = process.argv.includes('--hidden') || process.env.NT_SHOTS;
  win.once('ready-to-show', () => !startHidden && win.show());

  // Solo navegamos dentro de la app; los enlaces externos se abren en el navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const saveBounds = () => {
    if (win.isMinimized()) return;
    const { x, y, width } = win.getBounds();
    store.set('bounds', { x, y, width, height: shaded ? fullHeight : win.getBounds().height });
  };
  win.on('moved', saveBounds);
  win.on('resized', () => {
    if (!shaded) fullHeight = win.getBounds().height;
    saveBounds();
  });

  win.on('close', (e) => {
    if (!quitting && store.get('closeToTray')) {
      e.preventDefault();
      win.hide();
      if (!store.get('trayHintShown') && Notification.isSupported()) {
        new Notification({ title: 'N-Transfer', body: t('trayHint'), icon: ICON }).show();
        store.set('trayHintShown', true);
      }
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function setShade(on, height) {
  shaded = on;
  const { width } = win.getBounds();
  if (on) {
    win.setMinimumSize(420, height);
    win.setSize(width, height);
    win.setResizable(false);
  } else {
    win.setResizable(true);
    win.setMinimumSize(420, 420);
    win.setSize(width, fullHeight);
  }
}

// ───────────── bandeja ─────────────
function createTray() {
  const img = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(ICON).resize({ width: 16 }) : img);
  tray.setToolTip('N-Transfer');
  tray.on('click', showWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('trayShow'), click: showWindow },
    { label: t('pair'), click: () => { showWindow(); send('open-pair'); } },
    { label: t('folder'), click: openDestFolder },
    { type: 'separator' },
    { label: t('autostart'), type: 'checkbox', checked: autostart.get(), click: (i) => setAutostart(i.checked) },
    ...(updateReady ? [{ label: t('restartUpdate'), click: installUpdate }] : []),
    { type: 'separator' },
    { label: t('trayQuit'), click: quit },
  ]));
}

function setAutostart(on) {
  try {
    autostart.set(on);
  } catch (e) {
    console.warn('autostart:', e.message);
  }
  refreshTrayMenu();
  send('settings', settings());
}

function quit() {
  quitting = true;
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  mdns.stop();
  store?.flush();
});
app.on('window-all-closed', () => {
  /* seguimos en la bandeja */
});

function openDestFolder() {
  const dir = store.get('destDir');
  require('fs').mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

// ───────────── eventos del servidor → interfaz ─────────────
function wireServerEvents() {
  for (const ev of ['transfer-start', 'transfer-progress', 'transfer-error']) {
    server.on(ev, (p) => send(ev, p));
  }
  server.on('transfer-done', (entry) => {
    send('transfer-done', entry);
    if (entry.direction === 'in') notifyBatch();
  });
  server.on('devices-changed', (d) => send('devices', d));
  server.on('outbox-changed', (o) => send('outbox', o));
  server.on('history-changed', (h) => send('history', h));
  server.on('device-paired', (d) => send('paired', d));
  server.on('pair-code', async () => send('pair', await pairInfo()));
}

/** Agrupa las notificaciones: una por tanda de archivos, solo con la ventana oculta. */
function notifyBatch() {
  batch.count++;
  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    if ((!win.isVisible() || win.isMinimized()) && Notification.isSupported()) {
      const n = new Notification({
        title: t('notifyReceived', { n: batch.count }),
        body: t('notifyReceivedBody', { dir: store.get('destDir') }),
        icon: ICON,
      });
      n.on('click', openDestFolder);
      n.show();
    }
    batch.count = 0;
  }, 2500);
}

async function pairInfo() {
  const url = server.pairUrl();
  const qr = await QRCode.toDataURL(url, { margin: 2, width: 360, errorCorrectionLevel: 'M' });
  return { url, qr, ip: server.ip, host: server.mdnsHost, port: server.port };
}

function settings() {
  return {
    skin: store.get('skin'),
    lang: store.get('lang'),
    destDir: store.get('destDir'),
    closeToTray: store.get('closeToTray'),
    autostart: autostart.get(),
    port: store.get('port'),
  };
}

// ───────────── IPC ─────────────
ipcMain.handle('state', async () => ({
  settings: settings(),
  pair: await pairInfo(),
  devices: server.devices(),
  outbox: server.outbox(),
  history: server.history().slice(0, 200),
  version: app.getVersion(),
  platform: process.platform,
  serverError,
  updateReady,
}));

ipcMain.handle('set', (_e, key, value) => {
  if (key === 'skin' && SKINS.includes(value)) applySetting('skin', value);
  else if (key === 'lang' && i18n.LANGS.includes(value)) applySetting('lang', value);
  else if (key === 'closeToTray') applySetting('closeToTray', !!value);
  else if (key === 'autostart') setAutostart(!!value);
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    defaultPath: store.get('destDir'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!r.canceled && r.filePaths[0]) {
    store.set('destDir', r.filePaths[0]);
    send('settings', settings());
  }
});

ipcMain.handle('outbox-add', (_e, paths) => server.addToOutbox((paths || []).filter((p) => typeof p === 'string')));
ipcMain.handle('outbox-pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (!r.canceled) await server.addToOutbox(r.filePaths);
});
ipcMain.handle('outbox-remove', (_e, id) => server.removeFromOutbox(id));
ipcMain.handle('outbox-clear', () => server.clearOutbox());
ipcMain.handle('device-forget', (_e, id) => server.forgetDevice(id));
ipcMain.handle('pair-new', () => {
  server.newPairCode();
});
ipcMain.handle('open-folder', openDestFolder);
ipcMain.handle('history-clear', () => server.clearHistory());
ipcMain.handle('update-install', installUpdate);
ipcMain.handle('open-external', (_e, url) => /^https:\/\//.test(url) && shell.openExternal(url));

ipcMain.handle('item-menu', (_e, filePath) => {
  if (typeof filePath !== 'string') return;
  Menu.buildFromTemplate([
    { label: t('openFile'), click: () => shell.openPath(filePath) },
    { label: t('showInFolder'), click: () => shell.showItemInFolder(filePath) },
  ]).popup({ window: win });
});

ipcMain.handle('main-menu', () => {
  const skinLabels = { winamp: t('skinWinamp'), chrome: t('skinChrome'), luna: t('skinLuna') };
  Menu.buildFromTemplate([
    { label: t('pair'), click: () => send('open-pair') },
    { label: t('settings') + '…', click: () => send('open-settings') },
    { type: 'separator' },
    {
      label: t('skin'),
      submenu: SKINS.map((s) => ({
        label: skinLabels[s], type: 'radio', checked: store.get('skin') === s,
        click: () => applySetting('skin', s),
      })),
    },
    {
      label: t('language'),
      submenu: [['es', 'Español'], ['en', 'English']].map(([code, label]) => ({
        label, type: 'radio', checked: store.get('lang') === code, click: () => applySetting('lang', code),
      })),
    },
    { type: 'separator' },
    ...(updateReady ? [{ label: t('restartUpdate'), click: installUpdate }] : []),
    { label: t('about') + '…', click: () => send('open-settings', 'about') },
    { label: t('trayQuit'), click: quit },
  ]).popup({ window: win });
});

function applySetting(key, value) {
  store.set(key, value);
  server.settingsChanged();
  refreshTrayMenu();
  send('settings', settings());
}

ipcMain.handle('win', (_e, action, arg) => {
  if (action === 'minimize') win.minimize();
  else if (action === 'close') win.close();
  else if (action === 'shade') setShade(true, Number(arg) || 180);
  else if (action === 'unshade') setShade(false);
});

// ───────────── actualizaciones (GitHub Releases) ─────────────
function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('update-downloaded', () => {
      updateReady = true;
      send('update-ready');
      refreshTrayMenu();
    });
    autoUpdater.on('error', (e) => console.warn('updater:', e.message));
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000);
  } catch (e) {
    console.warn('updater no disponible:', e.message);
  }
}

function installUpdate() {
  if (!updateReady) return;
  quitting = true;
  require('electron-updater').autoUpdater.quitAndInstall();
}
