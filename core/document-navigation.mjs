const readToc = (index, english) => {
  try { const value = JSON.parse(index.find(doc => doc.path === `documentation/toc${english ? '.en-US' : ''}.json`)?.content || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
};

export function documentNavigation(index, { locale = 'zh-CN', sort = 'recommended', revision } = {}) {
  const documents = index.map(({ path, title }) => ({ path, title, revision })), byPath = new Map(documents.map(doc => [doc.path, doc]));
  const used = new Set(), roots = [];
  const english = locale === 'en', label = (zh, en) => english ? en : zh;
  function claim(path) { if (!path || used.has(path)) return; used.add(path); return byPath.get(path); }
  function find(source, translated) {
    const base = source.replace(/\.en-US(?=\.md$)/, '');
    const candidates = [base, base + '.md', base + '/index.md'];
    return candidates.map(path => translated ? path.replace(/\.md$/, '.en-US.md') : path).find(path => byPath.has(path));
  }
  function official(translated) {
    const sections = readToc(index, translated), groups = [];
    function walk(node, section, parents = []) {
      if (!node || typeof node.id !== 'string') return null;
      const segments = [...parents, node.id];
      const source = 'documentation/' + (node.docPath || node.sourcePath || [section.id, ...segments].join('/'));
      const doc = claim(find(source, translated));
      const children = (Array.isArray(node.children) ? node.children : []).map(child => walk(child, section, segments)).filter(Boolean);
      if (!doc && !children.length) return null;
      return { id: `${translated ? 'en' : 'zh'}/${section.id}/${segments.join('/')}`, title: node.label || doc?.title || node.id, path: doc?.path, expanded: node.expanded === true, children };
    }
    for (const section of sections) {
      if (typeof section.id !== 'string') continue;
      const doc = claim(find(`documentation/${section.id}/index.md`, translated));
      const children = (section.children || []).map(node => walk(node, section)).filter(Boolean);
      if (doc || children.length) groups.push({ id: `${translated ? 'en' : 'zh'}/${section.id}`, title: section.label || section.id, path: doc?.path, expanded: false, children });
    }
    return groups;
  }
  roots.push(...official(english));
  // Keep the other translation accessible without doubling every visible row.
  const translations = official(!english);
  if (translations.length) roots.push({ id: 'translations', title: label('English 文档', '中文文档'), children: translations });
  const skill = { id: 'skill', title: label('开发 Skill 与示例', 'Development Skill & examples'), children: [] };
  const other = { id: 'other', title: label('补充资料与目录文件', 'Additional references & catalogs'), children: [] };
  function addFile(root, doc, segments) {
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      let folder = parent.children.find(node => node.id === parent.id + '/' + segment && !node.path);
      if (!folder) { folder = { id: parent.id + '/' + segment, title: segment, children: [] }; parent.children.push(folder); }
      parent = folder;
    }
    parent.children.push({ id: doc.path, title: doc.title, path: doc.path, children: [] });
    used.add(doc.path);
  }
  for (const doc of documents) if (!used.has(doc.path)) {
    const isSkill = doc.path.startsWith('skills/aiui-dev/');
    addFile(isSkill ? skill : other, doc, doc.path.replace(isSkill ? /^skills\/aiui-dev\// : /^documentation\//, '').split('/'));
  }
  if (skill.children.length) roots.push(skill);
  if (other.children.length) roots.push(other);
  const collator = new Intl.Collator(english ? 'en' : 'zh-CN', { numeric: true, sensitivity: 'base' });
  function finish(nodes) {
    for (const node of nodes) { finish(node.children); node.count = Number(Boolean(node.path)) + node.children.reduce((sum, child) => sum + child.count, 0); }
    if (sort !== 'recommended') nodes.sort((a, b) => collator.compare(sort === 'path' ? a.path || a.id : a.title, sort === 'path' ? b.path || b.id : b.title));
  }
  finish(roots);
  return { tree: roots, documents, total: documents.length, revision };
}
