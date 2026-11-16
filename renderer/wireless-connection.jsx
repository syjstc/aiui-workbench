import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Cable, CheckCircle2, LoaderCircle, Trash2, Wifi } from 'lucide-react';
import { t, translateMessage } from './i18n.jsx';
import { wirelessGuideState } from './wireless-guide.mjs';
import { WirelessSetupGuide } from './wireless-setup-guide.jsx';
import { useWirelessSetup } from './use-wireless-setup.js';

export function WirelessConnection({ discovery, onConnected, onReset, serial, busy: deviceBusy }) {
  const id = useId();
  const [mode, setMode] = useState('discover');
  const [wireless, setWireless] = useState(discovery.environment?.wireless);
  const [working, setWorking] = useState(false), [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [revokeAuthorization, setRevokeAuthorization] = useState(false);
  const [pairAddress, setPairAddress] = useState(''), [code, setCode] = useState(''), [address, setAddress] = useState(''), [connectAddress, setConnectAddress] = useState(''), [usbSerial, setUsbSerial] = useState('');
  const usb = (discovery.environment?.usbDevices || discovery.environment?.devices || []).filter(device => device.connection === 'usb' && device.status === 'device');
  const online = discovery.environment?.devices?.some(d => d.connection === 'wireless' && d.status === 'device');
  const setup = useWirelessSetup({
    discover: !!discovery.environment?.adb && !advancedOpen && !online && wireless?.server?.state !== 'legacy',
    connected: serial => { onConnected(serial); setAdvancedOpen(false); setMessage(''); discovery.refresh?.(); },
  });
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) setup.clear();
    wasOnline.current = online;
  }, [online]);
  const busy = working || deviceBusy || wireless?.busy || setup.working;
  const services = (wireless?.services || []).filter(s => !(s.type === 'pairing' && s.name.startsWith('studio-')));
  const pairing = services.filter(s => s.type === 'pairing');
  const guide = wirelessGuideState(discovery.environment, wireless, setup.peers, usbSerial);
  useEffect(() => { setWireless(discovery.environment?.wireless); }, [discovery.environment]);
  useEffect(() => {
    if (usb.length === 1) setUsbSerial(usb[0].serial);
    else if (!usb.some(device => device.serial === usbSerial)) setUsbSerial('');
  }, [discovery.environment, usbSerial]);
  useEffect(() => {
    if (mode === 'pair' && !pairAddress && pairing.length === 1) setPairAddress(pairing[0].address);
  }, [mode, services, pairAddress]);

  async function run(tool, args = {}) {
    if (tool === 'aiui_adb_reset') setup.clear();
    setWorking(true); setMessage(''); setFailed(false);
    try {
      const result = await window.workbench.call(tool, args);
      if (tool === 'aiui_adb_discover') setWireless(result);
      else {
        setMessage(result.message || (result.forgotten ? t('已移除工坊中的设备记录') : ''));
        if (result.cleared) {
          setWireless(result.wireless); setMode('discover'); setAdvancedOpen(false); setRevokeAuthorization(false); setup.clear();
          setPairAddress(''); setCode(''); setAddress(''); setConnectAddress(''); setUsbSerial('');
          setFailed(!result.disconnected || result.requiresDeviceAction); onReset?.();
        }
        if (result.connected) { onConnected(result.serial); setAdvancedOpen(false); setup.clear(); }
        if (result.paired && !result.connected) { setMode('direct'); setAddress(connectAddress); setAdvancedOpen(true); }
      }
      await discovery.refresh?.();
    } catch (error) {
      setFailed(true); setMessage(error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''));
    } finally { setWorking(false); }
  }
  function selectMode(value) { setMode(value); setMessage(''); setFailed(false); setCode(''); }
  function startQuick(endpoint) {
    setMessage(''); setFailed(false); setAdvancedOpen(false);
    return setup.start(endpoint);
  }
  function manual(value, endpoint) {
    setup.clear(); selectMode(value);
    if (value === 'pair' && endpoint) setPairAddress(endpoint);
    setAdvancedOpen(true);
  }
  return <section className="wireless-connection" aria-labelledby={id + '-title'}>
    <ol className="wireless-progress" aria-label={t('连接进度')}>{['准备眼镜', '配对连接', '安装和使用'].map((label, index) => {
      const current = online ? 2 : setup.qr || ['pair', 'codeEntry', 'authorize', 'connecting'].includes(setup.session?.stage || guide.stage) ? 1 : 0;
      return <li key={label} className={index < current ? 'complete' : index === current ? 'current' : ''} aria-current={index === current ? 'step' : undefined}><span>{index < current ? <CheckCircle2 size={16}/> : index + 1}</span>{t(label)}</li>;
    })}</ol>
    {advancedOpen && <div className="wireless-heading"><h3 id={id + '-title'}><Wifi size={19}/>{t('无线连接眼镜')}</h3></div>}
    {!advancedOpen && <WirelessSetupGuide guide={guide} pairingServices={pairing} setup={{ ...setup, start: startQuick }} busy={busy} id={id} code={code} setCode={setCode} pairAddress={pairAddress} setPairAddress={setPairAddress} run={run} manual={manual}/>}
    {message && <div className={'wireless-result' + (failed ? ' warning' : '')} role={failed ? 'alert' : 'status'}>{translateMessage(message)}</div>}
    <details className="wireless-advanced" open={advancedOpen} onToggle={event => { const open = event.currentTarget.open; if (open) setup.clear(); setAdvancedOpen(open); }}><summary>{t('其他连接方式与清空记录')}</summary>
    <p className="wireless-note">{t('按眼镜上显示的信息选择一种方式。')}</p>
    {wireless?.server?.state === 'legacy' && <div className="wireless-result warning" role="status">{translateMessage(wireless.server.message)}<button className="button" disabled={busy} onClick={() => run('aiui_adb_restart')}>{t('重启连接工具')}</button></div>}
    <div className="wireless-manual">
    <div className="wireless-methods" role="group" aria-label={t('无线连接方式')}>
      {[['discover', '自动发现'], ['pair', '使用配对码'], ['direct', '输入连接地址'], ['usb', '插一次线准备']].map(([value, label]) => <button className={mode === value ? 'active' : ''} key={value} aria-pressed={mode === value} onClick={() => selectMode(value)}>{t(label)}</button>)}
    </div>
    {mode === 'discover' && <div className="wireless-content">
      <ol className="wireless-instructions">
        <li>{t('让电脑和眼镜连接同一 Wi-Fi 或热点。手机与眼镜蓝牙连接不等于眼镜已连接 Wi-Fi。')}</li>
        <li>{t('支持系统无线调试的固件：在眼镜端开启“无线调试”，首次使用打开“使用配对码配对”，并保持窗口打开。')}</li>
        <li>{t('下方出现设备后点击连接或输入配对码。找不到设备时，可输入眼镜当前显示的地址。')}</li>
      </ol>
      {services.length ? <div className="wireless-list">{services.map(service => <div className="wireless-device" key={service.serviceName}>
        <Wifi size={18}/><div><strong>{service.address}</strong><span>{service.type === 'pairing' ? t('等待输入配对码') : t('可尝试连接')}{' · '}{service.name}</span></div>
        <button className="button" disabled={busy} onClick={() => {
          if (service.type === 'pairing') { setPairAddress(service.address); selectMode('pair'); }
          else startQuick(service.address);
        }}>{service.type === 'pairing' ? t('输入配对码') : t('连接')}</button>
      </div>)}</div> : <p className="wireless-empty">{wireless?.mdns?.available === false ? translateMessage(wireless.mdns.message) : t('正在自动寻找同一网络的眼镜，开启无线调试后会出现在这里。')}</p>}
    </div>}
    {mode === 'pair' && <form className="wireless-content" onSubmit={async event => {
      event.preventDefault();
      try { await run('aiui_adb_connect', { address: pairAddress.trim(), pairingCode: code, ...(connectAddress.trim() ? { connectAddress: connectAddress.trim() } : {}) }); }
      finally { setCode(''); }
    }}>
      <p>{t('打开眼镜的“使用配对码配对”窗口，填写其中的地址和六位配对码。配对后工坊会自动寻找连接端口。')}</p>
      <div className="wireless-fields">
        <label htmlFor={id + '-pair'}>{t('配对地址')}<input id={id + '-pair'} required autoComplete="off" placeholder={t('眼镜配对窗口中的 IP 和端口')} value={pairAddress} onChange={event => setPairAddress(event.target.value)}/></label>
        <label htmlFor={id + '-code'}>{t('六位配对码')}<input id={id + '-code'} required type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="123456" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))}/></label>
      </div>
      <details className="wireless-optional"><summary>{t('自动发现不可用？同时填写连接地址')}</summary><label htmlFor={id + '-after-pair'}>{t('配对后的连接地址')}<input id={id + '-after-pair'} autoComplete="off" placeholder={t('无线调试主页中的 IP 和端口')} value={connectAddress} onChange={event => setConnectAddress(event.target.value)}/></label><p>{t('连接地址在无线调试主页，端口通常与配对窗口不同。不要把配对地址重复填在这里。')}</p></details>
      <button className="button primary" disabled={busy || !pairAddress.trim() || code.length !== 6}>{working && <LoaderCircle size={15} className="spin"/>}{t('配对并连接')}</button><span className="wireless-note">{t('配对码仅用于本次配对，不会保存。')}</span>
    </form>}
    {mode === 'direct' && <form className="wireless-content" onSubmit={event => { event.preventDefault(); startQuick(address.trim()); }}>
      <p>{t('已配对或已开启网络 ADB 的眼镜，填写无线调试主页显示的“IP 地址和端口”。连接成功后会记住设备，下次自动重连。')}</p>
      <div className="wireless-direct"><label htmlFor={id + '-address'}>{t('无线调试地址')}<input id={id + '-address'} required autoComplete="off" placeholder={t('无线调试主页中的 IP 和端口')} value={address} onChange={event => setAddress(event.target.value)}/></label><button className="button primary" disabled={busy || !address.trim()}>{working && <LoaderCircle size={15} className="spin"/>}{t('连接眼镜')}</button></div>
    </form>}
    {mode === 'usb' && <div className="wireless-content">
      <p>{t('先用数据调试线连接并允许调试，让眼镜和电脑连接同一 Wi-Fi。工坊会自动读取地址、开启网络调试并验证连接，成功后即可拔线。')}</p>
      {usb.length > 1 && <label htmlFor={id + '-usb'}>{t('选择要切换无线的眼镜')}<select id={id + '-usb'} value={usbSerial} onChange={event => setUsbSerial(event.target.value)}><option value="">{t('请选择一台眼镜')}</option>{usb.map(device => <option key={device.serial} value={device.serial}>{device.name}{' · '}{device.serial.slice(-6)}</option>)}</select></label>}
      <button className="button primary" disabled={busy || !usbSerial} onClick={() => run('aiui_adb_wireless_enable', { serial: usbSerial })}>{working ? <LoaderCircle size={15} className="spin"/> : <Cable size={15}/>} {t('一键切换无线')}</button>
      <p className="wireless-note">{usb.length ? t('请等到“无线连接已确认”再拔线。通过数据线开启的网络调试，在眼镜重启后可能需要再次开启。') : t('尚未发现已授权的数据线连接。先连接眼镜，并在眼镜上允许调试。')}</p>
    </div>}
    </div>
    {!!wireless?.saved?.length && <div className="wireless-saved"><h4>{t('已记住的眼镜')}</h4>{wireless.saved.map(record => <div className="wireless-device" key={record.id}>
      {record.status === 'connected' ? <CheckCircle2 size={18}/> : record.status === 'reconnecting' ? <LoaderCircle size={18} className="spin"/> : <Wifi size={18}/>}
      <div><strong>{translateMessage(record.name) || t('无线眼镜')}</strong><span>{record.address || t('配对完成，等待连接地址')}{' · '}{t({ connected: '无线已连接', reconnecting: '正在自动重连', paired: '等待调试连接', disconnected: '等待设备，自动重连' }[record.status])}</span>{record.error && <p>{translateMessage(record.error)}</p>}</div>
      {record.status !== 'connected' && <button className="button" disabled={busy} onClick={() => run('aiui_adb_saved', { recordId: record.id, action: 'reconnect' })}>{t('重连')}</button>}
      <button className="text-button" disabled={busy} onClick={() => run('aiui_adb_saved', { recordId: record.id, action: 'forget' })}>{t('移除记录')}</button>
    </div>)}</div>}
    <details className="wireless-help"><summary>{t('连接不上时怎么做？')}</summary><ul>
      <li>{t('找不到设备：检查眼镜的 Wi-Fi 和无线调试开关，尝试手动输入地址。公司或访客网络可能隔离设备，可换到同一普通 Wi-Fi 或热点。')}</li>
      <li>{t('配对成功但没连接：返回无线调试主页，填写连接地址；配对端口不能用于调试连接。')}</li>
      <li>{t('换网络或重启后断开：保持工坊打开等待重连。若地址已变化，重新输入当前地址；通过数据线开启的调试可能需要再插线开启。')}</li>
      <li>{t('系统询问本地网络或防火墙权限时，允许工坊访问当前网络。仍然无法连接时，检查 VPN 是否阻止本地设备通信。')}</li>
    </ul><p>{t('“一键清空”会清空工坊无线记录并断开这些眼镜，保留项目、Wi-Fi、调试开关和系统授权。若要完整重走首次配对，请在眼镜的已配对设备中忘记这台电脑，或撤销设备端调试授权。')}</p><p>{t('端口可达但仍无法连接，或电脑运行过其他 ADB 工具：先结束其他工具的安装、调试、投屏和录制，再重启连接工具。此操作会短暂断开本机所有 ADB 连接。')}</p>{wireless?.server?.state !== 'legacy' && <button className="button" disabled={busy} onClick={() => run('aiui_adb_restart')}>{t('重启连接工具')}</button>}<button className="text-button" onClick={() => window.workbench.openOfficial('https://developer.android.com/studio/run/device#wireless').catch(error => { setFailed(true); setMessage(error.message); })}>{t('查看 Android 无线配对说明')}<ArrowUpRight size={14}/></button></details>
    <section className="wireless-reset-tools"><h4>{t('重新体验首次连接')}</h4>
    <div className="wireless-reset-options"><label><input type="checkbox" checked={revokeAuthorization} disabled={working || deviceBusy} onChange={event => setRevokeAuthorization(event.target.checked)}/>{t('完整重走首次配对：同时撤销所选眼镜的 ADB 调试授权')}</label>{revokeAuthorization && <p>{t('会撤销这副眼镜对所有电脑的 ADB 授权，之后需重新授权或配对。保留项目、应用和 Wi-Fi；不会删除电脑的全局 ADB 密钥。')}</p>}</div>
    <button className="button" disabled={working || deviceBusy} title={revokeAuthorization ? t('清空工坊记录，并撤销所选眼镜对所有电脑的 ADB 授权') : t('清空工坊无线记录并断开这些眼镜，保留项目和系统授权')} onClick={() => run('aiui_adb_reset', { revokeAuthorization, ...(serial ? { serial } : {}) })}><Trash2 size={14}/>{t('一键清空')}</button></section>
    </details>
  </section>;
}
