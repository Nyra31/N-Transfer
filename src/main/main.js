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
const diagnostics = require('./diagnostics');
const { getLanIPs } = require('../core/net');
const i18n = require('../shared/i18n');

const SRC = path.join(__dirname, '..');
const ICON = path.join(SRC, 'assets', 'icon.png');
const TRAY_ICON = path.join(SRC, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
const WIDTH = 480;
const MINI_WIDTH = 340;

if (process.env.NT_USER_DATA) app.setPath('userData', process.env.NT_USER_DATA);
const log = require('./log');
log.init(path.join(app.getPath('userData'), 'logs'));
// Un error inesperado se registra en vez de cerrar la app con un diálogo de error.
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Segunda copia (p. ej. «Enviar a → N-Transfer» con la app ya abierta): se reenvían sus archivos.
  app.on('second-instance', (_e, argv) => {
    showWindow();
    handleSendArgs(argv);
  });
  // macOS: clic en el icono del Dock con la ventana oculta
  app.on('activate', () => showWindow());
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
let updateAvailable = null; // macOS sin firmar: se avisa y se descarga a mano
const RELEASES_URL = 'https://github.com/Nyra31/N-Transfer/releases/latest';
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
    scale: 1, // 1 · 1.5 · 2 (tamaño doble)
    vizMode: 'bars', // bars · scope · off
    pcName: '',
    preferredIp: '',
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
    peers: () => mdns.list(),
  });
  wireServerEvents();
  log.info(`N-Transfer ${app.getVersion()} · ${process.platform} ${process.arch} · Electron ${process.versions.electron}`);
  try {
    await server.start();
    log.info(`servidor en el puerto ${server.port} · IP ${server.ip} · ${server.mdnsHost}`);
    mdns.advertise({ id: server.pcId, name: server.pcLabel, port: server.port, version: app.getVersion() });
    mdns.browse(server.pcId, () => {});
  } catch (e) {
    serverError = e.code === 'EADDRINUSE' ? t('serverError', { port: server.port }) : e.message;
    log.error('no se pudo arrancar el servidor:', e.code || '', e.message);
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
  handleSendArgs(process.argv);

  if (process.env.NT_SHOTS) require('./devshots')({ app, win, server, store, send, viewer, settings });
}

// ───────────── «Enviar a → N-Transfer» ─────────────
/** Rutas que vienen detrás de --send (archivos o carpetas elegidos en el Explorador). */
function handleSendArgs(argv) {
  if (!argv.includes('--send') || !server) return;
  // Chromium puede reordenar los argumentos (los «--algo» van primero), así que no basta con mirar lo que
  // va detrás de --send: se toman todas las rutas que existen salvo el propio programa y la carpeta de la app.
  const own = new Set([process.execPath, app.getAppPath(), path.resolve('.')].map((p) => path.resolve(p).toLowerCase()));
  const paths = argv.slice(1).filter((p) => !p.startsWith('-') && fs.existsSync(p) && !own.has(path.resolve(p).toLowerCase()));
  if (!paths.length) return;
  server.addToOutbox(paths);
  showWindow();
  pendingTab = 'outbox'; // por si la interfaz aún no ha cargado
  send('show-tab', 'outbox');
}
let pendingTab = null;

// ───────────── ventana ─────────────
const scale = () => store.get('scale') || 1;

function createWindow() {
  const b = store.get('bounds') || {};
  fullHeight = b.height || 620;
  win = new BrowserWindow({
    width: b.width || Math.round(WIDTH * scale()),
    height: fullHeight,
    x: b.x,
    y: b.y,
    minWidth: Math.round(420 * scale()),
    minHeight: Math.round(420 * scale()),
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
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(scale()));

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

/**
 * normal: ventana completa · shade: título + LCD · mini: LCD diminuta.
 * `height` llega en píxeles CSS desde la interfaz; aquí se multiplica por el tamaño (1x, 1.5x, 2x).
 */
function setViewMode(mode, height) {
  const s = scale();
  const { width } = win.getBounds();
  if (viewMode === 'normal' && mode !== 'normal') store.set('normalWidth', width);
  viewMode = mode;
  store.set('viewMode', mode);
  if (mode === 'normal') {
    win.setResizable(true);
    win.setMinimumSize(Math.round(420 * s), Math.round(420 * s));
    win.setSize(store.get('normalWidth') || Math.round(WIDTH * s), fullHeight);
  } else {
    const h = Math.round(height * s);
    const w = mode === 'mini' ? Math.round(MINI_WIDTH * s) : width;
    win.setResizable(true);
    win.setMinimumSize(mode === 'mini' ? w : Math.round(420 * s), h);
    win.setSize(w, h);
    win.setResizable(false);
  }
}

/** Tamaño doble (o 1,5x): zoom de la interfaz y ventana proporcional. */
function setScale(next) {
  const prev = scale();
  if (![1, 1.5, 2].includes(next) || next === prev) return;
  store.set('scale', next);
  const k = next / prev;
  fullHeight = Math.round(fullHeight * k);
  if (store.get('normalWidth')) store.set('normalWidth', Math.round(store.get('normalWidth') * k));
  win.webContents.setZoomFactor(next);
  if (viewMode === 'normal') {
    const { width, height } = win.getBounds();
    win.setMinimumSize(Math.round(420 * next), Math.round(420 * next));
    win.setSize(Math.round(width * k), Math.round(height * k));
  }
  send('settings', settings()); // la interfaz recalcula el modo plegado/mini con el nuevo tamaño
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
    ...(updateAvailable ? [{ label: t('downloadUpdate', { version: updateAvailable }), click: () => shell.openExternal(RELEASES_URL) }] : []),
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
  server.on('lan-contact', (c) => send('lan-contact', c));
  server.on('disk-full', (e) => {
    log.warn(`sin espacio para ${e.name}: hacen falta ${e.size} bytes, libres ${e.free} en ${e.dir}`);
    send('disk-full', e);
    if ((!win.isVisible() || win.isMinimized()) && Notification.isSupported()) {
      new Notification({ title: t('diskFullTitle'), body: t('diskFull', { name: e.name, free: i18n.formatSize(e.free) }), icon: ICON }).show();
    }
  });
  server.on('device-paired', (d) => log.info(`dispositivo emparejado: ${d.name} (${d.platform})`));
  server.on('transfer-done', (e) => log.info(`${e.direction === 'in' ? 'recibido' : 'enviado'}: ${e.name} (${e.size} bytes) · ${e.device}${e.convertError ? ' · error HEIC: ' + e.convertError : ''}`));
  server.on('transfer-error', (e) => log.warn(`transferencia fallida ${e.id}: ${e.error}`));
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
    scale: scale(),
    vizMode: store.get('vizMode'),
    pcName: store.get('pcName'),
    pcLabel: server.pcLabel,
    preferredIp: store.get('preferredIp'),
    ips: getLanIPs(),
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
  history: server.history(),
  active: server.activeTransfers(),
  startTab: (() => {
    const tab = pendingTab;
    pendingTab = null;
    return tab;
  })(),
  stats: server.stats(),
  customSkins: customSkins(),
  thumbBase: pathToFileURL(thumbsDir()).href + '/',
  version: app.getVersion(),
  platform: process.platform,
  serverError,
  updateReady,
  updateAvailable,
  firstRun: server.devices().length === 0,
}));

const BOOL_SETTINGS = new Set(['closeToTray', 'sounds', 'autoCopyText', 'splitByType']);
ipcMain.handle('set', (_e, key, value) => {
  if (key === 'skin' && skins.has(value)) applySetting('skin', value);
  else if (key === 'lang' && i18n.LANGS.includes(value)) applySetting('lang', value);
  else if (key === 'heicMode' && ['original', 'both', 'jpg'].includes(value)) applySetting('heicMode', value);
  else if (BOOL_SETTINGS.has(key)) applySetting(key, !!value);
  else if (key === 'autostart') setAutostart(!!value);
  else if (key === 'alwaysOnTop') setAlwaysOnTop(!!value);
  else if (key === 'scale') setScale(Number(value));
  else if (key === 'vizMode' && ['bars', 'scope', 'off'].includes(value)) applySetting('vizMode', value);
  else if (key === 'preferredIp' && (value === '' || getLanIPs().includes(value))) {
    store.set('preferredIp', value);
    send('settings', settings());
    pairInfo().then((p) => send('pair', p));
  } else if (key === 'pcName') {
    store.set('pcName', String(value || '').trim().slice(0, 40));
    // Se vuelve a anunciar en la red con el nombre nuevo
    mdns.stop();
    mdns.advertise({ id: server.pcId, name: server.pcLabel, port: server.port, version: app.getVersion() });
    mdns.browse(server.pcId, () => {});
    send('settings', settings());
  }
});

// ───────────── varias entradas del historial a la vez ─────────────
ipcMain.handle('entries', async (_e, action, ids) => {
  const entries = server.history().filter((h) => ids.includes(h.id));
  const withFile = entries.filter((h) => h.path && h.kind !== 'text' && fs.existsSync(h.path));
  if (action === 'open') {
    const media = withFile.filter((h) => h.kind === 'photo' || h.kind === 'video');
    if (media.length) viewer.open(media[0].id);
    for (const h of withFile.filter((x) => !media.includes(x)).slice(0, 10)) shell.openPath(h.path);
  } else if (action === 'show') {
    if (withFile[0]) shell.showItemInFolder(withFile[0].path);
  } else if (action === 'remove') {
    server.removeHistory(ids);
  } else if (action === 'trash') {
    // Solo lo recibido (lo enviado al móvil sigue siendo un archivo tuyo del PC)
    const received = withFile.filter((h) => h.direction === 'in');
    if (!received.length) return;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: [t('trashConfirmYes'), t('cancel')], defaultId: 1, cancelId: 1,
      title: 'N-Transfer', message: t('trashConfirm', { n: received.length }),
    });
    if (response !== 0) return;
    for (const h of received) {
      await shell.trashItem(h.path).catch(() => {});
      if (h.extra?.path) await shell.trashItem(h.extra.path).catch(() => {});
    }
    server.removeHistory(received.map((h) => h.id));
  }
});

// Arrastrar desde la lista a otra carpeta o aplicación
ipcMain.on('drag-out', (e, ids) => {
  const files = server.history()
    .filter((h) => Array.isArray(ids) && ids.includes(h.id) && h.path && h.kind !== 'text' && fs.existsSync(h.path));
  if (!files.length) return;
  let icon = files[0].thumb ? nativeImage.createFromPath(path.join(thumbsDir(), files[0].thumb)) : null;
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(ICON);
  icon = icon.resize({ width: 64 });
  e.sender.startDrag({ file: files[0].path, files: files.map((h) => h.path), icon });
});

// ───────────── asistente «No conecta» ─────────────
ipcMain.handle('diagnostics', () => diagnostics.runChecks({ server, serverError, exePath: process.execPath }));
ipcMain.handle('firewall-add', () => diagnostics.addFirewallRule(process.execPath));
ipcMain.handle('open-network-settings', () => process.platform === 'win32' && shell.openExternal('ms-settings:network-status'));

// ───────────── editor de skins ─────────────
ipcMain.handle('skin-save', (_e, { id, name, css }) => {
  const clean = String(name || '').trim().slice(0, 40) || 'Mi skin';
  const slug = id && /^[a-z0-9-]+$/.test(id) ? id
    : clean.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skin';
  let finalId = slug;
  if (!id) for (let n = 2; skins.has(finalId); n++) finalId = `${slug}-${n}`;
  fs.mkdirSync(skins.dir, { recursive: true });
  fs.writeFileSync(path.join(skins.dir, `${finalId}.css`), String(css).replace(/\.skin-__ID__/g, `.skin-${finalId}`));
  skins.rescan();
  applySetting('skin', finalId);
  return finalId;
});
ipcMain.handle('skin-delete', async (_e, id) => {
  const skin = skins.list().find((s) => s.id === id);
  if (!skin) return;
  await shell.trashItem(skin.file).catch(() => fs.rmSync(skin.file, { force: true }));
  if (store.get('skin') === id) store.set('skin', 'winamp');
  skins.rescan();
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
ipcMain.handle('outbox-pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
  if (!r.canceled) await server.addToOutbox(r.filePaths);
});
ipcMain.handle('outbox-text', (_e, text) => server.addTextToOutbox(text));
ipcMain.handle('outbox-remove', (_e, id) => server.removeFromOutbox(id));
ipcMain.handle('outbox-clear', () => server.clearOutbox());
ipcMain.handle('device-forget', (_e, id) => server.forgetDevice(id));
ipcMain.handle('pair-new', () => {
  server.newPairCode();
});
// La ventana «Emparejar» abre el emparejamiento mientras está visible (la interfaz lo renueva cada pocos minutos).
ipcMain.handle('pairing', (_e, open) => server.setPairing(!!open));
ipcMain.handle('open-log', () => log.file && shell.openPath(log.file));
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
    { label: t('noConnect') + '…', click: () => send('open-diag') },
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
    { label: t('doubleSize'), type: 'checkbox', accelerator: 'CmdOrCtrl+D', checked: scale() === 2, click: () => setScale(scale() === 2 ? 1 : 2) },
    { label: t('alwaysOnTop'), type: 'checkbox', checked: store.get('alwaysOnTop'), click: (i) => setAlwaysOnTop(i.checked) },
    { label: t('sounds'), type: 'checkbox', checked: store.get('sounds'), click: (i) => applySetting('sounds', i.checked) },
    { type: 'separator' },
    ...(updateReady ? [{ label: t('restartUpdate'), click: installUpdate }] : []),
    ...(updateAvailable ? [{ label: t('downloadUpdate', { version: updateAvailable }), click: () => shell.openExternal(RELEASES_URL) }] : []),
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
    // macOS solo deja instalar actualizaciones de apps firmadas por Apple: sin firma se avisa y se descarga a mano.
    const manual = process.platform === 'darwin';
    autoUpdater.autoDownload = !manual;
    autoUpdater.on('update-available', (info) => {
      log.info(`actualización disponible: ${info.version}`);
      if (!manual) return;
      updateAvailable = info.version;
      send('update-available', { version: info.version, url: RELEASES_URL });
      refreshTrayMenu();
    });
    autoUpdater.on('update-downloaded', (info) => {
      log.info(`actualización descargada: ${info.version}`);
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
