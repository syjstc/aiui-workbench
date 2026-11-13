import path from 'node:path';

// Use recorded identities and exact directory boundaries, never the currently
// selected UI project or a project name guessed from an error message.
export function diagnosticScope(context, workbench) {
  const args = context.context || {}, projects = workbench.projects?.items || [];
  const projectIds = new Set([context.projectId, args.projectId].filter(value => typeof value === 'string' && value));
  const sessionId = context.sessionId || args.sessionId, jobId = context.jobId || args.jobId, workflowId = context.workflowId || args.workflowId;
  const session = workbench.previews?.sessions.get(sessionId);
  const job = workbench.jobs?.items.find(item => item.id === jobId);
  const flow = workbench.workflows?.items.find(item => item.id === (workflowId || job?.workflowId));
  for (const item of [session, job, flow]) if (item?.projectId) projectIds.add(item.projectId);
  const operationPath = context.operationPath || args.directory || (/^(?:aiui_project_|ui_project_)/.test(context.tool || '') ? args.path : undefined);
  if (!projectIds.size && typeof operationPath === 'string' && path.isAbsolute(operationPath)) {
    const matches = projects.filter(project => [project.projectPath, project.agentPath].some(root => {
      if (!root) return false;
      const relative = path.relative(root, operationPath);
      return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    })).sort((a, b) => b.projectPath.length - a.projectPath.length);
    if (matches[0]) projectIds.add(matches[0].id);
  }
  const links = { ...(sessionId ? { sessionId } : {}), ...(jobId ? { jobId } : {}), ...(workflowId || job?.workflowId ? { workflowId: workflowId || job.workflowId } : {}) };
  if (projectIds.size > 1) return { ...links, scope: 'unassigned', association: 'conflict', relatedProjectIds: [...projectIds], projectId: undefined, projectName: undefined, projectPath: undefined };
  if (projectIds.size) {
    const projectId = [...projectIds][0], project = projects.find(item => item.id === projectId);
    return { ...links, scope: 'project', projectId, projectName: project?.name || context.projectName || flow?.name, projectPath: project?.projectPath || context.projectPath || flow?.projectPath, projectAvailable: !!project, revision: context.revision || (context.createdAt ? undefined : project?.revision), toolchainId: context.toolchainId || (context.createdAt ? undefined : project?.toolchainId) };
  }
  const globalTool=/^(?:knowledge|sdk-prepare|device-setup|aiui_(?:docs_|adb_|glasses_|service_log_|environment_check$|sdk_(?!project_use)))/.test(context.tool || '');
  const needsProject = sessionId || jobId && !job && !globalTool || workflowId || operationPath || /(?:project_|preview_|workflow_|^(?:check|pack|build|deploy|launch)$)/.test(context.tool || '') || context.scope === 'unassigned';
  return { ...links, scope: needsProject ? 'unassigned' : 'workbench', ...(operationPath ? { operationPath } : {}) };
}
