'use strict';
// Anuncia el servicio _ntransfer._tcp en la red para que las futuras apps nativas
// (iOS/Android) puedan descubrir el PC sin escanear la IP.
let bonjour = null;

function advertise({ name, port, version }) {
  try {
    const { Bonjour } = require('bonjour-service');
    bonjour = new Bonjour();
    bonjour.publish({ name: `N-Transfer (${name})`, type: 'ntransfer', port, txt: { api: '1', version } });
  } catch (e) {
    console.warn('[mdns] no disponible:', e.message);
  }
}

function stop() {
  if (!bonjour) return;
  try {
    bonjour.unpublishAll(() => bonjour.destroy());
  } catch {
    /* ignorar */
  }
  bonjour = null;
}

module.exports = { advertise, stop };
