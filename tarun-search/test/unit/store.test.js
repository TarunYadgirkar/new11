'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, sanitizeState, sanitizeSetting, isSafeSelector, defaultState } = require('../../src/main/store');

test('corrupt or foreign state falls back to defaults', () => {
  assert.deepEqual(Object.keys(sanitizeState(null)), Object.keys(defaultState()));
  assert.equal(sanitizeState({ version: 999 }).spaces.length, 2);
  assert.equal(sanitizeState('nope').settings.searchEngine, 'duckduckgo');
});

test('stored tabs are validated', () => {
  const s = sanitizeState({
    version: 1,
    spaces: [{ name: 'X', pinned: [{ url: 'javascript:alert(1)' }, { url: 'https://ok.com', favicon: 'http://insecure/f.ico' }], tabs: [{ url: 'file:///etc/passwd' }] }],
    favorites: [{ url: 'https://fav.com', title: 'x'.repeat(5000) }],
  });
  assert.equal(s.spaces[0].pinned.length, 1);
  assert.equal(s.spaces[0].pinned[0].url, 'https://ok.com');
  assert.equal(s.spaces[0].pinned[0].favicon, '');
  assert.equal(s.spaces[0].tabs.length, 0);
  assert.equal(s.favorites[0].title.length, 500);
});

test('settings are type-checked and prototype pollution is impossible', () => {
  assert.equal(sanitizeSetting('searchEngine', 'google'), 'google');
  assert.equal(sanitizeSetting('searchEngine', 'evil'), undefined);
  assert.equal(sanitizeSetting('searchEngine', '__proto__'), undefined);
  assert.equal(sanitizeSetting('theme', 'dark'), 'dark');
  assert.equal(sanitizeSetting('theme', 'neon'), undefined);
  assert.equal(sanitizeSetting('httpsFirst', 'yes'), undefined);
  assert.equal(sanitizeSetting('sidebarWidth', 99999), 420);
  assert.equal(sanitizeSetting('__proto__', {}), undefined);
  assert.deepEqual(sanitizeSetting('focusBlocklist', ['https://www.YouTube.com', 'bad entry', 'x.com', 'x.com']), ['youtube.com', 'x.com']);
  const s = sanitizeState(JSON.parse('{"version":1,"settings":{"__proto__":{"polluted":1},"theme":"light"}}'));
  assert.equal(s.settings.theme, 'light');
  assert.equal({}.polluted, undefined);
});

test('permissions and zaps are validated on load', () => {
  const s = sanitizeState({
    version: 1,
    permissions: { 'https://meet.example.com': { media: 'allow', geolocation: 'maybe' }, 'file:///': { media: 'allow' } },
    zaps: { 'example.com': ['div#ad', 'div{}', 'body > div:nth-of-type(2)'], 'bad host!': ['div'] },
  });
  assert.deepEqual(s.permissions, { 'https://meet.example.com': { media: 'allow' } });
  assert.deepEqual(s.zaps, { 'example.com': ['div#ad', 'body > div:nth-of-type(2)'] });
});

test('zap selectors only allow the picker grammar', () => {
  for (const ok of ['div', 'div#main', 'section.hero.big', 'body > div:nth-of-type(3) > aside.ad', 'my-widget']) assert.equal(isSafeSelector(ok), true, ok);
  for (const bad of ['', 'div{color:red}', 'div;', 'div > ', '* ', 'a[href]', 'div, span', 'div:has(x)', 'DIV', 'x'.repeat(2000), 'div\n{}', '@import url(x)']) assert.equal(isSafeSelector(bad), false, bad);
});

test('store writes atomically and recovers from a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarun-store-'));
  const store = new Store(dir);
  store.getSnapshot = () => ({ ...defaultState(), settings: { ...defaultState().settings, theme: 'dark' } });
  store.flush();
  store.flush(); // creates a .bak of the first write
  assert.equal(new Store(dir).data.settings.theme, 'dark');
  fs.writeFileSync(path.join(dir, 'tarun-state.json'), '{not json');
  assert.equal(new Store(dir).data.settings.theme, 'dark', 'falls back to the backup');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saves are debounced but never postponed forever', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarun-store-'));
  const store = new Store(dir);
  let writes = 0;
  const flush = store.flush.bind(store);
  store.flush = () => {
    writes++;
    flush();
  };
  const start = Date.now();
  while (Date.now() - start < 400) {
    store.save(() => defaultState(), 100, 200);
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(writes >= 2, `expected periodic writes, got ${writes}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
