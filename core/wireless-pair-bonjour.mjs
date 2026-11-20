// ADB discovery and the macOS Bonjour daemon can have different views of the
// LAN. Resolve only this QR's exact instance, on the interface that saw it.
import { spawn } from 'node:child_process';
import { isIPv4 } from 'node:net';

function bonjourQuery(args, parse, signal) {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const query = spawn('/usr/bin/dns-sd', args, {stdio:['ignore','pipe','ignore']});
    let output = '', settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      query.kill();
      resolve(result);
    };
    const cancel = () => finish(null);
    const timer = setTimeout(cancel, 2000);
    signal.addEventListener('abort', cancel, {once:true});
    query.once('error', cancel);
    query.once('close', cancel);
    query.stdout.on('data', chunk => {
      output = (output + chunk).slice(-8192);
      const result = parse(output);
      if (result) finish(result);
    });
  });
}

export async function resolvePairingService(name, signal) {
  if (process.platform !== 'darwin') return null;
  const service = await bonjourQuery(['-L', name, '_adb-tls-pairing._tcp', 'local'], output => {
    const line = output.split(' ' + name + '._adb-tls-pairing._tcp.local. can be reached at ')[1];
    const match = line?.match(/^([\w.-]+\.local\.):(\d+) \(interface (\d+)\)/i);
    if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535)
      return {host:match[1],port:match[2],interfaceId:match[3]};
  }, signal);
  if (!service) return null;
  const address = await bonjourQuery(['-i', service.interfaceId, '-G', 'v4', service.host], output => {
    const addresses = new Set();
    for (const line of output.split('\n')) {
      const [,action,flags,iface,host,ip,ttl] = line.trim().split(/\s+/);
      if (iface !== service.interfaceId || host !== service.host || !ttl || !isIPv4(ip)) continue;
      if (action === 'Add') addresses.add(ip);
      if (action === 'Rmv') addresses.delete(ip);
      if (!(parseInt(flags,16) & 1) && addresses.size === 1) return ip;
    }
  }, signal);
  return address ? address + ':' + service.port : null;
}
