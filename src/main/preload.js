'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNELS = new Set([
  'state', 'set', 'pick-folder', 'outbox-add', 'outbox-pick', 'outbox-remove', 'outbox-clear',
  'device-forget', 'pair-new', 'open-folder', 'item-menu', 'main-menu', 'win', 'history-clear',
  'update-install', 'open-external',
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
});
