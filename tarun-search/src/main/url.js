'use strict';

// Pure URL helpers. No Electron imports so they can be unit tested with plain Node.

const SEARCH_ENGINES = Object.freeze({
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
});

const DEFAULT_ENGINE = 'duckduckgo';
const WEB_PROTOCOLS = new Set(['http:', 'https:']);
// Schemes a page may hand off to another app, but only after the user agrees.
const EXTERNAL_PROTOCOLS = new Set(['mailto:', 'tel:', 'sms:', 'facetime:', 'zoommtg:', 'msteams:', 'slack:', 'spotify:', 'webcal:']);

const MAX_INPUT = 8192;

function searchUrl(query, engineKey) {
  const engine = SEARCH_ENGINES[engineKey] || SEARCH_ENGINES[DEFAULT_ENGINE];
  return engine.url.replace('%s', encodeURIComponent(String(query).trim()));
}

function tryParse(str) {
  try {
    return new URL(str);
  } catch {
    return null;
  }
}

function isIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return false;
}

/**
 * Turns whatever the user typed into a URL to load.
 * Anything that is not clearly an http(s) address becomes a search, so typed
 * javascript:, file:, data: etc. can never be executed from the address bar.
 */
function normalizeInput(raw, engineKey = DEFAULT_ENGINE) {
  if (typeof raw !== 'string') return null;
  const input = raw.trim().slice(0, MAX_INPUT);
  if (!input) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  if (hasScheme) {
    const u = tryParse(input);
    if (u && WEB_PROTOCOLS.has(u.protocol) && u.hostname) return u.href;
    return searchUrl(input, engineKey);
  }

  // Other "scheme:" style inputs (javascript:, data:, about:, file:) are searched, never run.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(input) && !/^[\w.-]+:\d+(\/|$)/.test(input)) {
    return searchUrl(input, engineKey);
  }

  if (/\s/.test(input)) return searchUrl(input, engineKey);

  // host[:port][/path] forms
  const hostPart = input.split(/[/?#]/)[0];
  const hostname = hostPart.replace(/:\d+$/, '');
  const looksLocal = isLocalHost(hostname);
  const looksLikeDomain = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}$/i.test(hostname) && !hostname.split('.').some((l) => l.startsWith('-') || l.endsWith('-'));
  const isIp = isIPv4(hostname) || /^\[[0-9a-f:]+\]$/i.test(hostname);

  if (looksLocal || looksLikeDomain || isIp) {
    const scheme = looksLocal ? 'http://' : 'https://';
    const u = tryParse(scheme + input);
    if (u && u.hostname) return u.href;
  }
  return searchUrl(input, engineKey);
}

function isWebUrl(url) {
  const u = tryParse(url);
  return !!u && WEB_PROTOCOLS.has(u.protocol);
}

/** Navigations a tab may perform by itself. */
function isAllowedNavigation(url) {
  if (url === 'about:blank') return true;
  return isWebUrl(url);
}

function externalProtocolOf(url) {
  const u = tryParse(url);
  if (!u) return null;
  return EXTERNAL_PROTOCOLS.has(u.protocol) ? u.protocol : null;
}

/** Plain http:// to a public host should be tried over https first. */
function httpsUpgrade(url) {
  const u = tryParse(url);
  if (!u || u.protocol !== 'http:' || isLocalHost(u.hostname) || isIPv4(u.hostname)) return null;
  if (u.port && u.port !== '80') return null;
  u.protocol = 'https:';
  u.port = '';
  return u.href;
}

function hostOf(url) {
  const u = tryParse(url);
  return u && WEB_PROTOCOLS.has(u.protocol) ? u.hostname.toLowerCase() : '';
}

function originOf(url) {
  const u = tryParse(url);
  return u && WEB_PROTOCOLS.has(u.protocol) ? u.origin : '';
}

/** Does `host` equal `domain` or sit underneath it? */
function hostMatches(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith('.' + domain);
}

/** Clean domain list entry: "https://www.YouTube.com/x" -> "youtube.com". */
function cleanDomain(entry) {
  if (typeof entry !== 'string') return null;
  let s = entry.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z]+:\/\//.test(s)) s = 'https://' + s;
  const u = tryParse(s);
  if (!u || !u.hostname) return null;
  const host = u.hostname.replace(/^www\./, '');
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]{2,63}$/.test(host)) return null;
  return host;
}

function safeFaviconUrl(url) {
  const u = tryParse(url);
  return u && u.protocol === 'https:' && url.length < 2048 ? u.href : '';
}

function isSearchResultsUrl(url) {
  const u = tryParse(url);
  if (!u) return false;
  return Object.values(SEARCH_ENGINES).some((e) => {
    const t = new URL(e.url.replace('%s', ''));
    return t.hostname === u.hostname && t.pathname === u.pathname;
  });
}

module.exports = {
  SEARCH_ENGINES,
  DEFAULT_ENGINE,
  normalizeInput,
  searchUrl,
  isWebUrl,
  isAllowedNavigation,
  externalProtocolOf,
  httpsUpgrade,
  hostOf,
  originOf,
  hostMatches,
  cleanDomain,
  isLocalHost,
  safeFaviconUrl,
  isSearchResultsUrl,
};
