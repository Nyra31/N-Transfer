// Lanza la app en modo capturas con datos aislados. Uso: npm run shots  → carpeta ./shots
const fs = require('fs');
const path = require('path');
const { runElectron } = require('./electron');

const out = path.join(__dirname, '..', 'shots');
fs.rmSync(out, { recursive: true, force: true });
const status = runElectron(['.'], { NT_SHOTS: out, NT_USER_DATA: path.join(out, 'userdata'), NT_PORT: '47899' });
const report = path.join(out, 'report.txt');
console.log(fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : 'sin informe');
process.exit(status);
