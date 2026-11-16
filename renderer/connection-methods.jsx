import React, { useState } from 'react';
import { Cable, CheckCircle2, Wifi } from 'lucide-react';
import { t } from './i18n.jsx';

const preferenceKey = 'aiui-workbench.connection-method';
export function useConnectionMethod() {
  const [method, setMethod] = useState(() => {
    try { return localStorage.getItem(preferenceKey) === 'usb' ? 'usb' : 'wireless'; } catch { return 'wireless'; }
  });
  function choose(value) {
    setMethod(value);
    try { localStorage.setItem(preferenceKey, value); } catch {}
  }
  return [method, choose];
}

export function ConnectionMethodTabs({ method, onChange, id, wirelessConnected, usbConnected }) {
  const options = [['wireless', '无线连接', Wifi, wirelessConnected], ['usb', '有线连接', Cable, usbConnected]];
  return <div className="connection-method-tabs" role="tablist" aria-label={t('连接方式')}>
    {options.map(([value, label, Icon, connected], index) => <button type="button" key={value} role="tab" id={id + '-tab-' + value} aria-label={t(label)} aria-selected={method === value} aria-controls={id + '-panel-' + value} tabIndex={method === value ? 0 : -1} onClick={() => onChange(value)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      onChange(options[next][0]); event.currentTarget.parentElement.children[next].focus();
    }}><Icon size={18}/><span>{t(label)}</span>{connected && <small><CheckCircle2 size={13}/>{t('已连接')}</small>}</button>)}
  </div>;
}

export function WiredConnection({ devices = [] }) {
  const online = devices.some(device => device.status === 'device');
  const unauthorized = devices.some(device => device.status === 'unauthorized');
  return <section className="wired-connection">
    <div className="wireless-next-action"><span className="wireless-next-icon">{online ? <CheckCircle2 size={21}/> : <Cable size={21}/>}</span><div className="wireless-next-copy">
      <h3>{t(online ? '眼镜已通过数据线连接' : unauthorized ? '请在眼镜上允许 USB 调试' : '通过数据线连接眼镜')}</h3>
      <p>{t(online ? '保持数据线连接，即可安装应用、查看日志、管理文件或投屏。' : '准备数据调试线，在手机开启调试，再插线并允许连接。工坊会自动检测。')}</p>
      {!online && <ol className="wireless-install-steps wired-steps">
        <li><span>1</span><div><strong>{t('准备数据调试线')}</strong><p>{t('使用适配当前眼镜型号、支持数据传输的 Rokid 调试线。普通充电线无法完成调试连接。')}</p></div></li>
        <li><span>2</span><div><strong>{t('在手机开启眼镜调试')}</strong><p>{t('Rokid AI → 主页 → 眼镜卡片右侧齿轮 → 开发者 → 眼镜 ADB 调试。')}</p></div></li>
        <li><span>3</span><div><strong>{t('插线并允许连接')}</strong><p>{t('连接电脑与眼镜。眼镜弹出「允许 USB 调试」时确认；也可用 Rokid AI 工具箱里的遥控器确认。')}</p></div></li>
      </ol>}
    </div></div>
  </section>;
}
