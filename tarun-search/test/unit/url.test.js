'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../../src/main/url');

const ddg = (q) => 'https://duckduckgo.com/?q=' + encodeURIComponent(q);

test('typed addresses become https URLs', () => {
  assert.equal(u.normalizeInput('example.com'), 'https://example.com/');
  assert.equal(u.normalizeInput('  news.ycombinator.com/item?id=1  '), 'https://news.ycombinator.com/item?id=1');
  assert.equal(u.normalizeInput('https://Example.com/A'), 'https://example.com/A');
  assert.equal(u.normalizeInput('http://example.com'), 'http://example.com/');
  assert.equal(u.normalizeInput('sub.domain.co.uk:8443/x'), 'https://sub.domain.co.uk:8443/x');
});

test('local addresses use http', () => {
  assert.equal(u.normalizeInput('localhost:3000'), 'http://localhost:3000/');
  assert.equal(u.normalizeInput('localhost'), 'http://localhost/');
  assert.equal(u.normalizeInput('192.168.1.1'), 'http://192.168.1.1/');
  assert.equal(u.normalizeInput('127.0.0.1:8080/api'), 'http://127.0.0.1:8080/api');
  assert.equal(u.normalizeInput('printer.local'), 'http://printer.local/');
});

test('everything else is searched', () => {
  assert.equal(u.normalizeInput('how tall is everest'), ddg('how tall is everest'));
  assert.equal(u.normalizeInput('hello'), ddg('hello'));
  assert.equal(u.normalizeInput('c++'), ddg('c++'));
  assert.equal(u.normalizeInput('what is 2.5'), ddg('what is 2.5'));
  assert.equal(u.normalizeInput('cats', 'google'), 'https://www.google.com/search?q=cats');
  assert.equal(u.normalizeInput('cats', 'not-an-engine'), ddg('cats'));
});

test('dangerous schemes are never loaded from the address bar', () => {
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'chrome://settings', 'about:blank', 'view-source:https://x.com', 'vbscript:msgbox', 'blob:https://x.com/1']) {
    const out = u.normalizeInput(bad);
    assert.ok(out.startsWith('https://duckduckgo.com/?q='), `${bad} -> ${out}`);
  }
  assert.equal(u.normalizeInput('ftp://example.com/file'), ddg('ftp://example.com/file'));
});

test('empty and non-string input', () => {
  assert.equal(u.normalizeInput(''), null);
  assert.equal(u.normalizeInput('   '), null);
  assert.equal(u.normalizeInput(null), null);
  assert.equal(u.normalizeInput({}), null);
});

test('navigation allow-list', () => {
  assert.equal(u.isAllowedNavigation('https://a.com'), true);
  assert.equal(u.isAllowedNavigation('http://a.com'), true);
  assert.equal(u.isAllowedNavigation('about:blank'), true);
  assert.equal(u.isAllowedNavigation('file:///etc/passwd'), false);
  assert.equal(u.isAllowedNavigation('javascript:1'), false);
  assert.equal(u.isAllowedNavigation('tarun://app/index.html'), false);
  assert.equal(u.isAllowedNavigation('chrome://gpu'), false);
});

test('https upgrade skips local and non-default ports', () => {
  assert.equal(u.httpsUpgrade('http://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(u.httpsUpgrade('http://example.com:80/'), 'https://example.com/');
  assert.equal(u.httpsUpgrade('http://example.com:8080/'), null);
  assert.equal(u.httpsUpgrade('http://localhost/'), null);
  assert.equal(u.httpsUpgrade('http://10.0.0.5/'), null);
  assert.equal(u.httpsUpgrade('https://example.com/'), null);
});

test('external protocols are allow-listed', () => {
  assert.equal(u.externalProtocolOf('mailto:a@b.com'), 'mailto:');
  assert.equal(u.externalProtocolOf('zoommtg://zoom.us/join'), 'zoommtg:');
  assert.equal(u.externalProtocolOf('ms-msdt:/id'), null);
  assert.equal(u.externalProtocolOf('file:///x'), null);
  assert.equal(u.externalProtocolOf('search-ms:query=x'), null);
});

test('domain helpers', () => {
  assert.equal(u.cleanDomain('https://www.YouTube.com/watch'), 'youtube.com');
  assert.equal(u.cleanDomain('reddit.com'), 'reddit.com');
  assert.equal(u.cleanDomain('not a domain'), null);
  assert.equal(u.cleanDomain(''), null);
  assert.equal(u.hostMatches('m.youtube.com', 'youtube.com'), true);
  assert.equal(u.hostMatches('notyoutube.com', 'youtube.com'), false);
  assert.equal(u.safeFaviconUrl('http://x.com/f.ico'), '');
  assert.equal(u.safeFaviconUrl('https://x.com/f.ico'), 'https://x.com/f.ico');
  assert.equal(u.safeFaviconUrl('data:image/png;base64,AAAA'), '');
});
