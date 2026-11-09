'use strict';
/**
 * Asistente «No conecta»: comprobaciones de red para cuando el móvil no llega al PC.
 * Las de firewall y perfil de red solo existen en Windows; en macOS/Linux se omiten.
 */
const { execFile } = require('child_process');
const dns = require('dns').promises;
const os = require('os');
const { getLanIPs } = require('../core/net');

const RULE_NAME = 'N-Transfer';

function powershell(script, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

const parseJson = (s) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : v ? [v] : [];
  } catch {
    return [];
  }
};

/** Perfil de cada red conectada: Public / Private / DomainAuthenticated. */
async function networkProfiles() {
  const out = await powershell('Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress');
  return parseJson(out).map((p) => ({
    name: p.Name, iface: p.InterfaceAlias, category: ['Public', 'Private', 'DomainAuthenticated'][p.NetworkCategory] ?? String(p.NetworkCategory),
  }));
}

/** Reglas de entrada que afectan al ejecutable de N-Transfer (o se llaman «N-Transfer»). */
async function firewallRules(exePath) {
  const exe = exePath.replace(/'/g, "''");
  const script = `
    $exe = '${exe}'
    $rules = @()
    $rules += Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -eq $exe } | Get-NetFirewallRule -ErrorAction SilentlyContinue
    $rules += Get-NetFirewallRule -DisplayName '${RULE_NAME}' -ErrorAction SilentlyContinue
    $rules | Where-Object { $_.Direction -eq 'Inbound' } | Sort-Object -Property Name -Unique |
      Select-Object DisplayName,Enabled,Action,Profile | ConvertTo-Json -Compress`;
  const out = await powershell(script, 25000);
  if (out === null) return null;
  return parseJson(out).map((r) => ({
    name: r.DisplayName,
    enabled: r.Enabled === 1 || r.Enabled === true || r.Enabled === 'True',
    action: r.Action === 2 || r.Action === 'Allow' ? 'allow' : 'block',
    profile: Number(r.Profile), // bits: 1 dominio, 2 privada, 4 pública (0 = todos)
  }));
}

const PROFILE_BIT = { DomainAuthenticated: 1, Private: 2, Public: 4 };

/**
 * @returns {Promise<{id:string, status:'ok'|'warn'|'error'|'info', data?:object}[]>}
 */
async function runChecks({ server, serverError, exePath }) {
  const checks = [];
  const ips = getLanIPs();
  const port = server.port;

  checks.push(serverError ? { id: 'server', status: 'error', data: { error: serverError, port } } : { id: 'server', status: 'ok', data: { port } });

  if (ips[0] === '127.0.0.1') checks.push({ id: 'ip', status: 'error', data: {} });
  else checks.push({ id: 'ip', status: ips.length > 1 ? 'warn' : 'ok', data: { ip: server.ip, all: ips } });

  if (process.platform === 'win32') {
    const [profiles, rules] = await Promise.all([networkProfiles(), firewallRules(exePath)]);
    const isPublic = profiles.some((p) => p.category === 'Public');
    // Red «Pública» solo es un problema si el firewall no permite N-Transfer en redes públicas.
    const publicAllowed = (rules || []).some((r) => r.enabled && r.action === 'allow' && (r.profile === 0 || (r.profile & 4) !== 0));
    checks.push({
      id: 'profile',
      status: !profiles.length ? 'info' : isPublic && !publicAllowed ? 'warn' : 'ok',
      data: { profiles, isPublic, publicAllowed },
    });

    if (rules === null) {
      checks.push({ id: 'firewall', status: 'info', data: { unknown: true } });
    } else {
      // ¿Qué perfiles están en uso? Si no lo sabemos, comprobamos el privado.
      const used = profiles.length ? profiles.map((p) => PROFILE_BIT[p.category] || 2) : [2];
      const covers = (r, bit) => r.enabled && (r.profile === 0 || (r.profile & bit) !== 0);
      const blocked = used.some((bit) => rules.some((r) => r.action === 'block' && covers(r, bit)));
      const allowed = used.every((bit) => rules.some((r) => r.action === 'allow' && covers(r, bit)));
      checks.push({
        id: 'firewall',
        status: blocked ? 'error' : allowed ? 'ok' : 'warn',
        data: { blocked, allowed, rules },
      });
    }
  }

  const host = server.mdnsHost;
  const resolved = await Promise.race([
    dns.lookup(host, { family: 4 }).then((r) => r.address, () => null),
    new Promise((r) => setTimeout(() => r(null), 3000)),
  ]);
  checks.push({ id: 'mdns', status: resolved ? 'ok' : 'warn', data: { host, resolved } });

  const c = server.lastContact;
  checks.push({ id: 'contact', status: c ? 'ok' : 'warn', data: { contact: c, url: `http://${server.ip}:${port}` } });

  checks.push({ id: 'tips', status: 'info', data: { hostname: os.hostname() } });
  return checks;
}

/** Añade la regla de entrada (pide permisos de administrador con el aviso de Windows). */
async function addFirewallRule(exePath) {
  if (process.platform !== 'win32') return false;
  // Todos los perfiles: Windows marca como «Pública» muchas Wi-Fi de casa. El servidor exige token por dispositivo.
  const args = `advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow program="${exePath}" enable=yes profile=any`;
  const script = `try { $p = Start-Process -FilePath netsh.exe -ArgumentList '${args.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`;
  const ok = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120000 },
      (err) => resolve(!err));
  });
  return ok;
}

module.exports = { runChecks, addFirewallRule, RULE_NAME };
