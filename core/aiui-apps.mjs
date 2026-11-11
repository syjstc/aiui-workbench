import { AiuiCatalog, aiuiIcon } from './aiui-catalog.mjs';
const PACKAGE_DIRECTORY = '/sdcard/aiui/package';
const MANIFEST = PACKAGE_DIRECTORY + '/developer_manifest.json';
const developerId = value => typeof value === 'string' && /^develop\.rokid\.[A-Za-z0-9][A-Za-z0-9._-]{0,220}$/.test(value);

// Match the official CLI's developer inventory. Removal also requires a
// unique manifest identity that agrees exactly with the installed filename.
export function installedAiuiApps(entries, manifest, projects = []) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) throw new Error('无法识别 AIUI 开发应用清单，请刷新或更新眼镜运行时');
  const metadata = manifest.packages.filter(item => item && typeof item === 'object' && !Array.isArray(item));
  return entries.filter(file => file.type === 'file' && file.name.endsWith('.aix')).map(file => {
    const matches = metadata.filter(item => item.fileName === file.name);
    const item = matches.length === 1 ? matches[0] : {};
    const verified = developerId(item.agentId) && file.name === item.agentId + '.aix'
      && metadata.filter(other => other.agentId === item.agentId).length === 1;
    const project = verified && projects.find(project => (project.agentId?.startsWith('develop.rokid.') ? project.agentId : 'develop.rokid.agent.' + project.agentId) === item.agentId);
    return { agentId: typeof item.agentId === 'string' ? item.agentId : null, name: typeof item.agentName === 'string' && item.agentName || file.name.slice(0, -4),
      version: typeof item.nativeVersion === 'string' ? item.nativeVersion : '', engine: typeof item.inkVersion === 'string' ? item.inkVersion : '',
      fileName: file.name, bytes: file.bytes, modifiedAt: file.modifiedAt, kind: 'aiui', source: verified ? 'developer' : 'unverified', removable: !!verified,
      description:typeof item.agentDesc==='string'?item.agentDesc:'',permissions:Array.isArray(item.permissions)?item.permissions.filter(p=>typeof p==='string'):[],checksum:/^[a-f\d]{32}$/i.test(item.fileMd5)?item.fileMd5:null,readOnly:!verified,
      icon:aiuiIcon(item.agentLogo)||project?.icon||null,
      iconSource:typeof item.agentLogo==='string'&&item.agentLogo.startsWith('data:image/')?'device':project?.icon?'local-project':null,
      localProject: project ? { id: project.id, name: project.name, version: project.version } : null };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export class AiuiApps {
  constructor(glasses, cli, projects) { Object.assign(this, { glasses, cli, projects }); this.catalog=new AiuiCatalog(glasses); }
  async list({ serial, includeCatalog=true }) {
    let apps=[],developerError;
    try {
    const { entries } = await this.glasses.files({ serial, path: PACKAGE_DIRECTORY });
    const text = await this.glasses.shell(serial, `if [ -f '${MANIFEST}' ]; then cat '${MANIFEST}'; fi`, { maxBytes: 2 * 1024 * 1024 });
    let manifest;
    try { manifest = text.trim() ? JSON.parse(text) : { schemaVersion: 1, packages: [] }; }
    catch { throw new Error('AIUI 开发应用清单损坏，暂时无法核对应用身份'); }
    apps=installedAiuiApps(entries, manifest, this.projects.list());
    } catch(error) { if(!includeCatalog)throw error;developerError=error.message; }
    const catalog=includeCatalog?await this.catalog.read(serial).catch(error=>({apps:[],sources:[{source:'store',status:'unavailable',readOnly:true,count:null,error:error.message}]})):{apps:[],sources:[]};
    return { serial, checkedAt: new Date().toISOString(), kind: 'aiui', scope:includeCatalog?'visible-catalog':'developer', apps:[...apps,...catalog.apps], sources:[{source:'developer',status:developerError?'unavailable':'available',readOnly:false,count:developerError?null:apps.length,...(developerError?{error:developerError}:{})},...catalog.sources] };
  }
  async uninstall({ serial, agentId, confirmAgentId }, { signal, progress = () => {} } = {}) {
    if (!developerId(agentId)) throw new Error('请选择有效的 AIUI 开发应用身份');
    if (confirmAgentId !== agentId) throw new Error('请确认要卸载的 AIUI 开发应用身份');
    return this.glasses.exclusive(serial, async () => {
      const app = (await this.list({ serial,includeCatalog:false })).apps.find(app => app.agentId === agentId);
      if (!app?.removable) throw new Error('应用已移除或身份未核实，请刷新列表');
      signal?.throwIfAborted(); progress(`卸载 AIUI 开发应用：${app.name} · ${agentId}`);
      const result = await this.cli(['uninstall', agentId, '--serial', serial], { signal, onOutput: progress, timeout: 120000 });
      if (result.code) throw new Error(result.output || 'AIUI 开发应用卸载未完成');
      const remaining = (await this.list({ serial,includeCatalog:false })).apps;
      if (remaining.some(item => item.agentId === agentId || item.fileName === app.fileName)) throw new Error('卸载后仍检测到应用安装包，请刷新并检查任务日志');
      return { serial, agentId, name: app.name, action: 'uninstall', localRemoved: true, cloudRemoval: 'not-verified', output: result.output };
    });
  }
}
