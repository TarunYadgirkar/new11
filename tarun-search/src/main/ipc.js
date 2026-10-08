'use strict';

const { ipcMain } = require('electron');
const menus = require('./menus');
const { cleanDomain } = require('./url');

// Every message from the UI is checked twice: it must come from our own UI page
// (never from a website), and every argument is type- and range-checked.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class Invalid extends Error {}

const v = {
  id(x) {
    if (typeof x !== 'string' || !UUID.test(x)) throw new Invalid('id');
    return x;
  },
  optId(x) {
    return x == null ? null : v.id(x);
  },
  str(x, max = 8192) {
    if (typeof x !== 'string' || x.length > max) throw new Invalid('str');
    return x;
  },
  optStr(x, max) {
    return x == null ? '' : v.str(x, max);
  },
  bool(x) {
    if (typeof x !== 'boolean') throw new Invalid('bool');
    return x;
  },
  int(x, min, max) {
    if (!Number.isInteger(x) || x < min || x > max) throw new Invalid('int');
    return x;
  },
  optInt(x, min, max) {
    return x == null ? undefined : v.int(x, min, max);
  },
  oneOf(x, list) {
    if (!list.includes(x)) throw new Invalid('enum');
    return x;
  },
  obj(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Invalid('obj');
    return x;
  },
  rect(r) {
    if (r == null) return null;
    v.obj(r);
    const out = {};
    for (const k of ['x', 'y', 'width', 'height']) {
      if (!Number.isFinite(r[k]) || r[k] < -10 || r[k] > 20000) throw new Invalid('rect');
      out[k] = r[k];
    }
    return out;
  },
  color(x) {
    if (typeof x !== 'string' || !/^#[0-9a-f]{6}$/i.test(x)) throw new Invalid('color');
    return x;
  },
};

function registerIpc(browser) {
  const fromUi = (event) => {
    const win = browser.win;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
    const frame = event.senderFrame;
    return !!frame && frame === event.sender.mainFrame && frame.url.startsWith('tarun://app/');
  };

  const tabOf = (id) => browser.findTab(v.id(id));

  // Fire-and-forget commands.
  const commands = {
    'tab:new': (p) => browser.newTab(v.str(p.input), { background: p.background === true, spaceId: v.optId(p.spaceId) || undefined }),
    'tab:activate': (p) => browser.activateTab(v.id(p.id)),
    'tab:close': (p) => browser.closeTab(v.id(p.id)),
    'tab:navigate': (p) => browser.navigate(v.id(p.id), v.str(p.input)),
    'tab:back': (p) => {
      const t = tabOf(p.id);
      if (t && t.wc && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack();
    },
    'tab:forward': (p) => {
      const t = tabOf(p.id);
      if (t && t.wc && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward();
    },
    'tab:reload': (p) => browser.reloadTab(tabOf(p.id)),
    'tab:stop': (p) => {
      const t = tabOf(p.id);
      if (t && t.wc) t.wc.stop();
    },
    'tab:menu': (p) => menus.showTabMenu(browser, v.id(p.id)),
    'tab:move': (p) =>
      browser.moveTab(v.id(p.id), {
        kind: v.oneOf(p.kind, ['favorite', 'pinned', 'tab']),
        spaceId: v.optId(p.spaceId),
        index: v.optInt(p.index, 0, 1000),
      }),
    'tab:pin': (p) => browser.togglePin(v.id(p.id)),
    'tab:mute': (p) => browser.setMuted(v.id(p.id), v.bool(p.muted)),
    'tab:allow-http': (p) => browser.allowHttp(v.id(p.id)),
    'tab:shields': () => browser.toggleShields(),
    'tab:zoom': (p) => browser.zoom(browser.activeTab, v.oneOf(p.delta, [-0.5, 0, 0.5])),
    'tab:copy-url': () => browser.copyUrl(),
    'tab:reopen': () => browser.reopenClosed(),
    'tab:archive': (p) => browser.archiveTab(v.id(p.id)),
    'space:clear-today': () => {
      for (const t of [...browser.activeSpace.tabs]) browser.archiveTab(t.id);
    },
    'space:new': (p) =>
      browser.newSpace({
        name: v.optStr(p.name, 40),
        emoji: v.optStr(p.emoji, 16),
        color: p.color == null ? undefined : v.color(p.color),
        ghost: p.ghost === true,
      }),
    'space:switch': (p) => browser.switchSpace(v.id(p.id)),
    'space:update': (p) =>
      browser.updateSpace(v.id(p.id), { name: v.optStr(p.name, 40), emoji: v.optStr(p.emoji, 16), color: p.color == null ? undefined : v.color(p.color) }),
    'space:delete': (p) => browser.deleteSpace(v.id(p.id)),
    'space:menu': (p) => menus.showSpaceMenu(browser, v.id(p.id)),
    'split:open': (p) => browser.openSplit(v.optId(p.id), p.input == null ? null : v.str(p.input)),
    'split:close': () => browser.closeSplit(),
    'split:swap': () => browser.swapSplit(),
    'peek:open': (p) => browser.openPeek(v.str(p.input), browser.activeTab),
    'peek:close': () => browser.closePeek(),
    'peek:expand': () => browser.expandPeek(),
    'archive:restore': (p) => browser.restoreArchived(v.int(p.index, 0, 10000)),
    'archive:clear': () => {
      browser.data.archive = [];
      browser.save();
      browser.pushState();
    },
    'history:clear': () => browser.clearHistory(),
    'data:clear': () => browser.clearBrowsingData(),
    'settings:set': (p) => browser.setSetting(v.str(p.key, 40), p.value),
    'layout:set': (p) =>
      browser.setLayout({ main: v.rect(p.main), split: v.rect(p.split), peek: v.rect(p.peek), overlay: v.bool(p.overlay) }),
    'find:query': (p) => browser.findInPage(v.str(p.text, 500), { forward: p.forward !== false, findNext: p.findNext === true }),
    'find:stop': () => browser.stopFind(),
    'zap:start': () => browser.startZap(),
    'zap:clear': (p) => {
      const host = cleanDomain(v.str(p.host, 253));
      if (host) browser.clearZaps(v.str(p.host, 253).toLowerCase());
    },
    'focus:start': (p) => browser.startFocus(v.int(p.minutes, 1, 180)),
    'focus:stop': () => browser.stopFocus(false),
    'prompt:answer': (p) => browser.answerPrompt(v.id(p.id), v.bool(p.allow), v.bool(p.remember)),
    'download:action': (p) => browser.downloadAction(v.id(p.id), v.oneOf(p.action, ['open', 'show', 'cancel', 'clear'])),
    'permissions:forget': (p) => browser.forgetSitePermissions(v.str(p.origin, 300)),
    'mystery:reveal': (p) => {
      const key = v.oneOf(p.key, ['ghost', 'zap', 'focus']);
      browser.data.mysteries[key] = true;
      browser.save();
      browser.pushState();
    },
    'app:command': (p) => browser.runCommand(v.str(p.id, 40)),
    'app:check-updates': () => browser.checkForUpdates(true),
    'app:open-update': () => browser.update && browser.openExternalSafe(browser.update.url),
    'app:default-browser': () => browser.setDefaultBrowser(),
    'app:help': () => browser.openExternalSafe(menus.HELP_URL),
    'app:focus-page': () => {
      const t = browser.activeTab;
      if (t && t.wc) t.wc.focus();
    },
    'ui:chrome': (p) => {
      const win = browser.win;
      if (!win || win.isDestroyed()) return;
      if (process.platform === 'darwin') {
        win.setWindowButtonPosition(v.bool(p.collapsed) ? { x: 16, y: 16 } : { x: 18, y: 19 });
      } else {
        win.setTitleBarOverlay({ color: v.color(p.bg), symbolColor: v.color(p.fg), height: 40 });
      }
    },
  };

  // Request/response queries.
  const queries = {
    search: (p) => browser.search(v.str(p.text, 500)),
    'views:capture': () => browser.captureViews(),
    'archive:list': () => browser.data.archive.slice(0, 500),
    'history:list': (p) => {
      const q = v.optStr(p.text, 300).toLowerCase();
      return browser.data.history.filter((h) => !q || `${h.title} ${h.url}`.toLowerCase().includes(q)).slice(0, 300);
    },
    'permissions:list': () => browser.sitePermissions(),
    'zaps:list': () => Object.entries(browser.data.zaps).map(([host, sels]) => ({ host, count: sels.length })),
  };

  ipcMain.on('cmd', (event, name, payload) => {
    if (!fromUi(event) || typeof name !== 'string' || !Object.hasOwn(commands, name)) return;
    try {
      commands[name](payload && typeof payload === 'object' ? payload : {});
    } catch (err) {
      if (!(err instanceof Invalid)) console.error(`[ipc] ${name}:`, err);
    }
  });

  ipcMain.handle('query', async (event, name, payload) => {
    if (!fromUi(event) || typeof name !== 'string' || !Object.hasOwn(queries, name)) throw new Error('denied');
    return queries[name](payload && typeof payload === 'object' ? payload : {});
  });
}

module.exports = { registerIpc, v, Invalid };
