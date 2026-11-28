// Shared by full-text search and the Markdown reader so result links use the
// same anchors, including repeated headings. Fenced examples are not headings.
export const headingId = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
export function headingSlugger() {
  const used = new Set();
  return text => {
    const base = headingId(text);
    let id = base, suffix = 0;
    while (used.has(id)) id = `${base}-${++suffix}`;
    used.add(id);
    return id;
  };
}
export const plainHeading = text => text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').replace(/[*_`~]/g, '').replace(/\s+#+\s*$/, '').trim();
export function documentHeadings(content) {
  const slug = headingSlugger(), headings = [];
  let fence = null, offset = 0;
  for (const line of content.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
    } else if (!fence) {
      const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*$/);
      if (match) {
        const title = plainHeading(match[2]);
        headings.push({ title, id: slug(title), level: match[1].length, offset });
      }
    }
    offset += line.length + 1;
  }
  return headings;
}

const headingText = node => typeof node?.value === 'string' ? node.value : (node?.children || []).map(headingText).join('');
export function remarkHeadingAnchors({ title, removedTitle } = {}) {
  return tree => {
    const slug = headingSlugger();
    if (removedTitle) slug(plainHeading(title));
    function walk(node) {
      if (node.type === 'heading') node.data = { ...node.data, hProperties: { id: slug(plainHeading(headingText(node))) } };
      for (const child of node.children || []) walk(child);
    }
    walk(tree);
  };
}
