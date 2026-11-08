'use strict';
// Anuncia el servicio _ntransfer._tcp en la red para que las futuras apps nativas
// (iOS/Android) puedan descubrir el PC sin escanear la IP.
let bonjour = null;

function advertise({ name, port, version }) {
  try {
    const { Bonjour } = require('bonjour-service');
    bonjour = new Bonjour({}, (err) => console.warn('[mdns]', err.message));
    const service = bonjour.publish({
      name: `N-Transfer (${name})`, type: 'ntransfer', port, txt: { api: '1', version }, probe: true,
    });
    // Si el nombre ya existe en la red (p. ej. dos copias abiertas) no debe tumbar la app.
    service.on('error', (err) => console.warn('[mdns]', err.message));
  } catch (e) {
    console.warn('[mdns] no disponible:', e.message);
  }
}

function stop() {
  if (!bonjour) return;
  // Referencia local: el callback llega después de que la variable global se haya limpiado.
  const instance = bonjour;
  bonjour = null;
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

module.exports = { advertise, stop };
