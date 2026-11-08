'use strict';
// Arranque con el sistema: Windows/macOS usan la API de Electron; Linux, un .desktop en ~/.config/autostart.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const linuxFile = () => path.join(os.homedir(), '.config', 'autostart', 'n-transfer.desktop');

function set(enabled) {
  if (process.platform === 'linux') {
    if (enabled) {
      fs.mkdirSync(path.dirname(linuxFile()), { recursive: true });
      const exec = process.env.APPIMAGE || process.execPath;
      fs.writeFileSync(linuxFile(),
        `[Desktop Entry]\nType=Application\nName=N-Transfer\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } else {
      fs.rmSync(linuxFile(), { force: true });
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] });
}

function get() {
  if (process.platform === 'linux') return fs.existsSync(linuxFile());
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

module.exports = { set, get };
