const officialName = /^aiui-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const workflowName = 'aiui-workshop';
const skillFile = /^skills\/(aiui-[a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/;

export function isOfficialSkillName(name) {
  return typeof name === 'string' && name !== workflowName && name.length <= 64 && officialName.test(name);
}

export function officialSkillFile(file) {
  const match = file.match(skillFile);
  if (!match || !isOfficialSkillName(match[1]) || match[2].split('/').some(part => !part || part.startsWith('.'))) return null;
  return { name: match[1], relative: match[2] };
}

export function skillMetadata(content) {
  const header = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const field = name => (header.match(new RegExp('^' + name + ':[ \\t]*([^\\r\\n]+)', 'm'))?.[1] || '').trim().replace(/^(["'])(.*)\1$/, '$2');
  return { name: field('name'), description: field('description') };
}

export function officialSkillBundles(index) {
  const bundles = new Map();
  for (const document of index) {
    const file = officialSkillFile(document.path);
    if (!file) continue;
    const bundle = bundles.get(file.name) || { documents: [], entry: null };
    bundle.documents.push(document);
    if (file.relative === 'SKILL.md' && skillMetadata(document.content).name === file.name) bundle.entry = document;
    bundles.set(file.name, bundle);
  }
  return new Map([...bundles].filter(([, bundle]) => bundle.entry));
}

export async function officialSkillCatalog(knowledge, pinnedRevision) {
  const current = knowledge.meta.revision;
  const revision = pinnedRevision || current;
  const preferred = officialSkillBundles(await knowledge.index(revision));
  const available = revision === current ? preferred : officialSkillBundles(await knowledge.index(current));
  return [...new Set([...preferred.keys(), ...available.keys()])].sort().map(name => {
    const pinned = preferred.get(name);
    const entry = (pinned || available.get(name)).entry;
    return {
      name, path: entry.path, revision: pinned ? revision : current,
      description: skillMetadata(entry.content).description.slice(0, 250),
    };
  });
}
