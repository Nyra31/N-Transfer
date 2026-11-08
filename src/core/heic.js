'use strict';
// Conversión HEIC → JPG en un hilo aparte (una cola, un hilo: la conversión usa mucha memoria).
const { Worker } = require('worker_threads');
const path = require('path');

let worker = null;
let seq = 0;
const pending = new Map();

// En la app instalada el código está dentro de app.asar; el hilo se carga desde la copia desempaquetada.
const workerPath = () => path.join(__dirname, 'heic-worker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function getWorker() {
  if (worker) return worker;
  worker = new Worker(workerPath());
  worker.on('message', ({ id, ok, error }) => {
    const p = pending.get(id);
    pending.delete(id);
    if (!p) return;
    if (ok) p.resolve();
    else p.reject(new Error(error));
  });
  const fail = (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    worker = null;
  };
  worker.on('error', fail);
  worker.on('exit', (code) => code !== 0 && fail(new Error('heic worker exit ' + code)));
  worker.unref();
  return worker;
}

/** Convierte un HEIC/HEIF a JPG. */
function convertHeic(input, output, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, input, output, quality });
  });
}

function stop() {
  if (worker) worker.terminate();
  worker = null;
}

module.exports = { convertHeic, stop };
