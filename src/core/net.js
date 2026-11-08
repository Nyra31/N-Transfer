'use strict';
// Utilidades de red multiplataforma: IPs de la LAN y nombre .local (mDNS).
const os = require('os');

const VIRTUAL = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|br-|veth|utun|awdl|llw|tailscale|zerotier/i;

function isPrivate(ip) {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/** IPs IPv4 de la red local, las más probables primero. */
function getLanIPs() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      let score = 0;
      if (isPrivate(a.address)) score += 2;
      if (/^192\.168\./.test(a.address)) score += 1;
      if (/wi-?fi|wlan|wireless|en0/i.test(name)) score += 1;
      if (VIRTUAL.test(name)) score -= 5;
      found.push({ ip: a.address, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found.length ? found.map((f) => f.ip) : ['127.0.0.1'];
}

/** Nombre del equipo en formato mDNS (Windows 10+, macOS y Linux con Avahi lo resuelven). */
function getMdnsHost() {
  const name = os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `${name || 'n-transfer'}.local`;
}

module.exports = { getLanIPs, getMdnsHost };
