import path from 'node:path';
import {atomicJson,readJson,id,sha} from './util.mjs';
import {APP_VERSION} from './version.mjs';

export class AiConnection {
  constructor(home,catalog){this.file=path.join(home,'ai-connection.json');this.instance=id();this.catalog=catalog;this.profileId=sha(path.resolve(home)).slice(0,12);}
  async init(){this.previous=await readJson(this.file,null);return this;}
  status(){const proof=this.current||this.previous;return {verifiedThisSession:!!this.current,verifiedAt:proof?.verifiedAt||null,serviceVersion:APP_VERSION,verifiedVersion:proof?.serviceVersion||null,profileId:this.profileId,toolCount:this.catalog.tools.length,catalogHash:sha(JSON.stringify(this.catalog.tools)),features:{workflow:this.catalog.tools.some(t=>t.name==='aiui_workflow_start'),projectFiles:this.catalog.tools.some(t=>t.name==='aiui_project_files'),diagnostics:this.catalog.tools.some(t=>t.name==='aiui_diagnostics_get')},setup:proof?.setup||null};}
  async record(tool,actor,result){
    // Discovery, a failed call, copied configuration and CLI activity do not
    // demonstrate that an external AI successfully read this service's guide.
    if(actor!=='MCP'||!(tool==='aiui_context_get'||tool==='aiui_workflow_start'&&result?.context))return;
    const first=!this.current;
    this.current={...this.current,verifiedAt:new Date().toISOString(),serviceVersion:APP_VERSION,instance:this.instance,profileId:this.profileId,...(result.setup?{setup:{at:new Date().toISOString(),skillStatus:result.skillSetup?.status||'ready',environmentChecked:!!result.environment}}:{})};
    if(first||result.setup){const value={...this.current};this.saving=(this.saving||Promise.resolve()).catch(()=>{}).then(()=>atomicJson(this.file,value));await this.saving;}
    result.connection=this.status();
  }
}
