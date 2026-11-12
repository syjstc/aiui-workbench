import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';

export const PLATFORM_API = Object.freeze({
  agents: 'https://rcs.rokid.com/metis/agent/getAIUIAgentList',
  save: 'https://rcs.rokid.com/metis/agent/updateThirdAgent',
  sts: 'https://rcs.rokid.com/metis/user/oss/getOssSts',
  review: 'https://rcs.rokid.com/agentStore/developer/cozePublish',
});
export const md5 = bytes => createHash('md5').update(bytes).digest('hex');
export function businessOK(value) {
  return value && [0, 1].includes(value.code) && (!value.msg && !value.desc || /^(success|成功)$/i.test(value.msg || value.desc));
}
export function mediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || !/(?:^|\.)(?:rokidcdn\.com|rokid\.com|aliyuncs\.com)$/.test(url.hostname)) throw new Error('平台返回了不可信的素材地址');
  return url.href;
}
// Studio expands this stored OSS key into a short-lived signed URL on every
// read. Keep only its validated key so signatures never enter AI results or
// confirmation fingerprints. Other media URLs remain query-free.
export function codeDraftPath(value, agentId) {
  let relative=value;
  if(/^https:\/\//i.test(value)){
    const url=new URL(value);url.search='';
    relative=new URL(mediaUrl(url.href)).pathname.replace(/^\/+/,'');
  }
  if(typeof relative!=='string')throw new Error('云端代码草稿地址无效');
  const parts=relative.split('/'),name=parts.at(-1);
  if(parts.at(-2)!=='cache'||!name.startsWith(agentId+'-cache-v')||!name.endsWith('.zip')||parts.some(p=>!p||p==='.'||p==='..'||!/^[A-Za-z0-9._-]+$/.test(p)))throw new Error('云端代码草稿地址不符合当前智能体身份');
  return relative;
}

function movieDuration(bytes) {
  function boxes(start, end) {
    for (let offset = start; offset + 8 <= end;) {
      let size = bytes.readUInt32BE(offset), header = 8;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (size === 1) { if (offset + 16 > end) break; size = Number(bytes.readBigUInt64BE(offset + 8)); header = 16; }
      if (size === 0) size = end - offset;
      if (!Number.isSafeInteger(size) || size < header || offset + size > end) break;
      if (type === 'moov') { const duration = boxes(offset + header, offset + size); if (duration !== null) return duration; }
      if (type === 'mvhd') {
        const base = offset + header, version = bytes[base], scaleAt = base + (version === 1 ? 20 : 12), durationAt = scaleAt + 4;
        if (![0, 1].includes(version) || durationAt + (version === 1 ? 8 : 4) > offset + size) return null;
        const scale = bytes.readUInt32BE(scaleAt), duration = version === 1 ? Number(bytes.readBigUInt64BE(durationAt)) : bytes.readUInt32BE(durationAt);
        return scale && Number.isFinite(duration) ? duration / scale : null;
      }
      offset += size;
    }
    return null;
  }
  return boxes(0, bytes.length);
}
export async function readMedia(file, icon = false) {
  if (!path.isAbsolute(file)) throw new Error('素材必须使用本机绝对路径');
  const info = await fs.lstat(file), extension = path.extname(file).toLowerCase(), video = extension === '.mp4';
  if (!info.isFile() || !['.png', '.jpg', '.jpeg', ...(icon ? [] : ['.mp4'])].includes(extension) || info.size < 1024 || info.size > (video ? 50 : 5) * 1024 * 1024) throw new Error('素材须为 1 KB–5 MB 的 PNG/JPG 或 1 KB–50 MB 的 MP4');
  const bytes = await fs.readFile(file);
  if (extension === '.png' && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || /jpe?g/.test(extension) && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) || video && bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('素材内容与扩展名不一致');
  const durationSeconds = video ? movieDuration(bytes) : undefined;
  if (video && (!durationSeconds || durationSeconds > 60)) throw new Error('视频时长必须可读取且不超过 60 秒');
  return { bytes, extension, type: video ? 'video' : 'image', mime: video ? 'video/mp4' : extension === '.png' ? 'image/png' : 'image/jpeg', md5: md5(bytes), durationSeconds };
}

// Use the same account-scoped STS and OSS V1 signing as Studio's ali-oss client.
// Credentials never leave this call or appear in records returned to AI tools.
export async function putMedia(sts, media, { fetcher = fetch, signal, objectKey } = {}) {
  const { bucketName: bucket, region, accessKey, secretKey, sessionToken, directory, cdnUrl } = sts || {};
  const parts=typeof directory==='string'?directory.replace(/\/$/,'').split('/'):[];
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket) || !/^oss-[a-z0-9-]+$/.test(region) || ![accessKey, secretKey, sessionToken].every(v => typeof v === 'string' && v) || !parts.length || parts.some(p=>!p||p==='.'||p==='..'||!/^[A-Za-z0-9._-]+$/.test(p))) throw new Error('平台上传凭证格式无效');
  const prefix=parts.join('/');
  const key = objectKey || `${prefix}/workbench-${randomUUID()}${media.extension}`;
  if(objectKey&&(!key.startsWith(prefix+'/cache/')||!/^cache\/[A-Za-z0-9._-]+\.zip$/.test(key.slice(prefix.length+1))))throw new Error('代码草稿超出官方上传目录');
  const url = mediaUrl(cdnUrl.replace(/\/$/, '') + '/' + key), date = new Date().toUTCString(), digest = Buffer.from(media.md5, 'hex').toString('base64');
  const canonical = `PUT\n${digest}\n${media.mime}\n${date}\nx-oss-security-token:${sessionToken}\n/${bucket}/${key}`;
  const signature = createHmac('sha1', secretKey).update(canonical).digest('base64');
  const response = await fetcher(`https://${bucket}.${region}.aliyuncs.com/${key}`, { method: 'PUT', redirect: 'error', signal, headers: { 'Content-Type': media.mime, 'Content-MD5': digest, Date: date, 'x-oss-security-token': sessionToken, Authorization: `OSS ${accessKey}:${signature}` }, body: media.bytes });
  if (!response.ok) { await response.body?.cancel();throw Object.assign(new Error(`官方资源上传失败：HTTP ${response.status}`),{httpStatus:response.status}); }
  if(response.headers.get('etag')?.replaceAll('"', '').toLowerCase() !== media.md5)throw new Error('资源上传摘要无法核实，请稍后重试');
  await response.body?.cancel();
  return { type: media.type, url, objectKey:key, md5: media.md5, bytes: media.bytes.length, ...(media.durationSeconds ? { durationSeconds: media.durationSeconds } : {}) };
}
