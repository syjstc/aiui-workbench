import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../core/util.mjs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
if (!files.length) throw new Error('No public source files found.');
const errors = [];
for (const file of files) {
  if (/(?:^|\/)(?:node_modules|\.local|output|\.aix|\.mcp\.json|\.env(?:\..*)?)\b/.test(file) && file !== '.env.packaging.example') errors.push(file + ': local data or credentials path');
  if (/\.(?:p8|p12|pfx|keychain-db)$/.test(file)) errors.push(file + ': signing credential file');
  const bytes = await fs.readFile(path.join(ROOT, file));
  if (bytes.length > 20 * 1024 * 1024) errors.push(file + ': generated binary larger than 20 MB');
  if (bytes.includes(0) || /\.(?:png|icns|ico|jpg|jpeg|webp|wasm)$/.test(file)) continue;
  const text = bytes.toString();
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})/.test(text)) errors.push(file + ': credential-like content');
  if (/\/Users\/[^/]+\/(?:Documents|Library|\.codex)\//.test(text)) errors.push(file + ': private absolute path');
  if (/\.\.\/games\/|games\/(?:treasure-hunt|spirit-catcher|nature-atlas|bahuang)/.test(text)) errors.push(file + ': dependency on a separate application');
}
if (errors.length) throw new Error(errors.join('\n'));
console.log(`Public source check passed: ${files.length} files; no local profiles, signing credentials, private paths or sibling app dependencies.`);
