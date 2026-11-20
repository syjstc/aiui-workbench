import React, { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { CheckCircle2, Glasses, LoaderCircle, QrCode, Smartphone, Wifi } from 'lucide-react';
import { t, translateMessage } from './i18n.jsx';

function CodeImage({ value, alt }) {
  const src = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(value); code.make();
    return code.createDataURL(5, 20);
  }, [value]);
  return <img className="wireless-qr" width="205" height="205" src={src} alt={alt}/>;
}

export function WirelessSetupGuide({ guide, pairingServices, setup, busy, id, code, setCode, pairAddress, setPairAddress, run, manual }) {
  const [host, setHost] = useState('');
  const { session, helper } = setup;
  const discovered = ['found', 'pair', 'connected', 'enable'].includes(guide.stage);
  const guideTakesOver = (session?.stage === 'prepare' && discovered) ||
    (session?.stage === 'needCode' && ['pair', 'connected'].includes(guide.stage));
  const stage = helper ? (helper.stage === 'sent' && pairingServices.length ? 'pair' : 'helper')
    : guideTakesOver ? guide.stage : session?.stage || guide.stage;
  const titles = {
    checking: '正在查找眼镜…', searching: '正在查找眼镜…', connecting: '正在连接眼镜…', tools: '连接工具暂时不可用', repair: '电脑的连接工具需要重启',
    start: '用 Wi-Fi 连接这副眼镜', found: '发现可连接的设备', pair: '输入眼镜上的六位配对码', codeEntry: '输入眼镜上的六位配对码',
    prepare: '暂未找到可连接的眼镜', preparingHelper: '正在准备手机安装包…', needCode: '允许这台电脑首次连接', helper: '用手机扫码下载无线助手', authorize: '戴上眼镜，点“允许调试”',
    expired: '等待授权已超时',
    usbAuthorize: '戴上眼镜，点“允许调试”', enable: '把已连接的眼镜切换到无线', reconnect: '等待已记住的眼镜上线',
    connected: '眼镜已通过 Wi-Fi 连接', qr: '用眼镜扫描配对二维码',
  };
  let title = t(titles[stage]);
  if (stage === 'helper') {
    if (helper.stage === 'sent') title = t('安装包已发送，请在 Rokid AI 中安装');
    else if (helper.expired) title = t('手机下载码已过期');
    else if (!helper.urls.length) title = t('把无线助手发到手机');
  }
  const Icon = stage === 'connected' ? CheckCircle2 : stage === 'authorize' ? Glasses : Wifi;
  const button = (label, action) => <button className="button primary" disabled={busy} onClick={action}>{busy && <LoaderCircle size={15} className="spin"/>}{label}</button>;
  const other = (label, action) => <button className="text-button" disabled={busy} onClick={action}>{label}</button>;
  const pairOptions = <div className="wireless-pair-options" role="group" aria-label={t('首次配对方式')}><button className={stage === 'qr' ? 'active' : ''} aria-pressed={stage === 'qr'} disabled={busy} onClick={setup.useQr}><QrCode size={16}/>{t('二维码配对')}</button><button className={['pair', 'codeEntry'].includes(stage) ? 'active' : ''} aria-pressed={['pair', 'codeEntry'].includes(stage)} disabled={busy} onClick={setup.useCode}>{t('六位码配对')}</button></div>;
  const pairing = pairingServices.find(s => s.address === pairAddress) || (pairingServices.length === 1 ? pairingServices[0] : null);
  const endpoint = pairing?.address || (pairingServices.length ? '' : pairAddress.trim());
  const url = helper?.urls.includes(host) ? host : helper?.urls[0];
  return <div className="wireless-next-action">
    <span className="wireless-next-icon"><Icon size={21}/></span>
    <div className="wireless-next-copy"><h3 id={id + '-title'} aria-live="polite">{title}</h3>
      {['checking', 'searching', 'connecting', 'preparingHelper'].includes(stage) && <LoaderCircle size={18} className="spin"/>}
      {stage === 'start' && <><p>{t('眼镜和电脑连好同一个 Wi-Fi 或热点，就可以开始。')}</p><div className="wireless-action-row">{button(t('一键连接眼镜'), () => setup.start())}{other(t('用手机安装无线助手'), setup.openHelper)}</div><details className="wireless-already-ready"><summary>{t('眼镜已打开无线调试？直接配对')}</summary>{pairOptions}</details></>}
      {stage === 'found' && <><p>{t('确认下方是你的设备，再点连接。首次连接时，眼镜可能会请你允许调试。')}</p>
        <div className="wireless-list">{guide.services.map(s => <div className="wireless-device" key={s.address}><Glasses size={19}/><div><strong>{s.name || t('待连接设备')}</strong><span>{s.address}</span></div>
          {s.type === 'pairing' ? button(t('输入配对码'), () => manual('pair', s.address)) : button(t('一键连接眼镜'), () => setup.start(s.address))}</div>)}</div>
        {other(t('用手机安装无线助手'), setup.openHelper)}</>}
      {stage === 'prepare' && <><p>{t('手机和电脑连同一个 Wi-Fi，即可从工坊下载眼镜端助手。')}</p>
        <div className="wireless-action-row">{button(t('用手机安装无线助手'), setup.openHelper)}{other(t('重新查找眼镜'), () => setup.start())}</div></>}
      {stage === 'needCode' && <><p>{t('这副设备需要首次配对。如果眼镜已显示六位码，可直接输入。找不到设置入口时，从手机工具箱安装助手即可打开。')}</p>
        {pairOptions}{other(t('从手机安装无线助手'), setup.openHelper)}</>}
      {stage === 'helper' && <>
        <p>{t('先下载到手机，再通过 Rokid AI 安装到眼镜。手机可以直接遥控眼镜完成设置。')}</p>
        <div className="wireless-phone-layout">
        {url && helper.stage !== 'sent' && <div className="wireless-download-card"><span className="wireless-location"><Smartphone size={14}/>{t('用手机相机扫描')}</span><CodeImage value={url} alt={t('用手机扫码打开无线助手下载页')}/><p>{t('手机下载码 · 仅用于下载 APK')}</p><p>{t('手机和电脑需连接同一 Wi-Fi。')}</p>
          {helper.stage === 'opened' && <p role="status">{t('下载页已打开，请在手机上点「下载 APK」。')}</p>}</div>}
        <ol className="wireless-install-steps">
          <li><span>1</span><div><strong>{t('手机上安装到眼镜')}</strong><p>{t('打开 Rokid AI → 工具箱 → 眼镜应用管理 → 安装新应用，选 {0}。', { 0: helper.downloadName || 'aiui-wireless-helper.apk' })}</p></div></li>
          <li><span>2</span><div><strong>{t('用手机遥控眼镜')}</strong><p>{t('Rokid AI → 工具箱 → 遥控器：滑动选中，点击确认，返回键退回。也可以用眼镜镜腿操作。')}</p></div></li>
          <li><span>3</span><div><strong>{t('眼镜上开启无线调试')}</strong><p>{t('打开「AIUI 无线助手」→ 无线调试 → 使用配对码配对设备，将六位数字填回工坊。')}</p></div></li>
        </ol></div>
        {helper.expired && helper.stage !== 'sent' && <p role="status">{t('下载码已过期。可以重新生成，或从电脑传送安装包。')}</p>}
        {!url && !helper.expired && helper.stage !== 'sent' && <><p>{t('在电脑上找到助手 APK，用你常用的方式发到手机。')}</p>{button(t('在电脑上显示安装包'), () => window.workbench.reveal(helper.file).catch(e => setup.showError(e.message)))}</>}
        {helper.expired && helper.stage !== 'sent' && button(t('重新生成下载码'), setup.openHelper)}
        <div className="wireless-action-row">{button(t('输入眼镜上的六位配对码'), setup.useCode)}{other(t('二维码配对'), setup.useQr)}{other(t('重新查找眼镜'), () => setup.start())}</div>
        <details className="wireless-optional"><summary>{t('手机下载或眼镜设置遇到问题？')}</summary>
          {url && helper.urls.length > 1 && <label className="wireless-adapter">{t('手机扫不开？切换电脑的网络地址')}<select value={url} onChange={e => setHost(e.target.value)}>{helper.urls.map(u => <option value={u} key={u}>{new URL(u).hostname}</option>)}</select></label>}
          <p>{t('访客 Wi-Fi 可能隔离设备。可以让手机和电脑都连到能互访的 Wi-Fi，或直接把电脑上的 APK 发到手机。')}</p>
          <div className="wireless-action-row">{other(t('在电脑上显示安装包'), () => window.workbench.reveal(helper.file).catch(e => setup.showError(e.message)))}{other(t('重新生成下载码'), setup.openHelper)}</div>
          <p>{t('看到时钟时，返回「设备信息」，向下找「版本号」。点「Android 版本」会打开时钟。可以用手机工具箱的遥控器操作。')}</p>
          <p>{t('若助手提示开启开发者选项，在「设备信息」找到「版本号」，选中后连点 7 次。若进入「开发者选项」，滑动选中「无线调试」这一行再点。')}</p>
        </details>
      </>}
      {['pair', 'codeEntry'].includes(stage) && <>{pairOptions}<p>{pairingServices.length ? t('保持眼镜的配对窗口打开。工坊已找到配对地址。') : t('保持眼镜的配对窗口打开。填写窗口显示的配对地址和六位数字。')}</p>
        {pairingServices.length > 1 && <label className="device-field">{t('选择要配对的眼镜')}<select value={pairAddress} onChange={e => setPairAddress(e.target.value)}><option value="">{t('请选择一台眼镜')}</option>{pairingServices.map(s => <option key={s.address} value={s.address}>{s.address}</option>)}</select></label>}
        <form className="wireless-guided-pair" onSubmit={async e => { e.preventDefault(); if (endpoint) { try { await run('aiui_adb_connect', { address: endpoint, pairingCode: code }); } finally { setCode(''); } } }}>
          {!pairingServices.length && <label htmlFor={id + '-guided-address'}>{t('配对地址')}<input className="wireless-guided-address" id={id + '-guided-address'} autoComplete="off" value={pairAddress} onChange={e => setPairAddress(e.target.value)} placeholder={t('眼镜配对窗口中的 IP 和端口')}/></label>}
          <label htmlFor={id + '-guided-code'}>{t('六位配对码')}<input id={id + '-guided-code'} type="password" autoComplete="off" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label>
          <button className="button primary" disabled={busy || !endpoint || code.length !== 6}>{t('配对并连接')}</button></form>
</>}
      {stage === 'qr' && <>{pairOptions}<p>{t('在眼镜的「无线调试」中选择「使用二维码配对设备」，用眼镜扫描下方二维码，工坊会自动连接。')}</p><p className="wireless-note">{t('这是配对二维码。手机相机扫码只能读取内容，不能代替眼镜配对；没有扫码入口时，选「六位码配对」。')}</p>
        {setup.qr?.stage === 'waiting' && <div className="wireless-download-card wireless-pair-card"><img className="wireless-qr" src={setup.qr.qrDataUrl} alt={t('眼镜无线调试配对二维码')}/><p role="status"><LoaderCircle size={14} className="spin"/>{t('等待眼镜扫描 · 两分钟内有效')}</p></div>}
        {setup.qr?.stage === 'pairing' && <p role="status"><LoaderCircle size={14} className="spin"/>{t('已收到眼镜扫码，正在配对并检查连接…')}</p>}
        {setup.qr?.stage === 'paired' && <><p role="status">{translateMessage(setup.qr.message)}</p>{button(t('输入连接地址'), () => manual('direct'))}</>}
        {['expired', 'failed'].includes(setup.qr?.stage) && <><p role="status">{setup.qr.stage === 'expired' ? t('配对二维码已过期，请重新生成。') : translateMessage(setup.qr.message)}</p>{button(t('重新生成配对码'), setup.useQr)}</>}
        {setup.qr?.stage === 'waiting' && setup.qr.message && <p role="status">{translateMessage(setup.qr.message)}</p>}
      </>}
      {stage === 'authorize' && <><p>{t('请在这副眼镜上确认允许这台电脑调试。工坊会自动继续。')}</p>{other(t('没有看到授权提示？'), setup.openHelper)}</>}
      {stage === 'usbAuthorize' && <p>{t('请允许这台电脑调试。工坊会自动识别已授权的眼镜。')}</p>}
      {stage === 'expired' && <><p>{t('保持眼镜开机，重新连接后在眼镜上允许调试。')}</p>{button(t('重新查找眼镜'), () => setup.start())}</>}
      {stage === 'repair' && <><p>{t('请先结束正在进行的安装、投屏和录制，再重启电脑上的连接工具。')}</p>{button(t('重启连接工具'), () => run('aiui_adb_restart'))}</>}
      {stage === 'tools' && <p>{t('请从完整安装包打开工坊，或在新手指南中选择 Android 连接工具。')}</p>}
      {stage === 'enable' && <><p>{t('让眼镜和电脑使用同一个 Wi-Fi，保持数据线连接，看到无线连接确认后就可以拔线。')}</p>{button(t('一键切换无线'), () => run('aiui_adb_wireless_enable', { serial: guide.device.serial }))}</>}
      {stage === 'reconnect' && <><p>{t('保持眼镜开机，工坊会自动重连。换过网络或想连接另一副眼镜时，可以重新配对。')}</p><div className="wireless-action-row">{button(t('在当前网络重新查找'), () => setup.start())}{other(t('现在重连'), () => run('aiui_adb_saved', { recordId: guide.record.id, action: 'reconnect' }))}</div></>}
      {stage === 'connected' && <p>{translateMessage(guide.device?.name || '无线眼镜')}{' · '}{t('现在可以安装应用、查看日志、管理文件或投屏。')}</p>}
      {!helper && ['checking', 'tools', 'repair', 'pair', 'usbAuthorize', 'enable', 'reconnect', 'expired'].includes(stage) &&
        other(t('用手机安装无线助手'), setup.openHelper)}
      {setup.error && <div className="wireless-result warning" role="alert">{translateMessage(setup.error)}</div>}
    </div>
  </div>;
}
