import { documentCatalog } from './document-links.mjs';
import { documentHeadings } from './document-content.mjs';

// Local vocabulary bridges the names in prose and the identifiers in examples.
// Search always reads the entire immutable snapshot, never the reader's pages.
const concepts = [
  ['摄像头', '相机', 'camera', 'mediadevices', 'getusermedia'],
  ['拍照', '照片', 'photo', 'takephoto', 'imagecapture', 'take a photo'],
  ['录音', 'recording', 'mediarecorder', '麦克风', 'microphone'],
  ['语音识别', '语音转文字', 'asr', 'speechrecognition', 'speech recognition'],
  ['语音播报', '语音合成', '文字转语音', 'tts', 'speechsynthesis', 'speech synthesis'],
  ['大语言模型', '大模型', 'llm', 'languagemodel', 'language model'],
  ['蓝牙', 'bluetooth'], ['定位', '地理位置', 'geolocation'],
  ['加速度计', '加速度', 'accelerometer'], ['陀螺仪', 'gyroscope'],
  ['头部姿态', '头部转动', '头动', '头姿', 'absoluteorientation', 'deviceorientation'],
  ['触摸', '点击', 'tap'], ['滑动', '滑动手势', 'swipe'],
  ['本地存储', '存储', 'localstorage', 'storage'], ['权限', 'permission', 'permissions'],
  ['网络请求', '请求网络', 'fetch', 'http'], ['画布', 'canvas'],
  ['生命周期', 'lifecycle'], ['全彩', '全彩眼镜', 'full-color'],
  ['打包', '构建包', 'package', 'aix'], ['样式', '样式表', 'wxss'],
];
const vocabulary = concepts.flatMap(group => group.map(term => ({ term, group }))).sort((a, b) => b.term.length - a.term.length);
const stopWords = new Set('如何 怎么 怎样 什么 哪个 哪些 能不能 是否 请 请问 使用 调用 一个 一种 的 了 我 想 要 能 可以 需要 实现 进行 帮 帮我 文档 说明 有关 关于 来 在 中 和 与 或 把 将 让 how do does can could i we you to a an the use using please with for of is are in'.split(' '));
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
export function searchTerms(query) {
  let remaining = String(query).normalize('NFKC').toLowerCase().trim();
  const terms = [];
  for (const { term, group } of vocabulary) {
    const at = remaining.indexOf(term);
    if (at < 0) continue;
    // Short Latin aliases must not match inside unrelated identifiers/words.
    if (/^[a-z ]+$/.test(term) && /[a-z0-9_]/.test((remaining[at - 1] || '') + (remaining[at + term.length] || ''))) continue;
    terms.push({ term, alternatives: [term, ...group.filter(item => item !== term)] });
    remaining = remaining.replaceAll(term, ' ');
  }
  // Segmenters can split a helper such as “调用” into “调 / 用”. Remove
  // question phrases before segmentation so English-only pages still match.
  for (const word of [...stopWords].filter(word => /\p{Script=Han}/u.test(word) && word.length > 1).sort((a, b) => b.length - a.length)) remaining = remaining.replaceAll(word, ' ');
  for (const word of segmenter.segment(remaining)) if (word.isWordLike && !stopWords.has(word.segment)) terms.push({ term: word.segment, alternatives: [word.segment] });
  if (!terms.length && remaining.trim()) terms.push({ term: remaining.trim(), alternatives: [remaining.trim()] });
  const seen = new Set();
  return terms.filter(item => { const key = [...item.alternatives].sort().join('|'); if (seen.has(key)) return false; seen.add(key); return true; });
}

export class DocumentSearch {
  constructor(index) {
    this.order = documentCatalog(index).order;
    this.entries = index.map(document => {
      const headings = documentHeadings(document.content);
      return { document, headings, title: document.title.toLowerCase(), path: document.path.toLowerCase(), body: document.content.toLowerCase(), headingText: headings.map(heading => heading.title).join('\n').toLowerCase() };
    });
  }
  search(query = '', { limit = 16, offset = 0, sort = 'recommended', locale = 'zh-CN', revision } = {}) {
    const terms = searchTerms(query), phrase = String(query).toLowerCase().trim();
    const documents = [];
    for (const entry of this.entries) {
      const { document, headings, title, path, body, headingText } = entry;
      let score = 0;
      const matchedTerms = new Set(), positions = [];
      let matched = true;
      for (const { term, alternatives } of terms) {
        let best = 0;
        for (const alternative of alternatives) {
          const at = body.indexOf(alternative);
          const weight = alternative === term ? 1 : 0.72;
          const value = weight * ((title.includes(alternative) ? 120 : 0) + (path.includes(alternative) ? 45 : 0) + (headingText.includes(alternative) ? 65 : 0) + (at >= 0 ? 12 : 0));
          best = Math.max(best, value);
          if (value) matchedTerms.add(alternative);
          if (at >= 0) {
            let position = at;
            for (let count = 0; position >= 0 && count < 16; count++, position = body.indexOf(alternative, position + alternative.length)) positions.push(position);
          }
        }
        if (!best) { matched = false; break; }
        score += best;
      }
      if (!matched) continue;
      if (phrase && title.includes(phrase)) score += 160;
      if (phrase && body.includes(phrase)) score += 30;
      // Choose a passage containing several concepts, rather than always
      // showing the introduction or only the first word of a multiword query.
      let at = 0, passageScore = -1;
      for (const position of positions) {
        const passage = body.slice(Math.max(0, position - 65), position + 200);
        const value = terms.reduce((sum, item) => sum + Number(item.alternatives.some(word => passage.includes(word))), 0);
        if (value > passageScore) { at = position; passageScore = value; }
      }
      const heading = headings.findLast(item => item.offset <= at);
      const start = Math.max(0, at - 65), end = Math.min(document.content.length, at + 220);
      documents.push({ path: document.path, title: document.title, score, excerpt: (start ? '…' : '') + document.content.slice(start, end).replace(/\s+/g, ' ') + (end < document.content.length ? '…' : ''), matchedTerms: [...matchedTerms], heading: terms.length ? heading?.title : undefined, fragment: terms.length && heading ? '#' + heading.id : '', revision, source: `https://github.com/yodaos-project/AIUI/blob/${revision}/${document.path}` });
    }
    const collator = new Intl.Collator(locale === 'en' ? 'en' : 'zh-CN', { numeric: true, sensitivity: 'base' });
    documents.sort((a, b) => {
      const language = (Number(a.path.includes('.en-US.')) - Number(b.path.includes('.en-US.'))) * (locale === 'en' ? -1 : 1);
      if (sort === 'title') return language || collator.compare(a.title, b.title) || collator.compare(a.path, b.path);
      if (sort === 'path') return language || collator.compare(a.path, b.path);
      return b.score - a.score || language || (this.order.get(a.path) ?? Infinity) - (this.order.get(b.path) ?? Infinity) || collator.compare(a.path, b.path);
    });
    const start = Math.max(0, Math.floor(offset) || 0), size = Math.max(1, Math.min(Math.floor(limit) || 16, 1800));
    return { documents: documents.slice(start, start + size), total: documents.length, searchedDocuments: this.entries.length, nextOffset: start + size < documents.length ? start + size : null };
  }
}
