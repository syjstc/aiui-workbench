import test from 'node:test';
import assert from 'node:assert/strict';
import { createThemeStore, THEME_KEY } from '../renderer/theme.mjs';

function fixture(saved, dark = false, storageFails = false) {
  const values = new Map(saved ? [[THEME_KEY, saved]] : []);
  const media = new EventTarget(); media.matches = dark;
  const events = new EventTarget(), root = { dataset: {} };
  const storage = {
    getItem: key => { if (storageFails) throw new Error('denied'); return values.get(key); },
    setItem: (key, value) => { if (storageFails) throw new Error('denied'); values.set(key, value); },
  };
  const store = createThemeStore({ storage, media, root, events });
  return { store, values, root,
    system(value) { media.matches = value; media.dispatchEvent(new Event('change')); },
    external(key, value) { const event = new Event('storage'); Object.assign(event, { key, newValue: value }); events.dispatchEvent(event); },
  };
}

test('automatic appearance follows system changes and publishes the resolved palette', () => {
  const f = fixture(null, true); let updates = 0;
  const unsubscribe = f.store.subscribe(() => updates++);
  assert.deepEqual(f.root.dataset, { appearance: 'system', theme: 'dark' });
  f.system(false);
  assert.deepEqual(f.store.getSnapshot(), { preference: 'system', resolved: 'light' });
  assert.equal(f.root.dataset.theme, 'light'); assert.equal(updates, 1);
  unsubscribe(); f.system(true); assert.equal(updates, 1); f.store.destroy();
});

test('explicit appearance persists and stays selected when the system changes', () => {
  const f = fixture(); f.store.setPreference('dark');
  assert.equal(f.values.get(THEME_KEY), 'dark');
  const snapshot = f.store.getSnapshot();
  f.system(true); f.system(false);
  assert.equal(f.store.getSnapshot(), snapshot);
  const reopened = fixture(f.values.get(THEME_KEY));
  assert.equal(reopened.root.dataset.theme, 'dark');
  f.store.setPreference('system'); assert.equal(f.root.dataset.theme, 'light');
  f.store.destroy(); reopened.store.destroy();
});

test('other windows synchronize appearance and invalid saved preferences fall back to automatic', () => {
  const f = fixture('missing-theme', true);
  assert.equal(f.root.dataset.appearance, 'system');
  f.external('unrelated', 'light'); assert.equal(f.root.dataset.theme, 'dark');
  f.external(THEME_KEY, 'light'); assert.equal(f.root.dataset.theme, 'light');
  f.external(null, null); assert.equal(f.root.dataset.theme, 'dark');
  assert.throws(() => f.store.setPreference('missing-theme'), /Unsupported/);
  f.store.destroy(); f.external(THEME_KEY, 'light'); assert.equal(f.root.dataset.theme, 'dark');
});

test('theme selection still works when browser storage is unavailable', () => {
  const f = fixture(null, false, true);
  f.store.setPreference('dark'); assert.equal(f.root.dataset.theme, 'dark');
  f.store.setPreference('system'); f.system(true); assert.equal(f.root.dataset.theme, 'dark');
  f.store.destroy();
});
