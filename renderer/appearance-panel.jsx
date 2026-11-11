import React, { useSyncExternalStore } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { t } from './i18n.jsx';
import { APPEARANCES, getAppearance, setAppearance, subscribeAppearance } from './theme.mjs';

const icons = { system: Monitor, light: Sun, dark: Moon };

export function AppearancePanel() {
  const { preference, resolved } = useSyncExternalStore(subscribeAppearance, getAppearance);
  return <section className="panel appearance-panel" aria-label={t('外观')}>
    <div className="section-heading"><h2>{t('外观')}</h2><span className="subtle">{t('立即生效，自动保存')}</span></div>
    <p className="appearance-description">{t('选择适合你的工作环境。自动模式跟随系统外观。')}</p>
    <div className="appearance-options" role="group" aria-label={t('主题模式')}>
      {APPEARANCES.map(({ id, label }) => {
        const Icon = icons[id] || Sun;
        return <button key={id} className="appearance-option" aria-pressed={preference === id} onClick={() => setAppearance(id)}>
          <span className={'theme-preview theme-preview-' + id} aria-hidden="true"><span className="theme-preview-sidebar"/><span className="theme-preview-main"><i/><i/><span><i/><i/></span></span></span>
          <span className="appearance-label"><Icon size={14}/><strong>{t(label)}</strong>{preference === id && <Check size={14}/>}</span>
        </button>;
      })}
    </div>
    <p className="appearance-note">{preference === 'system' ? (resolved === 'dark' ? t('当前跟随系统使用深色主题') : t('当前跟随系统使用浅色主题')) : t('主题偏好已保存在此设备')}</p>
  </section>;
}
