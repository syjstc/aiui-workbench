import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { Zip, ZipDeflate } from 'fflate';

// A portable ZIP writer: does not depend on PowerShell, keeps dotfiles, and
// streams large Electron binaries instead of buffering the entire application.
export async function zipDirectory(directory, target) {
  const output = createWriteStream(target);
  const completion = finished(output); completion.catch(() => {});
  let failure;
  output.on('error', error => { failure = error; });
  const zip = new Zip((error, data, final) => {
    if (error) { failure = error; output.destroy(error); return; }
    output.write(data);
    if (final) output.end();
  });
  async function flush() { if (failure) throw failure; if (output.writableNeedDrain) await once(output, 'drain'); }
  async function visit(folder, prefix) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name), name = prefix + '/' + entry.name;
      if (entry.isDirectory()) await visit(filename, name);
      else if (entry.isFile()) {
        const member = new ZipDeflate(name, { level: 6 });
        zip.add(member); await flush();
        for await (const chunk of createReadStream(filename)) { member.push(chunk); await flush(); }
        member.push(new Uint8Array(), true); await flush();
      } else throw new Error('Unsupported archive entry: ' + filename);
    }
  }
  try { await visit(directory, path.basename(directory)); zip.end(); await completion; }
  catch (error) { zip.terminate(); output.destroy(); await completion.catch(() => {}); await fs.rm(target, { force: true }); throw error; }
}
