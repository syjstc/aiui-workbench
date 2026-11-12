import React from 'react';
import {Copy} from 'lucide-react';
import {t} from './i18n.jsx';

export function OfficialAgentId({agentId,onCopy}){
  if(!agentId)return null;
  return <div className="official-agent-identity"><span>{t('官网 Agent ID')}</span><div><code>{agentId}</code>{onCopy&&<button className="button" aria-label={t('复制官网 Agent ID {0}',{0:agentId})} onClick={()=>onCopy(agentId)}><Copy size={14}/>{t('复制')}</button>}</div></div>;
}
