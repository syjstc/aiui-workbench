import en from './locales/en.json' with { type: 'json' };

export const LOCALE_KEY = 'aiui-workbench.locale';
export const LOCALES = ['zh-CN', 'en'];
export function resolveLocale(saved, languages = []) {
  if (LOCALES.includes(saved)) return saved;
  return /^zh(?:-|$)/i.test(languages[0] || '') ? 'zh-CN' : 'en';
}
const storage = () => typeof window === 'object' ? window.localStorage : undefined;
let saved;
try { saved = storage()?.getItem(LOCALE_KEY); } catch {}
let locale = resolveLocale(saved, globalThis.navigator?.languages || [globalThis.navigator?.language]);
const listeners = new Set();
export const getLocale = () => locale;
export const subscribeLocale = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export function setLocale(value) {
  if (!LOCALES.includes(value)) throw new Error('Unsupported language');
  try { storage()?.setItem(LOCALE_KEY, value); } catch {}
  if (value === locale) return;
  locale = value;
  for (const listener of listeners) listener();
}
export function t(source, values = {}, language = locale) {
  if (typeof source !== 'string') return source ?? '';
  const message = language === 'en' ? en[source] ?? source : source;
  return message.replace(/\{(\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
// Service errors and task summaries arrive as text. Only translate known
// messages; source code, application logs and project names stay untouched.
const patterns = Object.keys(en).filter(key => /\{\d+\}/.test(key)).map(key => {
  const slots = [];
  const pattern = key.split(/(\{\d+\})/g).map(part => {
    if (/^\{\d+\}$/.test(part)) { slots.push(part.slice(1, -1)); return '([\\s\\S]*?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { key, slots, regex: new RegExp('^' + pattern + '$') };
});
export function translateMessage(value, language = locale) {
  if (typeof value !== 'string' || language !== 'en') return value;
  if (Object.hasOwn(en, value)) return t(value, {}, language);
  for (const { key, slots, regex } of patterns) {
    const match = value.match(regex);
    if (match) return t(key, Object.fromEntries(slots.map((slot, i) => [slot, translateMessage(match[i + 1], language)])), language);
  }
  for (const key of Object.keys(en)) {
    if (/[:：]\s*$/.test(key) && value.startsWith(key)) return t(key, {}, language) + value.slice(key.length);
  }
  return value;
}
globalThis.addEventListener?.('storage', event => {
  if (event.key !== LOCALE_KEY) return;
  const next = resolveLocale(event.newValue, globalThis.navigator?.languages);
  if (next !== locale) { locale = next; for (const listener of listeners) listener(); }
});
