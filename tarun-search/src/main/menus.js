'use strict';

const { Menu, clipboard, shell } = require('electron');
const { COMMANDS, acceleratorsFor } = require('./shortcuts');
const { isWebUrl, searchUrl, SEARCH_ENGINES } = require('./url');

const IS_MAC = process.platform === 'darwin';
const HELP_URL = 'https://github.com/tarunyadgirkar/new11/tree/main/tarun-search#readme';

/** macOS needs a real application menu (it owns ⌘C/⌘V/⌘Q and our shortcuts). */
function buildAppMenu(browser) {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  const itemsFor = (menu) => {
    const out = [];
    for (const cmd of COMMANDS.filter((c) => c.menu === menu)) {
      const accels = acceleratorsFor(cmd, 'darwin');
      accels.forEach((accelerator, i) => {
        out.push({
          label: cmd.label,
          accelerator,
          visible: !cmd.hidden && i === 0,
          acceleratorWorksWhenHidden: true,
          click: () => browser.runCommand(cmd.id),
        });
      });
    }
    return out;
  };
  const template = [
    {
      label: 'Tarun Search',
      submenu: [
        { label: 'About Tarun Search', click: () => browser.sendUi('event', { type: 'command', id: 'about' }) },
        { label: 'Check for Updates…', click: () => browser.checkForUpdates(true) },
        { type: 'separator' },
        ...itemsFor('App'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'File', submenu: itemsFor('File') },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        ...itemsFor('Edit'),
      ],
    },
    { label: 'View', submenu: itemsFor('View') },
    { label: 'Go', submenu: itemsFor('Go') },
    { label: 'Tab', submenu: itemsFor('Tab') },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Tarun Search Help', click: () => shell.openExternal(HELP_URL) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function showPageMenu(browser, tab, params) {
  const wc = tab.wc;
  if (!wc) return;
  const items = [];
  const sep = () => items.length && items[items.length - 1].type !== 'separator' && items.push({ type: 'separator' });

  if (params.linkURL && isWebUrl(params.linkURL)) {
    const link = params.linkURL;
    items.push(
      { label: 'Open Link in New Tab', click: () => browser.newTab(link, { background: true, spaceId: browser.spaceIdFor(tab) }) },
      { label: 'Open Link in Peek', click: () => browser.openPeek(link, tab) },
      { label: 'Open Link in Split View', click: () => browser.openSplit(null, link), enabled: tab.kind !== 'peek' && !!browser.activeTab },
      { label: 'Copy Link Address', click: () => clipboard.writeText(link) },
    );
    sep();
  }
  if (params.mediaType === 'image' && isWebUrl(params.srcURL)) {
    const src = params.srcURL;
    items.push(
      { label: 'Open Image in New Tab', click: () => browser.newTab(src, { background: true, spaceId: browser.spaceIdFor(tab) }) },
      { label: 'Save Image As…', click: () => wc.downloadURL(src) },
      { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(src) },
    );
    sep();
  }
  if (params.misspelledWord) {
    for (const s of params.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!params.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false });
    items.push({ label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    sep();
  }
  if (params.isEditable) {
    const f = params.editFlags;
    items.push(
      { label: 'Undo', enabled: f.canUndo, click: () => wc.undo() },
      { label: 'Redo', enabled: f.canRedo, click: () => wc.redo() },
      { type: 'separator' },
      { label: 'Cut', enabled: f.canCut, click: () => wc.cut() },
      { label: 'Copy', enabled: f.canCopy, click: () => wc.copy() },
      { label: 'Paste', enabled: f.canPaste, click: () => wc.paste() },
      { label: 'Paste and Match Style', enabled: f.canPaste, click: () => wc.pasteAndMatchStyle() },
      { label: 'Select All', enabled: f.canSelectAll, click: () => wc.selectAll() },
    );
    sep();
  } else if (params.selectionText && params.selectionText.trim()) {
    const text = params.selectionText.trim().slice(0, 500);
    const engine = SEARCH_ENGINES[browser.settings.searchEngine] || SEARCH_ENGINES.duckduckgo;
    items.push(
      { label: 'Copy', click: () => wc.copy() },
      { label: `Search ${engine.name} for “${truncate(text, 28)}”`, click: () => browser.newTab(searchUrl(text, browser.settings.searchEngine), { spaceId: browser.spaceIdFor(tab) }) },
    );
    sep();
  }
  if (!params.linkURL && !params.isEditable && !(params.selectionText && params.selectionText.trim()) && params.mediaType !== 'image') {
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => browser.reloadTab(tab) },
      { type: 'separator' },
      { label: '⚡ Zap an Element…', click: () => browser.startZap(tab) },
      { label: 'Copy Page Link', click: () => browser.copyUrl(tab) },
      { label: 'Print…', click: () => wc.print() },
    );
    sep();
  }
  items.push({ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) });
  Menu.buildFromTemplate(items).popup({ window: browser.win });
}

function showTabMenu(browser, tabId) {
  const tab = browser.findTab(tabId);
  if (!tab) return;
  const space = browser.spaceOf(tab);
  const ghost = !!(space && space.ghost);
  const moveTargets = browser.spaces.filter((s) => s.id !== tab.spaceId && !s.ghost && !ghost);
  const items = [];
  if (tab.kind === 'tab') {
    items.push({ label: 'Pin Tab', click: () => browser.togglePin(tab.id) });
    if (!ghost) items.push({ label: 'Add to Favorites', click: () => browser.moveTab(tab.id, { kind: 'favorite' }) });
  } else if (tab.kind === 'pinned') {
    items.push({ label: 'Unpin Tab', click: () => browser.togglePin(tab.id) });
    if (!ghost) items.push({ label: 'Add to Favorites', click: () => browser.moveTab(tab.id, { kind: 'favorite' }) });
  } else if (tab.kind === 'favorite') {
    items.push({ label: 'Remove from Favorites', click: () => browser.togglePin(tab.id) });
  }
  if (tab.kind !== 'tab') items.push({ label: 'Go Back to Saved Page', enabled: !!tab.homeUrl && tab.url !== tab.homeUrl, click: () => browser.resetToHome(tab.id) });
  items.push({ type: 'separator' });
  items.push({ label: 'Duplicate', click: () => browser.duplicateTab(tab.id) });
  items.push({ label: 'Copy Link', click: () => browser.copyUrl(tab) });
  if (browser.activeTab && browser.activeTab.id !== tab.id && tab.kind !== 'peek') {
    items.push({ label: 'Open in Split View', click: () => browser.openSplit(tab.id) });
  }
  if (tab.wc) items.push({ label: tab.muted ? 'Unmute Tab' : 'Mute Tab', click: () => browser.setMuted(tab.id, !tab.muted) });
  if (moveTargets.length && tab.kind !== 'favorite') {
    items.push({
      label: 'Move to Space',
      submenu: moveTargets.map((s) => ({ label: `${s.emoji}  ${s.name}`, click: () => browser.moveTab(tab.id, { kind: tab.kind, spaceId: s.id }) })),
    });
  }
  items.push({ type: 'separator' });
  if (tab.kind === 'tab') {
    items.push({ label: 'Archive Tab', click: () => browser.archiveTab(tab.id) });
    items.push({ label: 'Close Other Tabs', click: () => browser.closeOthers(tab.id) });
    items.push({ label: 'Close Tab', click: () => browser.closeTab(tab.id) });
  } else {
    items.push({ label: 'Unload Tab', enabled: !tab.sleeping, click: () => browser.closeTab(tab.id) });
    items.push({ label: tab.kind === 'favorite' ? 'Delete Favorite' : 'Delete Pinned Tab', click: () => browser.removeTab(tab.id) });
  }
  Menu.buildFromTemplate(items).popup({ window: browser.win });
}

function showSpaceMenu(browser, spaceId) {
  const s = browser.spaces.find((x) => x.id === spaceId);
  if (!s) return;
  const realCount = browser.spaces.filter((x) => !x.ghost).length;
  const items = [
    { label: 'Edit Space…', enabled: !s.ghost, click: () => browser.sendUi('event', { type: 'command', id: 'edit-space', spaceId }) },
    { label: s.ghost ? 'Close Ghost Space (erase everything)' : 'Delete Space', enabled: s.ghost || realCount > 1, click: () => browser.sendUi('event', { type: 'command', id: 'delete-space', spaceId }) },
  ];
  Menu.buildFromTemplate(items).popup({ window: browser.win });
}

/** Cut/copy/paste menu for text fields inside the browser's own UI. */
function showUiEditMenu(browser, params) {
  if (!params.isEditable) return;
  const f = params.editFlags;
  Menu.buildFromTemplate([
    { role: 'cut', enabled: f.canCut },
    { role: 'copy', enabled: f.canCopy },
    { role: 'paste', enabled: f.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: f.canSelectAll },
  ]).popup({ window: browser.win });
}

module.exports = { buildAppMenu, showPageMenu, showTabMenu, showSpaceMenu, showUiEditMenu, HELP_URL };
