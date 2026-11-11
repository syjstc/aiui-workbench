import fs from 'node:fs/promises';
import path from 'node:path';

export async function serviceLogStatus(home) {
  const file = path.join(home, 'service.log');
  const info = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return { size: 0 }; throw error; });
  return { path: file, bytes: info.size };
}

export async function clearServiceLog(home) {
  // Keep the inode: the daemon and its clients may still hold append handles.
  const file = await fs.open(path.join(home, 'service.log'), 'a', 0o600);
  try {
    const { size: clearedBytes } = await file.stat();
    await file.truncate(0);
    return { ...await serviceLogStatus(home), clearedBytes };
  } finally { await file.close(); }
}
