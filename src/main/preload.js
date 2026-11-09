'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNELS = new Set([
  'state', 'set', 'pick-folder', 'reset-folder', 'outbox-add', 'outbox-pick', 'outbox-pick-folder', 'outbox-text',
  'outbox-remove', 'outbox-clear', 'device-forget', 'pair-new', 'open-folder', 'item-menu', 'open-entry', 'entries',
  'main-menu', 'win', 'history-clear', 'stats-reset', 'update-install', 'open-external', 'clipboard-read',
  'clipboard-write', 'transfer', 'skins-folder', 'skin-save', 'skin-delete', 'diagnostics', 'firewall-add',
  'open-network-settings', 'viewer-state', 'viewer-src', 'viewer-win', 'viewer-file',
]);

contextBridge.exposeInMainWorld('nt', {
  invoke(channel, ...args) {
    if (!CHANNELS.has(channel)) throw new Error('canal no permitido: ' + channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  on(callback) {
    ipcRenderer.on('evt', (_e, name, payload) => callback(name, payload));
  },
  pathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  /** Arrastrar entradas del historial fuera de la ventana (arrastre nativo del sistema). */
  startDrag(ids) {
    ipcRenderer.send('drag-out', ids);
  },
});
