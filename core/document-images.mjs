const origin = 'https://reference.local';
export const isDocumentImage = path => /^documentation\/image\/.+\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(path);
export function documentImagePath(href, from) {
  if (typeof href !== 'string' || !href || href.includes('\\') || href.includes('\0')) return null;
  let url, pathname;
  try { url = new URL(href, `${origin}/${from}`); pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (url.username || url.password || url.port || pathname.includes('\\') || pathname.includes('\0')) return null;
  if (url.origin !== origin) {
    if (url.protocol !== 'https:') return null;
    if (['js.rokid.com', 'yodaos-project.github.io', 'jsar-project.github.io'].includes(url.hostname) && pathname.startsWith('/AIUI/image/')) pathname = '/documentation/' + pathname.slice('/AIUI/'.length);
    else {
      const match = url.hostname === 'raw.githubusercontent.com' && pathname.match(/^\/(?:yodaos-project|jsar-project)\/AIUI\/(?:main|master|[a-f0-9]{40})\/(documentation\/image\/.+)$/);
      if (!match) return null;
      pathname = '/' + match[1];
    }
  }
  const relative = pathname.replace(/^\//, '');
  return isDocumentImage(relative) && !relative.split('/').some(part => part === '..' || part === '.') ? relative : null;
}
export function documentImages(document) {
  const images = new Set();
  for (const match of document.content.matchAll(/!\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\)|<img\b[^>]*\bsrc=["']([^"']+)/g)) {
    const path = documentImagePath(match[1] || match[2], document.path);
    if (path) images.add(path);
  }
  return images;
}
export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))) return 'image/avif';
  if (/^(?:\s*<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(bytes.toString('utf8'))) return 'image/svg+xml';
  throw new Error('官方图片格式无效');
}
