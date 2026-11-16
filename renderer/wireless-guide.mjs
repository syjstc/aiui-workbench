export function wirelessGuideState(environment, wireless, peers = [], selectedSerial = '') {
  if (!environment) return { stage: 'checking' };
  if (!environment.adb) return { stage: 'tools' };
  const online = environment.devices?.find(d => d.connection === 'wireless' && d.status === 'device');
  if (online) return { stage: 'connected', device: online };
  if (wireless?.server?.state === 'legacy') return { stage: 'repair' };
  const services = (wireless?.services || []).filter(s => !(s.type === 'pairing' && s.name.startsWith('studio-')));
  const pairing = services.filter(s => s.type === 'pairing');
  if (pairing.length && !peers.length && services.every(s => pairing.some(p => p.host === s.host))) return { stage: 'pair', services: pairing };
  const candidates = new Map([...peers, ...services].map(s => [s.address, s]));
  if (candidates.size) return { stage: 'found', services: [...candidates.values()] };
  const usb = (environment.usbDevices || environment.devices || []).filter(d => d.connection === 'usb');
  const selected = usb.find(d => d.serial === selectedSerial) || (usb.length === 1 ? usb[0] : null);
  if (selected?.status === 'device') return { stage: 'enable', device: selected };
  if (selected?.status === 'unauthorized') return { stage: 'usbAuthorize' };
  const saved = wireless?.saved?.find(record => record.address);
  if (saved) return { stage: 'reconnect', record: saved };
  return { stage: 'start' };
}
