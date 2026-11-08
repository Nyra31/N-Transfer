'use strict';
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, Notification, clipboard,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const QRCode = require('qrcode');
const { Store } = require('../core/store');
const { TransferServer } = require('../core/server');
const mdns = require('../core/mdns');
const heic = require('../core/heic');
const autostart = require('./autostart');
const { createSkinManager } = require('./custom-skins');
const { makeThumbnail } = require('./thumbs');
const { createViewer } = require('./viewer');
const i18n = require('../shared/i18n');

const SRC = path.join(__dirname, '..');
const ICON = path.join(SRC, 'assets', 'icon.png');
const TRAY_ICON = path.join(SRC, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
const WIDTH = 480;
const MINI_WIDTH = 340;

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
let skins = null;
let viewer = null;
let serverError = null;
let quitting = false;
let updateReady = false;
let viewMode = 'normal'; // normal | shade | mini
let fullHeight = 620;
const batch = { count: 0, timer: null };
const thumbsDir = () => path.join(app.getPath('userData'), 'thumbs');

const t = (key, vars) => i18n.translator(store.get('lang'))(key, vars);
/** Envía un evento a la ventana principal y al visor (si está abierto). */
function send(name, payload) {
  for (const w of [win, viewer?.window]) if (w && !w.isDestroyed()) w.webContents.send('evt', name, payload);
}

async function init() {
  store = new Store(path.join(app.getPath('userData'), 'config.json'), {
    port: 47800,
    destDir: path.join(app.getPath('downloads'), 'N-Transfer'),
    splitByType: false,
    photoDir: '',
    videoDir: '',
    otherDir: '',
    heicMode: 'original', // original | both | jpg
    skin: 'winamp',
    lang: app.getLocale().toLowerCase().startsWith('es') ? 'es' : 'en',
    closeToTray: true,
    sounds: true,
    autoCopyText: true,
    alwaysOnTop: false,
    viewMode: 'normal',
    trayHintShown: false,
    devices: [],
    outbox: [],
    history: [],
    uploads: [],
    bounds: null,
  });
  if (process.env.NT_PORT) store.set('port', Number(process.env.NT_PORT));

  skins = createSkinManager(path.join(app.getPath('userData'), 'skins'), () => {
    if (!skins.has(store.get('skin'))) store.set('skin', 'winamp');
    server?.settingsChanged();
    send('skins', customSkins());
    send('settings', settings());
  });

  server = new TransferServer({
    store,
    mobileDir: path.join(SRC, 'mobile'),
    sharedDir: path.join(SRC, 'shared'),
    thumbsDir: thumbsDir(),
    version: app.getVersion(),
    customSkins: () => skins.list(),
    thumbnailer: makeThumbnail,
  });
  wireServerEvents();
  try {
    await server.start();
    mdns.advertise({ name: os.hostname(), port: server.port, version: app.getVersion() });
  } catch (e) {
    serverError = e.code === 'EADDRINUSE' ? t('serverError', { port: server.port }) : e.message;
  }

  viewer = createViewer({
    srcDir: SRC,
    cacheDir: path.join(app.getPath('userData'), 'preview-cache'),
    getStore: () => store,
    getHistory: () => server.history(),
    icon: ICON,
  });

  createWindow();
  createTray();
  setupUpdater();

  if (process.env.NT_SHOTS) require('./devshots')({ app, win, server, store, send, viewer, settings });
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
    alwaysOnTop: store.get('alwaysOnTop'),
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

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const saveBounds = () => {
    if (win.isMinimized()) return;
    const { x, y, width } = win.getBounds();
    store.set('bounds', { x, y, width: viewMode === 'mini' ? (b.width || WIDTH) : width, height: fullHeight });
  };
  win.on('moved', saveBounds);
  win.on('resized', () => {
    if (viewMode === 'normal') fullHeight = win.getBounds().height;
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

/** normal: ventana completa · shade: título + LCD · mini: LCD diminuta. */
function setViewMode(mode, height) {
  const { width } = win.getBounds();
  if (viewMode === 'normal' && mode !== 'normal') store.set('normalWidth', width);
  viewMode = mode;
  store.set('viewMode', mode);
  if (mode === 'normal') {
    win.setResizable(true);
    win.setMinimumSize(420, 420);
    win.setSize(store.get('normalWidth') || WIDTH, fullHeight);
  } else {
    const w = mode === 'mini' ? MINI_WIDTH : width;
    win.setResizable(true);
    win.setMinimumSize(mode === 'mini' ? MINI_WIDTH : 420, height);
    win.setSize(w, height);
    win.setResizable(false);
  }
}

function setAlwaysOnTop(on) {
  store.set('alwaysOnTop', on);
  win.setAlwaysOnTop(on, 'floating');
  send('settings', settings());
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
    { label: t('alwaysOnTop'), type: 'checkbox', checked: store.get('alwaysOnTop'), click: (i) => setAlwaysOnTop(i.checked) },
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
  clearTimeout(batch.timer);
  mdns.stop();
  heic.stop();
  if (server) server.persistSessions();
  store?.flush();
});
app.on('window-all-closed', () => {
  /* seguimos en la bandeja */
});

function openDestFolder() {
  const dir = store.get('destDir');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

// ───────────── eventos del servidor → interfaz ─────────────
function wireServerEvents() {
  for (const ev of ['transfer-start', 'transfer-progress', 'transfer-state', 'transfer-error', 'transfer-cancelled']) {
    server.on(ev, (p) => send(ev, p));
  }
  server.on('transfer-done', (entry) => {
    send('transfer-done', entry);
    if (entry.direction === 'in') notifyBatch();
  });
  server.on('text-received', (entry) => {
    const copied = store.get('autoCopyText');
    if (copied) clipboard.writeText(entry.text);
    send('text-received', { ...entry, copied });
    if ((!win.isVisible() || win.isMinimized()) && Notification.isSupported()) {
      const n = new Notification({
        title: t('textFrom', { device: entry.device }),
        body: entry.text.slice(0, 200) + (copied ? '\n' + t('textCopied') : ''),
        icon: ICON,
      });
      n.on('click', showWindow);
      n.show();
    }
  });
  server.on('stats-changed', (s) => send('stats', s));
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
    if (quitting || !win || win.isDestroyed()) return;
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
  return { url, qr, code: server.pairCodeDisplay, ip: server.ip, host: server.mdnsHost, port: server.port };
}

function settings() {
  return {
    skin: store.get('skin'),
    lang: store.get('lang'),
    destDir: store.get('destDir'),
    splitByType: store.get('splitByType'),
    photoDir: store.get('photoDir') || server.defaultTypeDir('photo'),
    videoDir: store.get('videoDir') || server.defaultTypeDir('video'),
    otherDir: store.get('otherDir') || server.defaultTypeDir('other'),
    heicMode: store.get('heicMode'),
    closeToTray: store.get('closeToTray'),
    sounds: store.get('sounds'),
    autoCopyText: store.get('autoCopyText'),
    alwaysOnTop: store.get('alwaysOnTop'),
    viewMode: store.get('viewMode'),
    autostart: autostart.get(),
    port: store.get('port'),
  };
}

function customSkins() {
  return skins.list().map(({ id, name, css }) => ({ id, name, css }));
}

// ───────────── IPC ─────────────
ipcMain.handle('state', async () => ({
  settings: settings(),
  pair: await pairInfo(),
  devices: server.devices(),
  outbox: server.outbox(),
  history: server.history().slice(0, 200),
  active: server.activeTransfers(),
  stats: server.stats(),
  customSkins: customSkins(),
  thumbBase: pathToFileURL(thumbsDir()).href + '/',
  version: app.getVersion(),
  platform: process.platform,
  serverError,
  updateReady,
}));

const BOOL_SETTINGS = new Set(['closeToTray', 'sounds', 'autoCopyText', 'splitByType']);
ipcMain.handle('set', (_e, key, value) => {
  if (key === 'skin' && skins.has(value)) applySetting('skin', value);
  else if (key === 'lang' && i18n.LANGS.includes(value)) applySetting('lang', value);
  else if (key === 'heicMode' && ['original', 'both', 'jpg'].includes(value)) applySetting('heicMode', value);
  else if (BOOL_SETTINGS.has(key)) applySetting(key, !!value);
  else if (key === 'autostart') setAutostart(!!value);
  else if (key === 'alwaysOnTop') setAlwaysOnTop(!!value);
});

/** Elegir carpeta: destino general (key = destDir) o por tipo (photoDir, videoDir, otherDir). */
ipcMain.handle('pick-folder', async (_e, key = 'destDir') => {
  if (!['destDir', 'photoDir', 'videoDir', 'otherDir'].includes(key)) return;
  const current = key === 'destDir' ? store.get('destDir') : settings()[key];
  const r = await dialog.showOpenDialog(win, { defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
  if (!r.canceled && r.filePaths[0]) {
    store.set(key, r.filePaths[0]);
    send('settings', settings());
  }
});
ipcMain.handle('reset-folder', (_e, key) => {
  if (!['photoDir', 'videoDir', 'otherDir'].includes(key)) return;
  store.set(key, '');
  send('settings', settings());
});

ipcMain.handle('outbox-add', (_e, paths) => server.addToOutbox((paths || []).filter((p) => typeof p === 'string')));
ipcMain.handle('outbox-pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (!r.canceled) await server.addToOutbox(r.filePaths);
});
ipcMain.handle('outbox-text', (_e, text) => server.addTextToOutbox(text));
ipcMain.handle('outbox-remove', (_e, id) => server.removeFromOutbox(id));
ipcMain.handle('outbox-clear', () => server.clearOutbox());
ipcMain.handle('device-forget', (_e, id) => server.forgetDevice(id));
ipcMain.handle('pair-new', () => {
  server.newPairCode();
});
ipcMain.handle('open-folder', openDestFolder);
ipcMain.handle('history-clear', () => server.clearHistory());
ipcMain.handle('stats-reset', () => server.resetStats());
ipcMain.handle('update-install', installUpdate);
ipcMain.handle('open-external', (_e, url) => /^https?:\/\//.test(url) && shell.openExternal(url));
ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.handle('clipboard-write', (_e, text) => clipboard.writeText(String(text)));

ipcMain.handle('transfer', (_e, action, id) => {
  if (action === 'pause') server.pauseUpload(id);
  else if (action === 'resume') server.resumeUpload(id);
  else if (action === 'cancel') {
    server.cancelUpload(id);
    server.cancelDownload(id);
  }
});

function openSkinsFolder() {
  skins.ensureTemplate(path.join(SRC, 'shared', 'skins', 'template.css'));
  skins.rescan();
  shell.openPath(skins.dir);
}
ipcMain.handle('skins-folder', openSkinsFolder);

ipcMain.handle('item-menu', (_e, entryId) => {
  const entry = server.history().find((h) => h.id === entryId);
  if (!entry) return;
  const items = [];
  if (entry.kind === 'text') {
    items.push({ label: t('copy'), click: () => clipboard.writeText(entry.text) });
    if (/^https?:\/\/\S+$/.test(entry.text.trim())) items.push({ label: t('openLink'), click: () => shell.openExternal(entry.text.trim()) });
  } else if (entry.path) {
    if (entry.kind === 'photo' || entry.kind === 'video') items.push({ label: t('view'), click: () => viewer.open(entry.id) });
    items.push({ label: t('openFile'), click: () => shell.openPath(entry.path) });
    items.push({ label: t('showInFolder'), click: () => shell.showItemInFolder(entry.path) });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
});

ipcMain.handle('open-entry', (_e, entryId) => {
  const entry = server.history().find((h) => h.id === entryId);
  if (!entry?.path) return;
  if ((entry.kind === 'photo' || entry.kind === 'video') && fs.existsSync(entry.path)) viewer.open(entry.id);
  else shell.openPath(entry.path);
});

ipcMain.handle('main-menu', () => {
  const builtIn = [['winamp', t('skinWinamp')], ['chrome', t('skinChrome')], ['luna', t('skinLuna')]];
  const custom = skins.list().map((s) => [s.id, s.name]);
  const skinItem = ([id, label]) => ({ label, type: 'radio', checked: store.get('skin') === id, click: () => applySetting('skin', id) });
  Menu.buildFromTemplate([
    { label: t('pair'), click: () => send('open-pair') },
    { label: t('sendText') + '…', click: () => send('open-text') },
    { label: t('settings') + '…', click: () => send('open-settings') },
    { type: 'separator' },
    {
      label: t('skin'),
      submenu: [
        ...builtIn.map(skinItem),
        ...(custom.length ? [{ type: 'separator' }, ...custom.map(skinItem)] : []),
        { type: 'separator' },
        { label: t('skinsFolder') + '…', click: openSkinsFolder },
      ],
    },
    {
      label: t('language'),
      submenu: [['es', 'Español'], ['en', 'English']].map(([code, label]) => ({
        label, type: 'radio', checked: store.get('lang') === code, click: () => applySetting('lang', code),
      })),
    },
    { type: 'separator' },
    { label: t('miniMode'), type: 'checkbox', checked: viewMode === 'mini', click: () => send('toggle-mini') },
    { label: t('alwaysOnTop'), type: 'checkbox', checked: store.get('alwaysOnTop'), click: (i) => setAlwaysOnTop(i.checked) },
    { label: t('sounds'), type: 'checkbox', checked: store.get('sounds'), click: (i) => applySetting('sounds', i.checked) },
    { type: 'separator' },
    ...(updateReady ? [{ label: t('restartUpdate'), click: installUpdate }] : []),
    { label: t('about') + '…', click: () => send('open-settings', 'about') },
    { label: t('trayQuit'), click: quit },
  ]).popup({ window: win });
});

function applySetting(key, value) {
  store.set(key, value);
  if (key === 'skin' || key === 'lang') server.settingsChanged();
  refreshTrayMenu();
  send('settings', settings());
}

ipcMain.handle('win', (_e, action, arg) => {
  if (action === 'minimize') win.minimize();
  else if (action === 'close') win.close();
  else if (action === 'mode') setViewMode(['normal', 'shade', 'mini'].includes(arg?.mode) ? arg.mode : 'normal', Number(arg?.height) || 180);
});

// ───────────── visor ─────────────
ipcMain.handle('viewer-state', () => ({
  items: viewer.list(), settings: settings(), customSkins: customSkins(), thumbBase: pathToFileURL(thumbsDir()).href + '/',
}));
ipcMain.handle('viewer-src', (_e, id) => viewer.source(id));
ipcMain.handle('viewer-win', (_e, action) => viewer.control(action));
ipcMain.handle('viewer-file', (_e, action, id) => {
  const item = viewer.list().find((i) => i.id === id);
  if (!item) return;
  if (action === 'open') shell.openPath(item.path);
  else if (action === 'show') shell.showItemInFolder(item.path);
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
