import path from 'node:path';
import { ROOT } from '../core/util.mjs';

export function packagedPaths({ platform = process.platform, arch = process.arch, output = process.env.AIUI_PACKAGE_OUTPUT || 'output/desktop' } = {}) {
  const directory = path.resolve(ROOT, output, `AIUI Workshop-${platform}-${arch}`);
  const bundle = platform === 'darwin' ? path.join(directory, 'AIUI Workshop.app') : directory;
  return {
    directory, bundle,
    executablePath: process.env.AIUI_QA_EXECUTABLE || (platform === 'darwin' ? path.join(bundle, 'Contents/MacOS/AIUI Workshop') : path.join(bundle, 'AIUI Workshop' + (platform === 'win32' ? '.exe' : ''))),
    appRoot: platform === 'darwin' ? path.join(bundle, 'Contents/Resources/app') : path.join(bundle, 'resources/app'),
  };
}
