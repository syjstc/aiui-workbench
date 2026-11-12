import fs from 'node:fs/promises';
import path from 'node:path';
import { inside, readJson } from './util.mjs';

const ICON_NAME = /^(?:app[-_])?(?:icon|logo)(?:[-_](?:v\d+|\d+(?:x\d+)?))*\.(png|jpe?g|webp|gif|svg|ico)$/i;
const MIME = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const MAX_BYTES = 2 * 1024 * 1024;
const ASSET_DIRECTORIES = ['assets', 'branding', 'icons'];

export function projectIconWatchPaths(project) {
  // MCP callers often import agent/ directly. Read only its conventional
  // sibling asset directories; keep the imported path as the deletion boundary.
  const siblings = project.projectPath === project.agentPath && path.basename(project.agentPath) === 'agent'
    ? ASSET_DIRECTORIES.map(directory => path.join(path.dirname(project.agentPath), directory)) : [];
  return [project.projectPath, ...siblings];
}

function variants(file) {
  const { dir, name, ext } = path.parse(file);
  if (!/[-_]\d+(?:x\d+)?$/.test(name)) return [file];
  const sizes = [256, 128, 512, 64].map(size => path.join(dir, name.replace(/([-_])\d+(?:x\d+)?$/, (_, separator) => separator + size) + ext));
  return [...new Set([...sizes, file])];
}

function rank(file) {
  const name = path.basename(file), version = Number(name.match(/[-_]v(\d+)/i)?.[1] || 0);
  const size = Number(name.match(/[-_](\d+)(?:x\d+)?\.[^.]+$/)?.[1] || 256);
  return { version, distance: Math.abs(Math.log2(size / 256)) };
}

// Branding lives outside agent/ in many projects. Only inspect common asset
// locations, and read image bytes after selecting a candidate.
export async function projectIcon(project, app, files = []) {
  const roots = [...new Set([project.agentPath, project.projectPath])];
  const candidates = [], images = files.filter(file => ICON_NAME.test(path.basename(file.path))).map(file => ({ file:path.join(project.agentPath, file.path), root:project.projectPath }));
  const manifests = [], visited = new Set();
  let remaining = 1500;
  async function scan(directory, depth, root = project.projectPath) {
    if (visited.has(directory) || remaining <= 0) return;
    visited.add(directory);
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
    const entries = await fs.readdir(directory, { withFileTypes:true }).catch(() => []);
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      if (--remaining < 0) break;
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isFile() && ICON_NAME.test(entry.name)) images.push({ file, root });
      else if (entry.isFile() && entry.name === 'current.json') manifests.push({ file, root });
      else if (entry.isDirectory() && depth > 0 && !['node_modules','output','artifacts','dist'].includes(entry.name)) await scan(file, depth - 1, root);
    }
  }
  if (typeof app.icon === 'string' && !path.isAbsolute(app.icon)) {
    for (const root of roots) candidates.push({ file:path.resolve(root, app.icon), root:project.projectPath });
  }
  for (const root of roots) {
    await scan(root, 0);
    for (const directory of ASSET_DIRECTORIES) await scan(path.join(root, directory), 2);
  }
  for (const root of projectIconWatchPaths(project).slice(1)) await scan(root, 2, root);
  for (const root of roots) candidates.push(...images.filter(({ file }) => path.dirname(file) === root && /^(?:app[-_])?(?:icon|logo)\./i.test(path.basename(file))));
  // A current.json selection takes precedence over historical icon versions.
  const selectedDirectories = new Set();
  for (const { file, root } of manifests) {
    const current = await readJson(file, null).catch(() => null);
    if (typeof current?.master !== 'string' || !ICON_NAME.test(path.basename(current.master))) continue;
    selectedDirectories.add(path.dirname(file));
    candidates.push(...variants(path.resolve(path.dirname(file), current.master)).map(file => ({ file, root })));
  }
  images.sort((a,b) => {
    const x = rank(a.file), y = rank(b.file);
    return y.version - x.version || x.distance - y.distance || a.file.localeCompare(b.file);
  });
  candidates.push(...images.filter(({ file }) => !selectedDirectories.has(path.dirname(file))));
  const seen = new Set();
  for (const { file:candidate, root } of candidates) {
    const key = JSON.stringify([candidate, root]);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const mime = MIME[path.extname(candidate).toLowerCase()];
      if (!mime) continue;
      const file = await inside(root, path.relative(root, candidate).split(path.sep).join('/'));
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) continue;
      const data = await fs.readFile(file);
      if (data.length > MAX_BYTES) continue;
      return { icon:`data:${mime};base64,${data.toString('base64')}`, iconPath:file };
    } catch { /* Missing, unreadable or external icons use the next candidate. */ }
  }
  return { icon:null, iconPath:null };
}
