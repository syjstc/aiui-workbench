import os from 'node:os';
import fs from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { run } from './util.mjs';

// Prefer an actual LAN gateway. A VPN or VM can install another default route
// through a point-to-point link. The adapter name itself is not a reliable clue.
export function gatewayAdapters(platform, output) {
  const matches = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (platform === 'darwin' && fields[0] === 'default' && isIPv4(fields[1]) && fields[2]?.includes('G')) {
      matches.push({ id: fields[3], metric: 0 });
    } else if (platform === 'linux' && fields[1] === '00000000' && /^[0-9a-f]{8}$/i.test(fields[2]) && fields[2] !== '00000000' && (parseInt(fields[3], 16) & 3) === 3) {
      matches.push({ id: fields[0], metric: Number(fields[6]) });
    } else if (platform === 'win32' && fields[0] === '0.0.0.0' && fields[1] === '0.0.0.0' && isIPv4(fields[2]) && isIPv4(fields[3])) {
      matches.push({ id: fields[3], metric: Number(fields[4]) });
    }
  }
  return [...new Set(matches.sort((a, b) => a.metric - b.metric).map(x => x.id))];
}

export async function networkInterfacesByRoute() {
  const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
    (entries || []).filter(e => !e.internal).map(e => ({ ...e, name })));
  let output = '';
  try {
    if (process.platform === 'linux') output = await fs.readFile('/proc/net/route', 'utf8');
    else if (process.platform === 'darwin') output = (await run('/usr/sbin/netstat', ['-rn', '-f', 'inet'], { timeout: 2000 })).output;
    else if (process.platform === 'win32') output = (await run('route.exe', ['print', '-4'], { timeout: 2000 })).output;
  } catch { /* All active addresses remain available when routing information is unavailable. */ }
  const routes = gatewayAdapters(process.platform, output);
  const routeNames = routes.map(id => interfaces.find(e => e.address === id || e.name === id)?.name);
  return interfaces.map(e => ({ ...e, route: routeNames.indexOf(e.name) }))
    .sort((a, b) => (a.route < 0 ? Infinity : a.route) - (b.route < 0 ? Infinity : b.route) ||
      Number(b.family === 'IPv4') - Number(a.family === 'IPv4'));
}
