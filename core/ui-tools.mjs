// The desktop preload and authenticated Web gateway expose the same local tools.
export const UI_TOOLS = new Set([
  'aiui_feedback_status','aiui_feedback_prepare',
  'aiui_adb_connect',
  'aiui_workflow_start','aiui_workflow_get','aiui_workflow_continue','aiui_diagnostics_get','aiui_diagnostics_report','aiui_diagnostics_resolve','aiui_diagnostics_mark_read','aiui_service_log_read',
  'ui_platform_bind',
  'ui_project_removal_begin', 'ui_project_removal_commit', 'ui_project_removal_cancel',
  'aiui_record_start','aiui_record_stop','aiui_record_status','aiui_record_clip',
  'aiui_tools_list', 'aiui_capabilities_get', 'aiui_cli_info', 'aiui_preview_test', 'aiui_project_build', 'aiui_job_wait',
  'aiui_status', 'aiui_projects_list', 'aiui_project_import', 'aiui_project_create', 'aiui_project_refresh',
  'aiui_context_get', 'aiui_docs_sync', 'aiui_docs_settings', 'aiui_docs_catalog', 'aiui_docs_search', 'aiui_docs_read', 'aiui_docs_image',
  'aiui_preview_open', 'aiui_preview_state', 'aiui_preview_action', 'aiui_preview_capture', 'aiui_preview_logs', 'aiui_preview_logs_clear',
  'aiui_environment_check', 'aiui_adb_configure', 'aiui_device_enable_developer', 'aiui_device_inspect', 'aiui_device_deploy', 'aiui_device_launch',
  'aiui_glasses_info', 'aiui_glasses_files', 'aiui_glasses_mkdir', 'aiui_glasses_pull', 'aiui_glasses_push',
  'aiui_glasses_read_file',
  'aiui_glasses_apps', 'aiui_glasses_app_details', 'aiui_glasses_app_action', 'aiui_glasses_install',
  'aiui_glasses_aiui_apps', 'aiui_glasses_aiui_uninstall',
  'aiui_glasses_screenshot', 'aiui_glasses_logs', 'aiui_glasses_control',
  'aiui_glasses_mirror_status', 'aiui_glasses_mirror_start', 'aiui_glasses_mirror_stop',
  'aiui_glasses_mirror_embed_status','aiui_glasses_mirror_embed_start','aiui_glasses_mirror_embed_stop',
  'aiui_project_check', 'aiui_project_pack', 'aiui_platform_prepare', 'aiui_job_get', 'aiui_job_cancel', 'aiui_jobs_delete',
  'aiui_platform_status','aiui_platform_agents','aiui_platform_upload','aiui_platform_review_prepare','aiui_platform_review_request',
  'aiui_service_log_status', 'aiui_service_log_clear', 'aiui_mcp_config', 'aiui_mcp_install_project',
  'aiui_sdk_status', 'aiui_sdk_check', 'aiui_sdk_settings', 'aiui_sdk_prepare', 'aiui_sdk_activate', 'aiui_sdk_rollback', 'aiui_sdk_project_use',
]);

export function officialUrl(value) {
  const url = new URL(value);
  const hosts = ['github.com', 'forum.rokid.com', 'js.rokid.com', 'yodaos-project.github.io', 'jsar-project.github.io', 'modelcontextprotocol.io', 'developer.android.com', 'global.rokid.com', 'x-docs.rokid.com', 'aiui.rokid.com'];
  if (url.protocol !== 'https:' || url.username || url.password || !hosts.includes(url.hostname) || url.port) throw new Error('仅支持打开已知官方资料来源');
  return url.href;
}
