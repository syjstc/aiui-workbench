export const THEME_KEY = 'aiui-workbench.theme';
// Register each additional palette here and in themes.css.
export const THEMES = Object.freeze([
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
]);
export const APPEARANCES = Object.freeze([{ id: 'system', label: '自动' }, ...THEMES]);
const valid = value => APPEARANCES.some(theme => theme.id === value);
export const resolveTheme = (preference, dark) => preference === 'system' ? (dark ? 'dark' : 'light') : preference;

export function createThemeStore({ storage, media, root, events } = {}) {
  let preference;
  try { preference = storage?.getItem(THEME_KEY); } catch {}
  if (!valid(preference)) preference = 'system';
  let snapshot;
  const listeners = new Set();
  function apply() {
    const resolved = resolveTheme(preference, !!media?.matches);
    if (root) {
      root.dataset.theme = resolved;
      root.dataset.appearance = preference;
    }
    if (snapshot?.preference === preference && snapshot.resolved === resolved) return;
    snapshot = Object.freeze({ preference, resolved });
    for (const listener of listeners) listener();
  }
  function setPreference(value) {
    if (!valid(value)) throw new Error('Unsupported appearance');
    preference = value;
    try { storage?.setItem(THEME_KEY, value); } catch {}
    apply();
  }
  const onStorage = event => {
    if (event.key !== THEME_KEY && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : 'system';
    apply();
  };
  media?.addEventListener('change', apply);
  events?.addEventListener('storage', onStorage);
  apply();
  return {
    getSnapshot: () => snapshot,
    setPreference,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { media?.removeEventListener('change', apply); events?.removeEventListener('storage', onStorage); listeners.clear(); },
  };
}

let storage;
try { storage = globalThis.localStorage; } catch {}
const store = createThemeStore({
  storage,
  media: globalThis.matchMedia?.('(prefers-color-scheme: dark)'),
  root: globalThis.document?.documentElement,
  events: globalThis.window,
});
export const getAppearance = store.getSnapshot;
export const setAppearance = store.setPreference;
export const subscribeAppearance = store.subscribe;
