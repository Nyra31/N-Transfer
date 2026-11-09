'use strict';
// mDNS/Bonjour: anuncia este PC como _ntransfer._tcp y descubre otros PCs con N-Transfer en la red
// (para que el móvil pueda enviar a varios PCs y para las futuras apps nativas).
let bonjour = null;
let browser = null;
const peers = new Map(); // id → {id, name, host, ip, port, version}

function advertise({ id, name, port, version }) {
  try {
    const { Bonjour } = require('bonjour-service');
    bonjour = new Bonjour({}, (err) => console.warn('[mdns]', err.message));
    const service = bonjour.publish({
      name: `N-Transfer (${name})`, type: 'ntransfer', port, txt: { api: '1', version, id, label: name }, probe: true,
    });
    // Si el nombre ya existe en la red (p. ej. dos copias abiertas) no debe tumbar la app.
    service.on('error', (err) => console.warn('[mdns]', err.message));
  } catch (e) {
    console.warn('[mdns] no disponible:', e.message);
  }
}

/** Busca otros PCs con N-Transfer. onChange recibe la lista cada vez que aparece o desaparece uno. */
function browse(selfId, onChange) {
  if (!bonjour) return;
  try {
    browser = bonjour.find({ type: 'ntransfer' });
    browser.on('up', (s) => {
      const txt = s.txt || {};
      if (!txt.id || txt.id === selfId) return;
      const ip = (s.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a) && !a.startsWith('127.'));
      if (!ip) return;
      peers.set(txt.id, { id: txt.id, name: txt.label || s.name, host: s.host, ip, port: s.port, version: txt.version || '' });
      onChange([...peers.values()]);
    });
    browser.on('down', (s) => {
      const id = s.txt?.id;
      if (id && peers.delete(id)) onChange([...peers.values()]);
    });
  } catch (e) {
    console.warn('[mdns] búsqueda no disponible:', e.message);
  }
}

function list() {
  return [...peers.values()];
}

function stop() {
  if (!bonjour) return;
  // Referencia local: el callback llega después de que la variable global se haya limpiado.
  const instance = bonjour;
  bonjour = null;
  try {
    browser?.stop();
  } catch {
    /* ignorar */
  }
  browser = null;
  try {
    instance.unpublishAll(() => {
      try {
        instance.destroy();
      } catch {
        /* el socket ya puede estar cerrado al salir */
      }
    });
  } catch {
    /* ignorar */
  }
}

module.exports = { advertise, browse, list, stop };
