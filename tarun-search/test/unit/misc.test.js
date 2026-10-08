'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildKeymap, matchInput, COMMANDS } = require('../../src/main/shortcuts');
const { trackerFor, shouldBlock, roughSite } = require('../../src/main/trackers');
const { cssFor, PICKER_SOURCE } = require('../../src/main/zap');

const key = (code, mods = {}) => ({ type: 'keyDown', code, control: false, meta: false, alt: false, shift: false, ...mods });

test('keyboard shortcuts on Windows/Linux', () => {
  const km = buildKeymap('linux');
  assert.equal(matchInput(km, key('KeyT', { control: true })), 'new-tab');
  assert.equal(matchInput(km, key('KeyT', { control: true, shift: true })), 'reopen-tab');
  assert.equal(matchInput(km, key('KeyW', { control: true })), 'close-tab');
  assert.equal(matchInput(km, key('Digit3', { control: true })), 'tab-3');
  assert.equal(matchInput(km, key('Equal', { control: true, shift: true })), 'zoom-in');
  assert.equal(matchInput(km, key('ArrowLeft', { alt: true })), 'back');
  assert.equal(matchInput(km, key('KeyX', { control: true, shift: true })), 'zap');
  assert.equal(matchInput(km, key('F5')), 'reload');
  assert.equal(matchInput(km, key('KeyT')), null, 'plain typing is never captured');
  assert.equal(matchInput(km, key('KeyC', { control: true })), null, 'Ctrl+C stays copy');
  assert.equal(matchInput(km, key('KeyV', { control: true })), null, 'Ctrl+V stays paste');
  assert.equal(matchInput(km, { ...key('KeyT', { control: true }), type: 'keyUp' }), null);
});

test('keyboard shortcuts on macOS use Cmd and avoid Option-typing', () => {
  const km = buildKeymap('darwin');
  assert.equal(matchInput(km, key('KeyT', { meta: true })), 'new-tab');
  assert.equal(matchInput(km, key('KeyT', { control: true })), null);
  assert.equal(matchInput(km, key('KeyD', { alt: true })), null, 'Option+D types ∂ on a Mac');
  assert.equal(matchInput(km, key('ArrowLeft', { alt: true })), null, 'Option+← moves by word');
  assert.equal(matchInput(km, key('BracketLeft', { meta: true })), 'back');
});

test('every command has a unique id and at least one accelerator', () => {
  const ids = COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of COMMANDS) assert.ok(c.accel.length > 0, c.id);
});

test('no two commands share a shortcut', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const seen = new Map();
    for (const { id, m } of buildKeymap(platform)) {
      for (const code of m.codes) {
        const k = `${m.ctrl}${m.meta}${m.alt}${m.shift}${code}`;
        if (seen.has(k) && seen.get(k) !== id) assert.fail(`${platform}: ${id} clashes with ${seen.get(k)}`);
        seen.set(k, id);
      }
    }
  }
});

test('tracker matching', () => {
  assert.equal(trackerFor('www.google-analytics.com'), 'google-analytics.com');
  assert.equal(trackerFor('stats.g.doubleclick.net'), 'doubleclick.net');
  assert.equal(trackerFor('example.com'), null);
  assert.equal(trackerFor('notdoubleclick.net'), null);
  assert.equal(shouldBlock('www.google-analytics.com', 'news.example.com'), true);
  assert.equal(shouldBlock('cdn.example.com', 'news.example.com'), false);
  assert.equal(shouldBlock('ads.linkedin.com', 'www.linkedin.com'), false, 'first-party requests are allowed');
  assert.equal(roughSite('a.b.example.co.uk'), 'example.co.uk');
});

test('zap CSS and picker', () => {
  assert.equal(cssFor(['div#ad', 'aside.x']), 'div#ad{display:none!important}\naside.x{display:none!important}');
  assert.match(PICKER_SOURCE, /^\(function picker\(\)/);
});
