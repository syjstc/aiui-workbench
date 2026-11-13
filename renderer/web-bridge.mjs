import { t } from './i18n.jsx';
async function request(route, data) {
  const response = await fetch('/api/' + route, data === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok || result.error) throw Object.assign(new Error(result.error || `HTTP ${response.status}`),{diagnosticId:result.diagnosticId});
  return result.result;
}

export function createWebBridge() {
  const key = new URLSearchParams(location.hash.slice(1)).get('key');
  if (key) history.replaceState(null, '', location.pathname + location.search);
  const ready = key ? request('session', { key }) : request('health');
  // The UI reports a failed handshake via its normal refresh error message.
  ready.catch(() => {});
  const invoke = async (route, data) => { await ready; return request(route, data); };
  const uploadedFiles = new Map();
  const importFiles = async (inputFiles, kind = 'files') => {
    await ready; const files = Array.from(inputFiles), paths = [];
    if (files.length > (kind === 'apk' ? 20 : 50)) throw new Error(t('一次选择的文件过多'));
    if (kind === 'apk' && files.some(file => !/\.apk$/i.test(file.name))) throw new Error(t('请拖入独立 .apk 文件'));
    for (const file of files) if (file.size > 2 * 1024 * 1024 * 1024) throw new Error(t('单个文件不能超过 2 GB'));
    for (const file of files) {
      const identity = `${file.name}:${file.size}:${file.lastModified}`;
      if (uploadedFiles.has(identity)) { paths.push(uploadedFiles.get(identity)); continue; }
      const response = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const value = await response.json(); if (!response.ok || value.error) throw new Error(value.error || `HTTP ${response.status}`);
      uploadedFiles.set(identity, value.result); paths.push(value.result);
    }
    return paths;
  };
  let picker = null;
  return {
    kind: 'web', platform: /Win/i.test(navigator.userAgentData?.platform || navigator.platform) ? 'win32' : /Mac/i.test(navigator.userAgentData?.platform || navigator.platform) ? 'darwin' : 'linux', call: (tool, args = {}) => invoke('call', { tool, args }),
    removeProject: async args => {
      if (args.operation !== 'detach') throw new Error(t('请在桌面客户端删除项目，文件将移到系统废纸篓或回收站'));
      const intent = await invoke('call', { tool: 'ui_project_removal_begin', args });
      try { return await invoke('call', { tool: 'ui_project_removal_commit', args: { intentId: intent.id } }); }
      catch (error) { await invoke('call', { tool: 'ui_project_removal_cancel', args: { intentId: intent.id } }).catch(() => {}); throw error; }
    },
    feedback:(method,args)=>invoke('feedback',{method,args}),
    copy: text => navigator.clipboard.writeText(String(text)),
    reveal: file => invoke('reveal', { path: file }),
    openOfficial: url => invoke('official', { url }),
    openStudio: () => invoke('official', { url: 'https://aiui.rokid.com/space' }),
    listDirectories: directory => invoke('directories' + (directory ? '?path=' + encodeURIComponent(directory) : '')),
    setDirectoryPicker: callback => { picker = callback; },
    chooseDirectory: () => new Promise(resolve => { if (!picker) throw new Error(t("目录选择器尚未就绪")); picker(resolve); }),
    importFiles,
    chooseFiles: (kind = 'files') => new Promise((resolve, reject) => {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
      if (kind === 'apk') input.accept = '.apk';
      input.addEventListener('cancel', () => resolve([]), { once: true });
      input.addEventListener('change', async () => {
        try {
          resolve(await importFiles(input.files || [], kind));
        } catch (error) { reject(error); }
      }, { once: true }); input.click();
    }),
    choosePhoto: () => new Promise((resolve, reject) => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.addEventListener('change', async () => {
        try {
          const file = input.files?.[0]; if (!file) return resolve(null);
          if (file.size > 10 * 1024 * 1024) throw new Error(t("模拟照片不能超过 10 MB"));
          const data = await new Promise((yes, no) => { const reader = new FileReader(); reader.onload = () => yes(String(reader.result).split(',')[1]); reader.onerror = () => no(reader.error); reader.readAsDataURL(file); });
          resolve(await invoke('photo', { data }));
        } catch (error) { reject(error); }
      }, { once: true }); input.click();
    }),
  };
}

if (!window.workbench) window.workbench = createWebBridge();
