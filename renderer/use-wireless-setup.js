import { useEffect, useRef, useState } from 'react';
import { getLocale } from './i18n.jsx';

const request = (action, args = {}) => window.workbench.call('ui_wireless_setup', { action, ...args });
const cancelRemote = (action, id) => { if (id) request(action, { id }).catch(() => {}); };
const displayError = e => e.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');

// All callbacks belong to this mounted panel and generation. In particular a
// late connection/phone-share response must not reopen the guide after a reset or exit.
export function useWirelessSetup({ discover, connected }) {
  const [session, setSession] = useState(null), [helper, setHelper] = useState(null);
  const [peers, setPeers] = useState([]), [working, setWorking] = useState(false), [error, setError] = useState('');
  const [qr, setQr] = useState(null);
  const scope = useRef({ generation: 0, scan: 0 }), onConnected = useRef(connected);
  onConnected.current = connected;
  function dispose() {
    const owner = scope.current;
    owner.generation++; owner.scan++; owner.discoveredUntil = 0;
    cancelRemote('cancel', owner.id); cancelRemote('stopHelper', owner.share);
    if (owner.qr) window.workbench.call('aiui_adb_pair_qr', { action: 'cancel', id: owner.qr }).catch(() => {});
    owner.qr = null;
    owner.id = null; owner.share = null; owner.busy = false;
  }
  function clear() {
    dispose(); setSession(null); setHelper(null); setQr(null); setError(''); setWorking(false); setPeers([]);
  }
  useEffect(() => dispose, []);
  const discoverPeers = discover && (!session || ['prepare', 'needCode'].includes(session.stage)) && !helper;
  useEffect(() => {
    if (!discoverPeers) { setPeers([]); return; }
    const owner = scope.current;
    let active = true, timer;
    async function scan() {
      const ticket = ++owner.scan;
      if (!document.hidden) {
        try {
          const result = await request('candidates');
          const nearby = result.services.filter(s => s.source === 'neighbor');
          if (active && owner.scan === ticket && (nearby.length || Date.now() >= (owner.discoveredUntil || 0))) setPeers(nearby);
        } catch { if (active && owner.scan === ticket) setPeers([]); }
      }
      if (active) timer = setTimeout(scan, 15000);
    }
    scan();
    return () => { active = false; clearTimeout(timer); };
  }, [discoverPeers]);

  function apply(value) {
    if (value.stage === 'cancelled') { setSession(null); return; }
    if (value.stage === 'choose') {
      // A directed probe can find an endpoint even when its OS neighbor entry
      // is not yet visible to the next passive refresh.
      scope.current.discoveredUntil = Date.now() + 12000;
      setPeers(value.services); setSession(null); return;
    }
    scope.current.id = value.id;
    setSession(value);
    if (value.stage === 'connected') {
      onConnected.current(value.serial);
      cancelRemote('cancel', value.id);
      setSession(null); scope.current.id = null;
    }
  }
  async function beginShare(owner, generation) {
    setSession({ stage: 'preparingHelper' });
    const share = await request('helper', { locale: getLocale() });
    if (generation !== owner.generation) { cancelRemote('stopHelper', share.id); return; }
    owner.share = share.id; setSession(null); setHelper(share);
  }
  async function start(address) {
    const owner = scope.current;
    if (owner.busy) return;
    clear();
    const generation = owner.generation;
    setSession({ stage: address ? 'connecting' : 'searching' });
    owner.busy = true; setWorking(true);
    try {
      let result = await request('start', address ? { address } : {});
      if (generation !== owner.generation) { cancelRemote('cancel', result.id); return; }
      if (result.stage === 'choose' && result.services.length === 1 && result.services[0].type !== 'pairing') {
        // Leaving the setup page while the scan is in flight cancels this click.
        setSession({ stage: 'connecting' });
        result = await request('start', { address: result.services[0].address });
        if (generation !== owner.generation) { cancelRemote('cancel', result.id); return; }
      }
      if (result.stage === 'prepare') await beginShare(owner, generation);
      else apply(result);
    } catch (e) { if (generation === owner.generation) { setSession({ stage: 'prepare' }); setError(displayError(e)); } }
    finally { if (generation === owner.generation) { owner.busy = false; setWorking(false); } }
  }
  const id = session?.id, stage = session?.stage;
  useEffect(() => {
    if (!id || stage !== 'authorize' || helper) return;
    const generation = scope.current.generation;
    let active = true, timer;
    async function poll() {
      try {
        const value = await request('poll', { id });
        if (active && scope.current.generation === generation) { setError(''); apply(value); }
      } catch (e) { if (active && scope.current.generation === generation) setError(displayError(e)); }
      if (active) timer = setTimeout(poll, 1500);
    }
    timer = setTimeout(poll, 900);
    return () => { active = false; clearTimeout(timer); };
  }, [id, stage, helper]);

  async function openHelper() {
    clear();
    const owner = scope.current, generation = owner.generation;
    owner.busy = true; setWorking(true);
    try { await beginShare(owner, generation); }
    catch (e) { if (generation === owner.generation) { setSession({ stage: 'prepare' }); setError(displayError(e)); } }
    finally { if (generation === owner.generation) { owner.busy = false; setWorking(false); } }
  }
  const shareId = helper?.id;
  useEffect(() => {
    if (!shareId) return;
    let active = true, timer;
    async function check() {
      try {
        const state = await request('helperStatus', { id: shareId, locale: getLocale() });
        if (!active) return;
        if (state.stage === 'expired') {
          setHelper(previous => previous?.id === shareId ? { ...previous, id: null, stage: previous.stage === 'sent' ? 'sent' : 'expired', urls: [], expired: true } : previous);
          return;
        }
        setHelper(previous => previous?.id === shareId && previous.stage !== state.stage ? { ...previous, stage: state.stage } : previous);
      } catch { /* Transient UI disconnects are retried until the share expires. */ }
      if (active) timer = setTimeout(check, 1500);
    }
    const expiry = setTimeout(() => {
      if (active) setHelper(previous => previous?.id === shareId ? { ...previous, id: null, stage: previous.stage === 'sent' ? 'sent' : 'expired', urls: [], expired: true } : previous);
    }, Math.max(0, helper.expiresAt - Date.now()));
    timer = setTimeout(check, 900);
    return () => { active = false; clearTimeout(timer); clearTimeout(expiry); };
  }, [shareId, helper?.expiresAt]);
  async function useQr() {
    clear();
    const owner = scope.current, generation = owner.generation;
    owner.busy = true; setWorking(true); setSession({ stage: 'qr' });
    try {
      const value = await window.workbench.call('aiui_adb_pair_qr', { action: 'start' });
      if (generation !== owner.generation) { window.workbench.call('aiui_adb_pair_qr', { action: 'cancel', id: value.id }).catch(() => {}); return; }
      owner.qr = value.id; setQr(value);
    } catch (e) { if (generation === owner.generation) setError(displayError(e)); }
    finally { if (generation === owner.generation) { owner.busy = false; setWorking(false); } }
  }
  const qrId = qr?.id;
  useEffect(() => {
    if (!qrId) return;
    const owner = scope.current, generation = owner.generation;
    let active = true, timer;
    async function poll() {
      try {
        const value = await window.workbench.call('aiui_adb_pair_qr', { action: 'status', id: qrId });
        if (!active || generation !== owner.generation) return;
        setQr(previous => ({ ...value, qrDataUrl: value.stage === 'waiting' ? previous.qrDataUrl : undefined }));
        if (value.connected) { onConnected.current(value.serial); clear(); return; }
        if (!['waiting', 'pairing'].includes(value.stage)) return;
      } catch (e) { if (active && generation === owner.generation) setError(displayError(e)); }
      if (active) timer = setTimeout(poll, 1500);
    }
    timer = setTimeout(poll, 800);
    return () => { active = false; clearTimeout(timer); };
  }, [qrId]);
  function useCode() { clear(); setSession({ stage: 'codeEntry' }); }
  return { peers, session, helper, qr, working, error, start, clear, openHelper, useCode, useQr, showError: setError };
}
