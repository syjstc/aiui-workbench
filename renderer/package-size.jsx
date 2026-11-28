import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { t } from './i18n.jsx';

const MiB = 1024 * 1024;

export function PackageSize({ project }) {
  const artifact = project.lastBuild;
  const bytes = artifact?.bytes;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return <span className="package-size">{t('AIX 待打包')}</span>;

  const stale = artifact.revision !== project.revision || artifact.toolchainId !== project.toolchainId;
  const size = bytes >= MiB ? `${(bytes / MiB).toFixed(2)} MiB` : `${Math.round(bytes / 1024)} KiB`;
  const tone = bytes > 2 * MiB ? 'danger' : bytes > MiB ? 'warning' : '';
  const warning = { danger: '超过 2 MiB 上限', warning: '超过 1 MiB 建议值' }[tone];
  return <span className={`package-size ${tone}`} title={t('{0} 字节', {0:bytes})}>
    {warning&&<AlertTriangle size={13} aria-hidden="true"/>}
    <span>{t(stale ? '上次 AIX {0}' : 'AIX {0}', {0:size})}</span>
    {warning&&<span>{t(warning)}</span>}
  </span>;
}
