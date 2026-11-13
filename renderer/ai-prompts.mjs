export const PROMPT_INTENTS=['refine','recover','validate','install'];
const requests={
  'zh-CN':{create:'请把下面的想法做成眼镜应用。',refine:'请继续完善这个眼镜应用。',recover:'请检查并修复这个项目当前的问题，然后重新验证。',validate:'请验证这个项目的关键功能，检查源码并生成安装包。',install:'请检查眼镜连接、授权和运行环境，将这个项目安装并打开，采集画面和日志。'},
  en:{create:'Turn the following idea into an app for glasses.',refine:'Continue improving this glasses app.',recover:'Investigate and fix the current issues in this project, then verify again.',validate:'Verify the key app behaviors, check the source and build an installation package.',install:'Check the glasses connection, authorization and runtime. Install and open this project, then collect its screen and logs.'},
};
export function buildAiPrompt({idea='',intent,project,flow,features,locale='zh-CN'}={}){
  const language=locale==='en'?'en':'zh-CN',en=language==='en';
  const current=project?.id&&flow?.projectId===project.id?flow:null;
  const purpose=Object.hasOwn(requests[language],intent)?intent:(project?'refine':'create');
  const text=String(idea).trim();
  const lines=[requests[language][purpose]||requests[language][project?'refine':'create']];
  if(text)lines.push(text);
  lines.push(en?'First read the live MCP tools and aiui_context_get, including the official aiui-dev and complementary Workshop workflow guide. Use only supported tools and parameters; runtime/CLI versions do not identify the Workshop service. If workflow/file/diagnostic tools below are unavailable, use the actual context → project create/import → your coding tools → preview test → project build flow, and its returned errors. Do not call missing methods.':'先读取 MCP 的真实工具清单及 aiui_context_get，遵循官方 aiui-dev 和工坊补充流程。只调用已提供的方法与参数，不根据 runtime/CLI 版本判断工坊能力。下述流程、源码或诊断工具不存在时，改用真实的上下文→项目创建/导入→编码工具→预览测试→检查打包流程，并读取其返回错误，不调用缺失的方法。');
  if(features?.workflow===false){
    if(project?.id)lines.push(en?`Continue projectId=${JSON.stringify(project.id)} without creating a duplicate.`:`继续 projectId=${JSON.stringify(project.id)}，不要重复创建项目。`);
    lines.push(en?'Use the current official guidance and available preview/build tools. Report user actions clearly and resume the same project.':'按当前官方规范和实际可用的预览、打包工具执行；明确告知需要用户处理的操作，完成后继续同一项目。');
    return lines.join('\n\n');
  }
  if(project?.id){
    lines.push(en?`Existing project: ${JSON.stringify(project.name)}; projectId=${JSON.stringify(project.id)}. Continue in this project; do not create a duplicate.`:`现有项目：${JSON.stringify(project.name)}；projectId=${JSON.stringify(project.id)}。请在这个项目中继续，不要重复创建项目。`);
    lines.push(current?(en?`Continue workflowId=${JSON.stringify(current.id)}. Read aiui_workflow_get and aiui_context_get first; keep its existing assertions.`:`继续 workflowId=${JSON.stringify(current.id)}。先读取 aiui_workflow_get 和 aiui_context_get，保留已有的验收断言。`):(en?'Read aiui_context_get and aiui_workflow_get for this projectId. Reuse an existing workflow; if none exists, call aiui_workflow_start with this projectId.':'先读取此项目的 aiui_context_get 和 aiui_workflow_get。已有制作任务时复用；没有时调用 aiui_workflow_start 并传入上述 projectId。'));
  }else lines.push(en?'Use AIUI Workshop. Read its current tools and official guidance, then use aiui_workflow_start to prepare the project and folder automatically.':'使用 AIUI 工坊，先读取当前工具和官方规范，再用 aiui_workflow_start 自动准备项目和目录。');
  if(purpose==='install'&&current?.target==='package')lines.push(en?'The current workflow targets package only. To install, use aiui_environment_check, aiui_device_deploy, aiui_device_launch and the device screenshot/log tools on this existing project. Do not treat package workflow completion as device installation.':'当前任务 target=package，仅完成打包。此次安装请对现有项目使用 aiui_environment_check、aiui_device_deploy、aiui_device_launch 及真机截图/日志工具，不要把打包任务完成当作已经安装。');
  if(purpose==='validate')lines.push(en?'Use aiui_preview_test with explicit application-behavior assertions and inspect its real screenshot, then use aiui_project_build. This request covers verification and packaging; stop after returning the evidence and package location. Read aiui_diagnostics_get if blocked.':'本次用 aiui_preview_test 验证实际应用行为断言并检查真实截图，再用 aiui_project_build 检查打包。完成验证和打包后，返回证据与文件位置即可。遇到阻塞读取 aiui_diagnostics_get。');
  else if(purpose==='install'&&current?.target==='package')lines.push(en?'Check that source, previous verification and package refer to the current revision. Reverify and rebuild if stale, then complete the device steps above. Read aiui_diagnostics_get if blocked.':'核对源码、已有验证和安装包是否对应当前版本，证据失效时重新验证打包，再完成上述真机步骤。遇到阻塞读取 aiui_diagnostics_get。');
  else lines.push(en?'Read and edit actual source through aiui_project_files with expectedRevision, or use your coding tools. Verify explicit application behaviors and inspect real screenshots before building. Continue the same workflow with aiui_workflow_continue; read aiui_diagnostics_get when blocked.':'通过 aiui_project_files 读取并按 expectedRevision 修改真实源码，也可用自己的编码工具。用实际应用行为断言验证并检查真实截图，然后检查打包；通过 aiui_workflow_continue 继续同一任务。遇到阻塞读取 aiui_diagnostics_get。');
  lines.push(en?'Explain any connection, authorization or network action I need to take in plain language, then continue the same task after I finish. Distinguish simulator, device and worn acceptance. Publishing and formal submission require my confirmation.':'需要我连接眼镜、授权或检查网络时，请用简短语言说明卡点、具体操作和继续方法，完成后继续原任务。区分模拟、真机和佩戴验收；发布和正式提审需由我确认。');
  return lines.join('\n\n');
}

export const IDEA_STORAGE_KEY='aiui-workbench.idea-drafts.v1';
export function readIdeaDraft(storage,projectId='new'){
  try{const saved=JSON.parse(storage?.getItem(IDEA_STORAGE_KEY)||'{}');const value=saved?.[projectId];return typeof value==='string'?value.slice(0,6000):'';}catch{return '';}
}
export function saveIdeaDraft(storage,projectId='new',value=''){
  try{const parsed=JSON.parse(storage?.getItem(IDEA_STORAGE_KEY)||'{}');const saved=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};const entries=Object.entries(saved).filter(([key])=>key!==projectId);storage.setItem(IDEA_STORAGE_KEY,JSON.stringify(Object.fromEntries([...entries,[projectId,value.slice(0,6000)]])));return true;}catch{return false;}
}
