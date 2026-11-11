const localOrigin = 'https://reference.local';
const officialHosts = new Set(['js.rokid.com', 'yodaos-project.github.io', 'jsar-project.github.io']);

// Parse links without fetching remote content. Only known documentation sources
// can be translated to a path in the current, verified snapshot.
export function documentLink(href, from = '') {
  if (typeof href !== 'string' || !href || href.includes('\\')) return null;
  let url;
  try { url = new URL(href, `${localOrigin}/${from}`); } catch { return null; }
  if (url.username || url.password || url.port) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (pathname.includes('\\') || pathname.includes('\0')) return null;
  if (url.origin !== localOrigin) {
    if (url.protocol !== 'https:') return null;
    if (officialHosts.has(url.hostname) && /^\/AIUI(?:\/|$)/.test(pathname)) {
      // The public site uses slugs, while the snapshot retains repository paths.
    } else {
      const github = url.hostname === 'github.com' && pathname.match(/^\/(?:yodaos-project|jsar-project)\/AIUI\/(?:blob|tree)\/(?:main|master|[a-f0-9]{40})\/(.+)$/);
      const raw = url.hostname === 'raw.githubusercontent.com' && pathname.match(/^\/(?:yodaos-project|jsar-project)\/AIUI\/(?:main|master|[a-f0-9]{40})\/(.+)$/);
      if (!github && !raw) return null;
      pathname = '/' + (github || raw)[1];
    }
  }
  return { pathname: pathname.replace(/\/$/, ''), fragment: url.hash, language: url.searchParams.get('lang') || (/\.en-US\.md$/.test(from) ? 'en-US' : 'zh-CN') };
}

export function documentCatalog(index) {
  const paths = new Set(index.map(doc => doc.path)), routes = new Map(), order = new Map();
  const add = (route, source) => {
    const candidates = [source, source + '.md', source + '/index.md'];
    const target = candidates.find(candidate => paths.has(candidate));
    if (!target) return;
    if (!order.has(target)) order.set(target, order.size);
    for (const alias of [route, route.replace(/^\/AIUI/, '')]) if (!routes.has(alias)) routes.set(alias, target);
  };
  const toc = index.find(doc => doc.path === 'documentation/toc.json');
  let sections = [];
  try { sections = JSON.parse(toc?.content || '[]'); } catch { /* Older snapshots can still use direct paths. */ }
  if (!Array.isArray(sections)) sections = [];
  for (const section of sections) {
    const base = `/AIUI/${section.slug || section.id.replace(/^\d+-/, '')}`;
    add(base, `documentation/${section.id}/index.md`);
    function walk(nodes, parents = []) {
      for (const node of nodes || []) {
        const segments = [...parents, node.id];
        const source = 'documentation/' + (node.docPath || node.sourcePath || [section.id, ...segments].join('/'));
        add(`${base}/${node.docId || segments.join('-')}`, source);
        add(`${base}/${segments.join('/')}`, source);
        walk(node.children, segments);
      }
    }
    walk(section.children);
    if (!routes.has(base)) {
      const first = [...routes].find(([route]) => route.startsWith(base + '/'))?.[1];
      if (first) add(base, first);
    }
  }
  // Also cover pages not listed in the TOC, including API category overviews.
  for (const doc of index) {
    if (!/^documentation\/\d+-.*(?<!\.en-US)\.md$/.test(doc.path)) continue;
    const [sectionId, ...segments] = doc.path.replace(/^documentation\//, '').replace(/\.md$/, '').split('/');
    if (segments.at(-1) === 'index') segments.pop();
    const section = sections.find(item => item.id === sectionId);
    const base = `/AIUI/${section?.slug || sectionId.replace(/^\d+-/, '')}`;
    add(base + (segments.length ? '/' + segments.join('-') : ''), doc.path);
    add(base + (segments.length ? '/' + segments.join('/') : ''), doc.path);
  }
  for (const [source, rank] of [...order]) {
    const english = source.replace(/\.md$/, '.en-US.md');
    if (paths.has(english)) order.set(english, rank);
  }
  return { paths, routes, order };
}

export function resolveDocumentLink(link, catalog) {
  const route = link.pathname.replace(/\.(?:html|md)$/, '');
  let target = catalog.routes.get(route);
  const publicRoute = Boolean(target);
  if (!target) {
    const relative = link.pathname.replace(/^\//, '');
    target = [relative, relative + '.md', relative + '/index.md'].find(candidate => catalog.paths.has(candidate));
  }
  if (!target) return null;
  if (publicRoute && link.language === 'en-US' && target.endsWith('.md') && !target.endsWith('.en-US.md')) {
    const english = target.replace(/\.md$/, '.en-US.md');
    if (catalog.paths.has(english)) target = english;
  }
  return { path: target, fragment: link.fragment };
}
