// Lanza Electron sin ELECTRON_RUN_AS_NODE (VS Code y otras herramientas la definen y Electron arrancaría como Node).
// Uso: node scripts/electron.js [args...]   — variables extra se heredan del entorno.
const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron');

function runElectron(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, args, { cwd: path.join(__dirname, '..'), stdio: 'inherit', env });
  return r.status ?? 1;
}

module.exports = { runElectron };
if (require.main === module) process.exit(runElectron(process.argv.slice(2)));
