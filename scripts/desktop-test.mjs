import { _electron } from 'playwright';
import path from 'node:path';
import { normalizeEnvironment, run, sleep } from '../core/util.mjs';

const nativeProcesses = new WeakMap();

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
  const closing = app.close();
  try { await bounded(closing, 10000); }
  catch {
    const child = app.process();
    // On Windows Playwright tracks a cmd.exe launcher, which may have exited
    // before Electron and its pipe-owning children. Track the actual app PID.
    const pid = nativeProcesses.get(app) || child?.pid;
    if (process.platform === 'win32' && pid) await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { timeout: 10000 }).catch(() => {});
    else if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    // A shell that exited before Playwright attached cannot emit close twice.
    // Verify the owned native process itself instead of waiting on that shell.
    if (pid) {
      let exited = false;
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') { exited = true; break; } throw error; }
        await sleep(100);
      }
      if (!exited) throw new Error('The isolated native desktop process did not exit');
    }
  }
  nativeProcesses.delete(app);
}

export async function launchDesktop(options) {
  const env = normalizeEnvironment(options.env || process.env);
  // Windows treats an empty value as enabling Electron's Node-only mode.
  if (!env.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ ...options, env, timeout: 45000 });
  nativeProcesses.set(app, await bounded(app.evaluate(() => process.pid), 5000));
  return app;
}
