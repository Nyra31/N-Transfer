'use strict';
// Hilo de trabajo: decodificar HEIC es lento (WebAssembly) y bloquearía el servidor si se hiciera en el hilo principal.
const { parentPort } = require('worker_threads');
const fs = require('fs/promises');
const convert = require('heic-convert');

parentPort.on('message', async ({ id, input, output, quality }) => {
  try {
    const buffer = await fs.readFile(input);
    const jpg = await convert({ buffer, format: 'JPEG', quality });
    await fs.writeFile(output, Buffer.from(jpg));
    parentPort.postMessage({ id, ok: true });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message || String(e) });
  }
});
