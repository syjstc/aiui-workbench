import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Projects } from '../core/projects.mjs';
import { atomicJson, sleep } from '../core/util.mjs';

const image = color => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${color}"/></svg>`;
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-project-icon-')));
  const directory = path.join(root, 'project'), agent = path.join(directory, 'agent');
  await fs.mkdir(agent, { recursive:true });
  await atomicJson(path.join(agent, 'app.json'), { name:'Icon project', pages:['pages/index/index'] });
  const projects = await new Projects(path.join(root, 'home'), (event, detail) => { if (event === 'log') t.diagnostic(detail.message); }).init();
  t.after(async () => { await projects.close(); await fs.rm(root, { recursive:true, force:true }); });
  return { root, directory, agent, projects };
}

test('project branding follows current.json and refreshes without invalidating source checks', async t => {
  const { directory, projects } = await fixture(t), branding = path.join(directory, 'assets/branding/app');
  await fs.mkdir(branding, { recursive:true });
  for (const version of [1, 2, 3]) await fs.writeFile(path.join(branding, `icon-v${version}-256.svg`), image(['red','green','blue'][version - 1]));
  await atomicJson(path.join(branding, 'current.json'), { master:'icon-v2-1024.svg' });
  const project = await projects.import(directory), revision = project.revision;
  await new Promise(resolve => projects.watchers.get(project.id).watcher.once('ready', resolve));
  assert.equal(project.iconPath, path.join(branding, 'icon-v2-256.svg'));
  assert.equal(project.icon, 'data:image/svg+xml;base64,' + Buffer.from(image('green')).toString('base64'));
  project.lastCheck = { passed:true, stale:false };
  await atomicJson(path.join(branding, 'current.json'), { master:'icon-v1-1024.svg' });
  for (let i = 0; i < 50 && !project.iconPath.endsWith('icon-v1-256.svg'); i++) await sleep(100);
  assert.equal(project.iconPath, path.join(branding, 'icon-v1-256.svg'));
  assert.equal(project.revision, revision);
  assert.equal(project.lastCheck.stale, false);
  await atomicJson(path.join(branding, 'current.json'), { master:'icon-v3-1024.svg' });
  for (let i = 0; i < 50 && !project.iconPath.endsWith('icon-v3-256.svg'); i++) await sleep(100);
  assert.equal(project.iconPath, path.join(branding, 'icon-v3-256.svg'), 'later atomic saves also refresh');
  await fs.unlink(project.iconPath);
  await projects.refresh(project.id);
  assert.equal(project.icon, null, 'do not silently restore a superseded branding version');
});

test('configured and conventional icons work across project and agent directories', async t => {
  const { directory, agent, projects } = await fixture(t);
  await fs.writeFile(path.join(directory, 'icon.svg'), image('blue'));
  await fs.mkdir(path.join(agent, 'pages/index'), { recursive:true });
  await fs.writeFile(path.join(agent, 'pages/index/icon.svg'), image('red'));
  await fs.writeFile(path.join(agent, 'custom.svg'), image('green'));
  await atomicJson(path.join(agent, 'app.json'), { name:'Icon project', icon:'custom.svg', pages:[] });
  const project = await projects.import(directory);
  assert.equal(project.iconPath, path.join(agent, 'custom.svg'));
  await fs.unlink(project.iconPath);
  await projects.refresh(project.id);
  assert.equal(project.iconPath, path.join(directory, 'icon.svg'));
  await fs.unlink(project.iconPath);
  await projects.refresh(project.id);
  assert.equal(project.iconPath, path.join(agent, 'pages/index/icon.svg'));
});

test('direct agent imports discover and watch sibling branding without changing the binding or source revision', async t => {
  const { directory, agent, projects } = await fixture(t), branding = path.join(directory, 'assets/branding/app');
  await fs.mkdir(branding, { recursive:true });
  for (const version of [1, 2]) await fs.writeFile(path.join(branding, `icon-v${version}-256.svg`), image(version === 1 ? 'red' : 'green'));
  await atomicJson(path.join(branding, 'current.json'), { master:'icon-v2-1024.svg' });
  const project = await projects.import(agent), revision = project.revision;
  await new Promise(resolve => projects.watchers.get(project.id).watcher.once('ready', resolve));
  assert.equal(project.projectPath, agent);
  assert.equal(project.agentPath, agent);
  assert.equal(project.iconPath, path.join(branding, 'icon-v2-256.svg'));
  project.lastCheck = { passed:true, stale:false };
  await atomicJson(path.join(branding, 'current.json'), { master:'icon-v1-1024.svg' });
  for (let i = 0; i < 50 && project.iconPath !== path.join(branding, 'icon-v1-256.svg'); i++) await sleep(100);
  assert.equal(project.iconPath, path.join(branding, 'icon-v1-256.svg'));
  assert.equal(project.revision, revision);
  assert.equal(project.lastCheck.stale, false);
  await projects.close();
  const restored = await new Projects(projects.home, () => {}).init();
  t.after(() => restored.close());
  assert.equal(restored.get(project.id).iconPath, project.iconPath);
  assert.equal(restored.get(project.id).projectPath, agent);
  assert.equal((await restored.import(directory)).id, project.id);
  assert.equal(restored.list().length, 1);
});

test('inferred sibling branding rejects symlinks and manifest paths outside its asset directory', async t => {
  const { root, directory, agent, projects } = await fixture(t), assets = path.join(directory, 'assets');
  const outside = path.join(root, 'private');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'icon.svg'), image('red'));
  await fs.symlink(outside, assets, process.platform === 'win32' ? 'junction' : 'dir');
  const project = await projects.import(agent);
  assert.equal(project.icon, null);
  await fs.rm(assets, { recursive:true, force:true });
  await fs.mkdir(assets);
  await fs.writeFile(path.join(directory, 'icon-v1-256.svg'), image('blue'));
  await atomicJson(path.join(assets, 'current.json'), { master:'../icon-v1-256.svg' });
  await projects.refresh(project.id);
  assert.equal(project.icon, null);
  await fs.writeFile(path.join(assets, 'icon.svg'), image('green'));
  const standalone = path.join(directory, 'standalone');
  await fs.mkdir(standalone);
  await atomicJson(path.join(standalone, 'app.json'), { name:'Standalone', pages:[] });
  assert.equal((await projects.import(standalone)).icon, null, 'standalone apps do not inherit another project’s branding');
});

test('icons cannot read outside the imported project or load oversized files', async t => {
  const { root, directory, agent, projects } = await fixture(t), outside = path.join(root, 'private.svg');
  await fs.writeFile(outside, image('red'));
  await fs.symlink(root, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await atomicJson(path.join(agent, 'app.json'), { name:'Icon project', icon:'linked/private.svg', pages:[] });
  const project = await projects.import(directory);
  assert.equal(project.icon, null);
  await fs.rm(path.join(directory, 'linked'), { recursive: true, force: true });
  await fs.writeFile(path.join(directory, 'icon.svg'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await projects.refresh(project.id);
  assert.equal(project.icon, null);
  await fs.writeFile(path.join(directory, 'icon.svg'), image('blue'));
  await projects.refresh(project.id);
  assert.equal(project.iconPath, path.join(directory, 'icon.svg'));
});
