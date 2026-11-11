import { _electron } from 'playwright';
import path from 'node:path';
import { normalizeEnvironment, run } from '../core/util.mjs';

export function portableEnvironment(home) {
  const env = normalizeEnvironment({ ...process.env, AIUI_WORKBENCH_HOME: home });
  for (const key of Object.keys(env)) if (/^(path|android_home|android_sdk_root|electron_run_as_node)$/i.test(key)) delete env[key];
  // Keep Windows' own utilities available, without Node, npm, SDK or ADB.
  const system = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  env.PATH = process.platform === 'win32' ? [system, path.join(system, 'System32'), path.join(system, 'System32/Wbem'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(';') : '';
  return env;
}

export async function bounded(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Desktop operation timed out')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function closeDesktop(app) {
  if (!app) return;
  try { await bounded(app.close(), 10000); }
  catch {
    const child = app.process();
    if (child?.pid && child.exitCode === null) {
      if (process.platform === 'win32') await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 }).catch(() => {});
      else child.kill('SIGKILL');
    }
  }
}

export async function launchDesktop(options) {
  const env = normalizeEnvironment(options.env || process.env);
  // Windows treats an empty value as enabling Electron's Node-only mode.
  if (!env.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ ...options, env, timeout: 45000 });
}
