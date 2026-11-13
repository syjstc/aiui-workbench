import path from 'node:path';
import {atomicJson,readJson} from './util.mjs';

const MAX_BYTES=1024*1024,MAX_KEYS=1000;
export class PreviewStorage {
  constructor(home){this.root=path.join(home,'preview-storage');this.pending=new Map();}
  file(projectId){if(!/^[a-f0-9-]+$/i.test(projectId))throw new Error('无效的项目 ID');return path.join(this.root,projectId+'.json');}
  async read(projectId){await this.pending.get(projectId)?.catch(()=>{});return readJson(this.file(projectId),[]);}
  update(projectId,change){
    const operation=this.pending.get(projectId)||Promise.resolve();
    const next=operation.catch(()=>{}).then(async()=>{
      const entries=new Map(await readJson(this.file(projectId),[]));
      if(!['set','remove','clear'].includes(change?.operation))throw new Error('无效的模拟存储操作');
      if(change.operation!=='clear'&&(typeof change.key!=='string'||!change.key.length||change.key.length>1000))throw new Error('无效的模拟存储键');
      if(change.operation==='set'){if(change.value===undefined)throw new Error('模拟存储需要 JSON 数据');entries.set(change.key,change.value);}
      if(change.operation==='remove')entries.delete(change.key);if(change.operation==='clear')entries.clear();
      const value=[...entries];if(entries.size>MAX_KEYS||Buffer.byteLength(JSON.stringify(value))>MAX_BYTES)throw new Error('模拟存储超过 1 MB 或 1000 项限制');
      await atomicJson(this.file(projectId),value);return {saved:true};
    });
    this.pending.set(projectId,next);return next;
  }
  async close(){await Promise.allSettled(this.pending.values());}
}
