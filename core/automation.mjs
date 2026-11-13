import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { atomicJson, id, redact } from './util.mjs';
import { previewTestSchema, buildSchema } from './automation-contract.mjs';

const sleep = (ms, signal) => pause(ms, undefined, { signal });
function failed(message, result) { return Object.assign(new Error(message), { result }); }
function valueAt(state, key) { return key.split('.').reduce((value, part) => value && Object.hasOwn(value, part) ? value[part] : undefined, state); }
export function assertions(expect = {}, state, logs) {
  const checks = Object.entries(expect.state || {}).map(([key, expected]) => ({ kind: 'state', path: key, expected, actual: valueAt(state, key) ?? null, passed: valueAt(state, key) === expected }));
  if (expect.logContains) checks.push({ kind: 'logContains', expected: expect.logContains, passed: logs.some(log => log.message.includes(expect.logContains)) });
  if (expect.logCount) { const actual = logs.filter(log => log.message.includes(expect.logCount.contains)).length; checks.push({ kind: 'logCount', contains: expect.logCount.contains, expected: expect.logCount.count, actual, passed: actual === expect.logCount.count }); }
  return checks;
}

export class Automation {
  constructor(workbench) { this.workbench = workbench; this.activeTests = new Set(); }
  async test(args, actor, metadata = {}) {
    const options = previewTestSchema.parse(args), w = this.workbench;
    const project = await w.projects.refresh(options.projectId);
    const preview = w.previews.open(project.id, w.origin, { ...options, requestedBy: actor });
    if (this.activeTests.has(preview.id)) throw new Error('该预览已有模拟测试运行，请等待完成或取消任务');
    this.activeTests.add(preview.id);
    const revision = project.revision, toolchainId = project.toolchainId;
    const job = w.jobs.start('preview-test', project.id, async context => {
      try { return await this.testNow(options, preview.id, revision, toolchainId, context); }
      finally { this.activeTests.delete(preview.id); }
    }, { ...metadata, sessionId: preview.id });
    return w.jobs.wait(job.id, options.waitMs);
  }
  async ready(sessionId, revision, { signal, progress }) {
    const w = this.workbench, end = Date.now() + 25000;
    let opened = false;
    while (Date.now() < end) {
      signal.throwIfAborted();
      const s = w.previews.public(w.previews.get(sessionId));
      if (s.status === 'ready' && s.state.running && s.revision === revision && !s.stale && s.readyAt > s.requestedAt) return s;
      if (s.status === 'failed' && s.failedAt > s.requestedAt) throw new Error('官方运行时加载失败：' + w.previews.get(sessionId).logs.filter(l=>l.level==='error').slice(-2).map(l=>l.message).join('\n'));
      // The desktop/Web UI normally mounts the requested preview. A tool-only
      // client can use a regular local browser, with no automation dependency.
      if (!opened && ![...w.clients.values()].some(c => ['desktop','web'].includes(c.name) && Date.now()-c.lastSeen < 5000)) {
        opened = true; progress('正在浏览器中打开官方模拟运行时');
        const { openOnHost } = await import('../web/server.mjs');
        await (this.openBrowser || openOnHost)(s.url);
      }
      await sleep(100, signal);
    }
    throw new Error('模拟运行时未就绪，请保持工坊模拟器或返回的预览 URL 打开后重试');
  }
  async testNow(options, sessionId, revision, toolchainId, { signal, progress }) {
    const w = this.workbench, s = w.previews.get(sessionId), startSequence = s.logSequence || 0;
    const report = { schemaVersion: 1, simulated: true, deviceVerified: false, projectId: s.projectId, sessionId, previewUrl:w.previews.public(s).url, revision, toolchainId, ...w.runtimeInfo(w.projects.get(s.projectId)), startedAt: new Date().toISOString(), logGeneration:s.logGeneration, passed: false, steps: [], runs: [], assertionsEvaluated: 0 };
    report.path = path.join(w.home, 'reports', s.projectId, `simulation-${id()}.json`);
    try {
      progress('等待官方运行时与当前源码就绪');
      if (options.reload && s.lastSeen && Date.now()-Date.parse(s.lastSeen)<4500 && !['waiting','closed'].includes(s.status)) await w.previews.action(sessionId, 'reload', {}, { signal });
      const initial = await this.ready(sessionId, revision, { signal, progress });
      report.runs.push(initial.state.runId);
      if(options.record)report.video=await w.recordings.start({source:'simulator',sessionId,fps:options.recordFps,durationSeconds:120},'MCP');
      const deadline = Date.now() + 90000;
      for (const [index, step] of options.steps.entries()) {
        signal.throwIfAborted(); if (Date.now()>deadline) throw new Error('模拟测试达到 90 秒执行上限，请拆分测试');
        progress(`步骤 ${index+1}/${options.steps.length} · ${step.name || step.action}`);
        const item = { index, name: step.name || step.action, action: step.action, parameters: step.parameters, waitMs: step.waitMs, settleMs: step.settleMs, passed: false, checks: [] };
        report.steps.push(item);
        await sleep(step.waitMs, signal);
        // Capture the cursor immediately before dispatch, so an earlier step
        // cannot satisfy a later log assertion with an identical message.
        const cursor = s.logSequence || 0;
        const observation = await w.previews.action(sessionId, step.action==='wait'?'observe':step.action, step.parameters, { signal, observe:true });
        if(!Number.isFinite(observation.startedAt))throw new Error('模拟运行时版本较旧，请重新打开模拟器后重试');
        item.startedAt=observation.startedAt;
        if (step.action === 'reload') report.runs.push(s.state.runId);
        await sleep(step.settleMs, signal);
        const end = Date.now() + step.timeoutMs;
        do {
          signal.throwIfAborted();
          const logs = s.logs.filter(log => log.sequence>cursor && log.createdAt>=observation.startedAt && report.runs.includes(log.runId));
          item.checks = assertions(step.expect, s.state, logs);
          if (item.checks.every(check=>check.passed)) break;
          await sleep(80, signal);
        } while (Date.now()<end);
        report.assertionsEvaluated += item.checks.length;
        item.passed = item.checks.every(check=>check.passed);
        if (step.expect?.logCount && s.logs[0]?.sequence>cursor+1) throw new Error('该步骤日志超出保留上限，无法验证精确次数');
        if (w.projects.get(s.projectId).revision!==revision || s.revision!==revision || !report.runs.includes(s.state.runId)) throw new Error('测试期间源码、SDK 或运行实例发生变化，请重新验证');
        if (!item.passed) throw new Error(`步骤 ${index+1} 断言未通过：${JSON.stringify(item.checks.filter(check=>!check.passed))}`);
      }
      report.passed = true;
    } catch (error) { report.error = redact(error.message); }
    if(report.video){try{report.video=await w.recordings.stop({recordingId:report.video.id});if(report.video.status!=='completed')throw new Error(report.video.error||'视频未完成');}catch(error){report.passed=false;report.error=report.error||error.message;}}
    // Always keep evidence, including failed assertions and load failures.
    if (options.capture && !signal.aborted && s.state.running) {
      try { const { data, ...capture } = await w.previews.capture(sessionId, { signal }); report.capture = capture; }
      catch (error) { report.captureError = redact(error.message); report.passed = false; }
    }
    else if(options.capture)report.captureSkipped=signal.aborted?'cancelled':'application-not-running';
    const current = await w.projects.refresh(s.projectId);
    report.stale = current.revision!==revision || current.toolchainId!==toolchainId || s.revision!==revision;
    report.state = s.state;
    if(!report.runs.length && s.state.runId)report.runs.push(s.state.runId);
    report.logs = s.logs.filter(log=>log.sequence>startSequence && report.runs.includes(log.runId));
    report.logsTruncated = (s.logSequence || 0)-startSequence>500;
    report.errors = report.logs.filter(log=>log.level==='error');
    report.logsCleared=s.logGeneration!==report.logGeneration;
    if (report.stale || report.logsCleared || (options.failOnError && (report.errors.length || report.logsTruncated))) report.passed=false;
    report.coverage = report.assertionsEvaluated ? 'explicit-state-and-log-assertions' : 'runtime-smoke-only';
    report.finishedAt = new Date().toISOString();
    if (!report.passed && !report.error) report.error = report.stale ? '源码或 SDK 已变化，结果失效' : report.logsCleared ? '测试期间日志被清空，无法验证结果' : report.errors.length ? '运行时记录了错误，请查看报告日志' : report.logsTruncated ? '日志超出保留上限，无法证明运行期间没有错误' : report.captureError;
    await atomicJson(report.path, report);
    if (signal.aborted) throw failed('模拟测试已取消', report);
    if (!report.passed) throw failed(report.error || '模拟验证未通过', report);
    progress('模拟验证已完成，报告与截图已保存');
    return report;
  }
  async build(args) {
    const options = buildSchema.parse(args), w = this.workbench;
    w.projects.get(options.projectId);
    if (w.jobs.list().some(j=>j.projectId===options.projectId && j.status==='running' && ['build','check','pack','platform-prepare','deploy'].includes(j.type))) throw new Error('该项目已有检查或构建任务运行，请等待完成或取消任务');
    const job = w.jobs.start('build', options.projectId, async context => {
      const check = await w.checkNow(options.projectId, context);
      if (!check.passed || check.stale) throw failed('官方静态检查未通过或源码已变化，未生成安装包', { stage: 'check', check, uploaded: false, submittedForReview: false });
      context.signal.throwIfAborted(); context.progress('静态检查通过，正在生成 AIX');
      const artifact = await w.packNow(options.projectId, context);
      const project = await w.projects.refresh(options.projectId);
      if (artifact.revision!==check.revision || project.revision!==check.revision || artifact.toolchainId!==check.toolchainId || project.toolchainId!==check.toolchainId) throw failed('检查与打包期间源码或 SDK 已变化，请重新构建', { stage: 'pack', stale: true, check, artifact, uploaded: false, submittedForReview: false });
      const receipt = await w.platformReceipt(project, artifact);
      context.progress('本地 AIX 已生成，可上传为云端草稿');
      return { ...receipt, check, artifact, stale: false };
    });
    return w.jobs.wait(job.id, options.waitMs);
  }
}
