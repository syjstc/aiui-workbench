import { spawn } from 'node:child_process';
import { _electron, chromium } from 'playwright';

export async function launchDesktop(options) {
  const env = { ...options.env };
  // On Windows an empty value still enables Electron's Node-only mode.
  if (!env.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  options = { ...options, env };
  if (process.platform !== 'win32' || !options.executablePath) return _electron.launch(options);
  // Playwright's Electron launcher uses cmd.exe on Windows. Launch the native
  // app directly so an empty PATH tests the app without a shell dependency.
  const child = spawn(options.executablePath, ['--remote-debugging-port=0', ...(options.args || [])], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Desktop startup timed out: ' + output)); }, 45000);
    const finish = (error, value) => { clearTimeout(timer); child.removeListener('exit', exited); error ? reject(error) : resolve(value); };
    const exited = code => finish(new Error('Desktop exited before opening DevTools (' + code + '): ' + output));
    child.once('error', error => finish(error)); child.once('exit', exited);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) finish(null, match[1]); });
  });
  const browser = await chromium.connectOverCDP(endpoint);
  return {
    async firstWindow() { const context = browser.contexts()[0]; return context.pages()[0] || await context.waitForEvent('page', { timeout: 45000 }); },
    process: () => child,
    async close() { await browser.close().catch(() => {}); if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; } },
  };
}
