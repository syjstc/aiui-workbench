import { _electron } from 'playwright';
import { normalizeEnvironment } from '../core/util.mjs';

export async function launchDesktop(options) {
  const env = normalizeEnvironment(options.env || process.env);
  // Windows treats an empty value as enabling Electron's Node-only mode.
  if (!env.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ ...options, env, timeout: 45000 });
}
