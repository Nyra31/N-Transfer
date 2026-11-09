'use strict';
/**
 * Registro de N-Transfer: un archivo de texto en la carpeta de datos (logs/n-transfer.log), con rotación.
 * Sirve para saber qué ha pasado cuando algo falla en otro PC: Acerca de → «Abrir registro».
 * Nunca se registran tokens ni el contenido de los archivos o textos.
 */
const fs = require('fs');
const path = require('path');

const MAX_SIZE = 1024 * 1024; // al pasar de 1 MB, el actual pasa a .old y se empieza otro
let file = null;

function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'n-transfer.log');
  // Lo que se escribía por consola también va al archivo
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      write(level === 'log' ? 'INFO' : level.toUpperCase(), args);
    };
  }
  return file;
}

function format(args) {
  return args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
}
function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function write(level, args) {
  if (!file) return;
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && st.size > MAX_SIZE) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, `${new Date().toISOString()} ${level.padEnd(5)} ${format(args)}\n`);
  } catch {
    /* el registro nunca debe tumbar la app */
  }
}

module.exports = {
  init,
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  get file() { return file; },
};
