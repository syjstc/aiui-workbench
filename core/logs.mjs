import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';

export async function serviceLogStatus(home) {
  const file = path.join(home, 'service.log');
  const info = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return { size: 0 }; throw error; });
  return { path: file, bytes: info.size };
}

export async function clearServiceLog(home) {
  // Keep the inode: the daemon and its clients may still hold append handles.
  // Windows append-only handles cannot ftruncate. Open a writable handle
  // without O_TRUNC so existing daemon append handles keep the same file.
  const file = await fs.open(path.join(home, 'service.log'), constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    const { size: clearedBytes } = await file.stat();
    await file.truncate(0);
    return { ...await serviceLogStatus(home), clearedBytes };
  } finally { await file.close(); }
}
