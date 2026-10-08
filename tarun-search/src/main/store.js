'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SEARCH_ENGINES, isWebUrl, safeFaviconUrl, cleanDomain } = require('./url');

const SCHEMA_VERSION = 1;
const MAX_HISTORY = 5000;
const MAX_ARCHIVE = 500;
const MAX_TABS_PER_LIST = 300;

const SPACE_COLORS = ['#7c5cff', '#ff5c8a', '#18b47b', '#ff9f1c', '#2d9cdb', '#e05757', '#9b51e0', '#00b8a9'];

const DEFAULT_FOCUS_BLOCKLIST = [
  'youtube.com', 'x.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'reddit.com',
  'facebook.com', 'netflix.com', 'twitch.tv',
];

const DEFAULT_SETTINGS = Object.freeze({
  searchEngine: 'duckduckgo',
  theme: 'system', // system | light | dark
  httpsFirst: true,
  blockTrackers: true,
  archiveAfterHours: 12, // 0 = never
  sleepAfterMinutes: 30, // 0 = never
  sidebarWidth: 260,
  sidebarCollapsed: false,
  onboarded: false,
  shieldsDownSites: [],
  focusBlocklist: DEFAULT_FOCUS_BLOCKLIST,
  checkUpdates: true,
});

const ENUMS = {
  theme: ['system', 'light', 'dark'],
  archiveAfterHours: [0, 12, 24, 72, 168],
  sleepAfterMinutes: [0, 15, 30, 60, 120],
};

function newId() {
  return crypto.randomUUID();
}

const str = (v, max = 2048) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v, min, max, def) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

function sanitizeSetting(key, value) {
  switch (key) {
    case 'searchEngine':
      return Object.hasOwn(SEARCH_ENGINES, value) ? value : undefined;
    case 'theme':
    case 'archiveAfterHours':
    case 'sleepAfterMinutes':
      return ENUMS[key].includes(value) ? value : undefined;
    case 'httpsFirst':
    case 'blockTrackers':
    case 'sidebarCollapsed':
    case 'onboarded':
    case 'checkUpdates':
      return typeof value === 'boolean' ? value : undefined;
    case 'sidebarWidth':
      return Number.isFinite(value) ? Math.round(num(value, 220, 420, 260)) : undefined;
    case 'shieldsDownSites':
    case 'focusBlocklist': {
      if (!Array.isArray(value)) return undefined;
      const out = [...new Set(value.map(cleanDomain).filter(Boolean))];
      return out.slice(0, 500);
    }
    default:
      return undefined;
  }
}

function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!Object.hasOwn(raw, key)) continue;
      const v = sanitizeSetting(key, raw[key]);
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

function sanitizeTabRecord(t) {
  if (!t || typeof t !== 'object' || !isWebUrl(t.url)) return null;
  return {
    id: newId(), // ids are runtime-only; never trust stored ones
    url: str(t.url, 8192),
    homeUrl: isWebUrl(t.homeUrl) ? str(t.homeUrl, 8192) : str(t.url, 8192),
    title: str(t.title, 500),
    favicon: safeFaviconUrl(t.favicon),
    lastActive: num(t.lastActive, 0, Date.now(), Date.now()),
  };
}

function sanitizeList(list, max = MAX_TABS_PER_LIST) {
  return Array.isArray(list) ? list.map(sanitizeTabRecord).filter(Boolean).slice(0, max) : [];
}

function sanitizeSpace(s, i) {
  if (!s || typeof s !== 'object') return null;
  return {
    id: newId(),
    name: str(s.name, 40).trim() || `Space ${i + 1}`,
    emoji: str(s.emoji, 16) || '✨',
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : SPACE_COLORS[i % SPACE_COLORS.length],
    pinned: sanitizeList(s.pinned),
    tabs: sanitizeList(s.tabs),
    activeIndex: Number.isInteger(s.activeIndex) ? s.activeIndex : -1,
  };
}

function defaultState() {
  return {
    version: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    favorites: [],
    spaces: [
      { id: newId(), name: 'Personal', emoji: '🏠', color: SPACE_COLORS[0], pinned: [], tabs: [], activeIndex: -1 },
      { id: newId(), name: 'Work', emoji: '💼', color: SPACE_COLORS[4], pinned: [], tabs: [], activeIndex: -1 },
    ],
    activeSpaceIndex: 0,
    archive: [],
    history: [],
    permissions: {},
    zaps: {},
    mysteries: { ghost: false, zap: false, focus: false },
    windowBounds: null,
  };
}

function sanitizeState(raw) {
  const def = defaultState();
  if (!raw || typeof raw !== 'object' || raw.version !== SCHEMA_VERSION) return def;
  const spaces = Array.isArray(raw.spaces) ? raw.spaces.map(sanitizeSpace).filter(Boolean).slice(0, 20) : [];
  const perms = {};
  if (raw.permissions && typeof raw.permissions === 'object') {
    for (const [origin, rec] of Object.entries(raw.permissions).slice(0, 2000)) {
      if (!isWebUrl(origin) || !rec || typeof rec !== 'object') continue;
      const clean = {};
      for (const [perm, v] of Object.entries(rec)) {
        if (/^[a-z-]{1,40}$/.test(perm) && (v === 'allow' || v === 'deny')) clean[perm] = v;
      }
      perms[origin] = clean;
    }
  }
  const zaps = {};
  if (raw.zaps && typeof raw.zaps === 'object') {
    for (const [host, sels] of Object.entries(raw.zaps).slice(0, 2000)) {
      if (!/^[a-z0-9.-]{1,253}$/.test(host) || !Array.isArray(sels)) continue;
      const ok = sels.filter(isSafeSelector).slice(0, 100);
      if (ok.length) zaps[host] = ok;
    }
  }
  const histEntry = (h) =>
    h && isWebUrl(h.url) ? { url: str(h.url, 8192), title: str(h.title, 500), visitedAt: num(h.visitedAt, 0, Date.now(), 0), visits: num(h.visits, 1, 1e6, 1) } : null;
  const archEntry = (a) =>
    a && isWebUrl(a.url) ? { url: str(a.url, 8192), title: str(a.title, 500), favicon: safeFaviconUrl(a.favicon), archivedAt: num(a.archivedAt, 0, Date.now(), 0) } : null;
  const m = raw.mysteries && typeof raw.mysteries === 'object' ? raw.mysteries : {};
  const wb = raw.windowBounds;
  return {
    version: SCHEMA_VERSION,
    settings: sanitizeSettings(raw.settings),
    favorites: sanitizeList(raw.favorites, 24),
    spaces: spaces.length ? spaces : def.spaces,
    activeSpaceIndex: Number.isInteger(raw.activeSpaceIndex) ? Math.max(0, Math.min(raw.activeSpaceIndex, Math.max(0, spaces.length - 1))) : 0,
    archive: Array.isArray(raw.archive) ? raw.archive.map(archEntry).filter(Boolean).slice(0, MAX_ARCHIVE) : [],
    history: Array.isArray(raw.history) ? raw.history.map(histEntry).filter(Boolean).slice(0, MAX_HISTORY) : [],
    permissions: perms,
    zaps,
    mysteries: { ghost: m.ghost === true, zap: m.zap === true, focus: m.focus === true },
    windowBounds:
      wb && [wb.x, wb.y, wb.width, wb.height].every(Number.isFinite)
        ? { x: Math.round(wb.x), y: Math.round(wb.y), width: Math.round(num(wb.width, 640, 10000, 1280)), height: Math.round(num(wb.height, 480, 10000, 800)), maximized: wb.maximized === true }
        : null,
  };
}

/**
 * Selectors produced by the Zap picker use a tiny grammar: tag names, #id,
 * .class (plain identifiers only), :nth-of-type(n), joined by " > ". Anything
 * else is rejected, so a page can never smuggle extra CSS rules through a
 * crafted selector.
 */
const IDENT = '[A-Za-z_][A-Za-z0-9_-]{0,80}';
const SEGMENT = `[a-z][a-z0-9-]{0,30}(?:#${IDENT})?(?:\\.${IDENT}){0,4}(?::nth-of-type\\([1-9][0-9]{0,4}\\))?`;
const SELECTOR_RE = new RegExp(`^${SEGMENT}(?: > ${SEGMENT}){0,15}$`);

function isSafeSelector(sel) {
  return typeof sel === 'string' && sel.length > 0 && sel.length <= 1200 && SELECTOR_RE.test(sel);
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'tarun-state.json');
    this.tmp = this.file + '.tmp';
    this.timer = null;
    this.data = this.load();
  }

  load() {
    for (const f of [this.file, this.file + '.bak']) {
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        return sanitizeState(raw);
      } catch {
        // try the backup, then fall back to defaults
      }
    }
    return defaultState();
  }

  /** Debounced atomic write: write tmp file, keep a backup, rename into place. */
  save(getSnapshot, delay = 800) {
    this.getSnapshot = getSnapshot;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.getSnapshot) return;
    try {
      const json = JSON.stringify(this.getSnapshot());
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.tmp, json, { encoding: 'utf8', mode: 0o600 });
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.renameSync(this.tmp, this.file);
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }
}

module.exports = {
  Store,
  sanitizeState,
  sanitizeSettings,
  sanitizeSetting,
  isSafeSelector,
  defaultState,
  newId,
  SPACE_COLORS,
  DEFAULT_SETTINGS,
  ENUMS,
  MAX_HISTORY,
  MAX_ARCHIVE,
};
