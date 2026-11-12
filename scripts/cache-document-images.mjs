import fs from 'node:fs/promises';
import path from 'node:path';
import { Knowledge } from '../core/knowledge.mjs';
import { ROOT, atomicJson } from '../core/util.mjs';

// Refresh image assets for the already pinned, reviewed documentation snapshot.
// Text, its revision and sync dates stay tied to the original snapshot.
const metadataFile = path.join(ROOT, 'vendor/official/current.json');
const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
const snapshot = path.join(ROOT, 'vendor/official', metadata.revision);
const index = JSON.parse(await fs.readFile(path.join(snapshot, 'index.json'), 'utf8'));
const knowledge = new Knowledge(path.join(ROOT, '.local/official-document-images'));
knowledge.meta = metadata;
try {
  const images = await knowledge.cacheImages(index, metadata.revision, knowledge.controller.signal, message => console.log(message));
  await fs.copyFile(path.join(knowledge.dir, metadata.revision, 'images.json'), path.join(snapshot, 'images.json'));
  for (const entry of await knowledge.imageManifest(metadata.revision)) {
    const source = path.join(knowledge.dir, metadata.revision, entry.path);
    if (!await fs.access(source).then(() => true, () => false)) continue;
    const target = path.join(snapshot, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target);
  }
  await atomicJson(metadataFile, { ...metadata, images });
  console.log(JSON.stringify({ revision: metadata.revision, images }, null, 2));
  if (images.missing.length) process.exitCode = 1;
} finally { await knowledge.close(); }
