import React from 'react';
import { AlertCircle, ArrowUp, CheckCircle2, LoaderCircle, Minus } from 'lucide-react';

const icons = { ready: CheckCircle2, action: ArrowUp, error: AlertCircle, working: LoaderCircle, idle: Minus };

export function StatusLabel({ id, tone = 'idle', children }) {
  const Icon = icons[tone];
  return <span id={id} className={`status-label status-label-${tone}`}>
    <Icon size={12} aria-hidden="true" className={tone === 'working' ? 'spin' : undefined}/>
    <span>{children}</span>
  </span>;
}
