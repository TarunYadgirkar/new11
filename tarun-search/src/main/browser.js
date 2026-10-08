'use strict';

const path = require('node:path');
const { app, BrowserWindow, Notification, clipboard, shell, session, screen, nativeTheme } = require('electron');
const { Tab, prettyTitle } = require('./tab');
const { configureSession, isRiskyFile } = require('./sessions');
const { newId, isSafeSelector, sanitizeSetting, SPACE_COLORS, MAX_HISTORY, MAX_ARCHIVE } = require('./store');
const { normalizeInput, isWebUrl, isAllowedNavigation, hostOf, hostMatches, searchUrl, SEARCH_ENGINES, isLocalHost } = require('./url');
const { buildKeymap, matchInput } = require('./shortcuts');
const { ZAP_WORLD_ID, PICKER_SOURCE, CANCEL_SOURCE, cssFor } = require('./zap');
const menus = require('./menus');

const PERSIST_PARTITION = 'persist:tarun';
const IS_MAC = process.platform === 'darwin';
const RENDERER_URL = 'tarun://app/index.html';
const UPDATE_API = 'https://api.github.com/repos/tarunyadgirkar/new11/releases/latest';
const RELEASES_PAGE = 'https://github.com/tarunyadgirkar/new11/releases';

class Browser {
  constructor(store) {
    this.store = store;
    this.data = store.data;
    this.win = null;
    this.quitting = false;

    this.favorites = [];
    this.spaces = [];
    this.activeSpaceId = null;
    this.activeTabId = null;
    this.split = null; // { a, b } tab ids; shown while one of them is active
    this.peek = null; // Tab
    this.layout = { main: null, split: null, peek: null, overlay: false };
    this.htmlFullscreenTab = null;

    this.wcToTab = new Map();
    this.prompts = [];
    this.downloads = [];
    this.closedStack = [];
    this.httpAllowed = new Set();
    this.focus = null;
    this.focusTimer = null;
    this.ghostZaps = {};
    this.update = null;
    this.keymap = buildKeymap(process.platform);
    this.stateTimer = null;
    this.historyIndex = new Map();
    this.data.history.forEach((h) => this.historyIndex.set(h.url, h));
  }

  get settings() {
    return this.data.settings;
  }

  // ---------------------------------------------------------------- startup

  start() {
    nativeTheme.themeSource = this.settings.theme;
    configureSession(session.fromPartition(PERSIST_PARTITION), this);

    for (const rec of this.data.favorites) this.favorites.push(this.makeTab(rec, { kind: 'favorite', spaceId: null }));
    for (const s of this.data.spaces) {
      const space = this.makeSpace({ name: s.name, emoji: s.emoji, color: s.color, ghost: false });
      space.pinned = s.pinned.map((r) => this.makeTab(r, { kind: 'pinned', spaceId: space.id }));
      space.tabs = s.tabs.map((r) => this.makeTab(r, { kind: 'tab', spaceId: space.id }));
      const all = [...space.pinned, ...space.tabs];
      space.activeTabId = all[s.activeIndex] ? all[s.activeIndex].id : null;
      this.spaces.push(space);
    }
    const first = this.spaces[this.data.activeSpaceIndex] || this.spaces[0];
    this.activeSpaceId = first.id;
    this.autoArchive();

    this.createWindow();
    const space = this.activeSpace;
    if (space.activeTabId) this.activateTab(space.activeTabId, { focus: false });

    // Housekeeping: archive stale tabs, put idle tabs to sleep.
    this.housekeeping = setInterval(() => {
      this.autoArchive();
      this.sleepIdleTabs();
    }, 60 * 1000);

    if (this.settings.checkUpdates) setTimeout(() => this.checkForUpdates(false), 8000);
  }

  makeTab(rec, { kind, spaceId }) {
    const partition = spaceId ? this.partitionForSpace(spaceId) : PERSIST_PARTITION;
    return new Tab(this, rec, { kind, spaceId, partition });
  }

  makeSpace({ name, emoji, color, ghost }) {
    const id = newId();
    const partition = ghost ? `ghost-${id}` : PERSIST_PARTITION;
    if (ghost) configureSession(session.fromPartition(partition), this);
    return { id, name, emoji, color, ghost: !!ghost, partition, pinned: [], tabs: [], activeTabId: null };
  }

  partitionForSpace(spaceId) {
    const s = this.spaces.find((x) => x.id === spaceId);
    return s ? s.partition : PERSIST_PARTITION;
  }

  /** The space whose tabs use this session (for links opened from pop-ups). */
  spaceForSession(ses) {
    if (ses === session.fromPartition(this.activeSpace.partition)) return this.activeSpace;
    return this.spaces.find((s) => session.fromPartition(s.partition) === ses) || null;
  }

  /** Space a tab's follow-up links should open in: the one sharing its session. */
  spaceIdFor(tab) {
    if (tab.spaceId && this.spaces.some((s) => s.id === tab.spaceId && s.partition === tab.partition)) return tab.spaceId;
    const s = this.activeSpace.partition === tab.partition ? this.activeSpace : this.spaces.find((x) => x.partition === tab.partition);
    return s ? s.id : this.activeSpaceId;
  }

  isGhostPartition(partition) {
    return partition !== PERSIST_PARTITION && typeof partition === 'string' && partition.startsWith('ghost-');
  }

  isGhostSession(ses) {
    return this.spaces.some((s) => s.ghost && session.fromPartition(s.partition) === ses);
  }

  createWindow() {
    const b = this.data.windowBounds;
    const onScreen =
      b && screen.getAllDisplays().some((d) => {
        const w = d.workArea;
        return b.x < w.x + w.width - 80 && b.x + b.width > w.x + 80 && b.y < w.y + w.height - 80 && b.y + b.height > w.y;
      });
    const dark = nativeTheme.shouldUseDarkColors;
    this.win = new BrowserWindow({
      width: onScreen ? b.width : 1360,
      height: onScreen ? b.height : 880,
      x: onScreen ? b.x : undefined,
      y: onScreen ? b.y : undefined,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: 'Tarun Search',
      backgroundColor: dark ? '#17161d' : '#efedf5',
      titleBarStyle: 'hidden',
      ...(IS_MAC
        ? { trafficLightPosition: { x: 18, y: 19 } }
        : { titleBarOverlay: { color: dark ? '#17161d' : '#efedf5', symbolColor: dark ? '#f2f0fa' : '#1d1b26', height: 40 } }),
      icon: process.platform === 'linux' ? path.join(__dirname, '..', '..', 'build', 'icon.png') : undefined,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'ui-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        navigateOnDragDrop: false,
        devTools: !app.isPackaged,
      },
    });
    const ui = this.win.webContents;
    ui.setVisualZoomLevelLimits(1, 1);
    ui.on('zoom-changed', () => ui.setZoomLevel(0));
    ui.on('before-input-event', (event, input) => this.handleInput(event, input));
    ui.on('did-finish-load', () => this.pushState());
    ui.on('render-process-gone', () => setTimeout(() => !this.win.isDestroyed() && ui.reload(), 500));
    ui.on('context-menu', (_e, params) => menus.showUiEditMenu(this, params));
    this.win.loadURL(RENDERER_URL);

    this.win.once('ready-to-show', () => {
      if (onScreen && b.maximized) this.win.maximize();
      this.win.show();
    });
    const saveBounds = () => {
      if (this.win.isDestroyed() || this.win.isFullScreen()) return;
      this.data.windowBounds = { ...this.win.getNormalBounds(), maximized: this.win.isMaximized() };
      this.save();
    };
    this.win.on('resize', saveBounds);
    this.win.on('move', saveBounds);
    this.win.on('enter-full-screen', () => this.pushState());
    this.win.on('leave-full-screen', () => this.pushState());
    this.win.on('close', (e) => {
      if (IS_MAC && !this.quitting) {
        e.preventDefault();
        if (this.win.isFullScreen()) {
          this.win.once('leave-full-screen', () => this.win.hide());
          this.win.setFullScreen(false);
        } else this.win.hide();
      }
    });
    this.win.on('closed', () => {
      this.win = null;
    });
  }

  showWindow() {
    if (!this.win) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  // ---------------------------------------------------------------- lookup

  get activeSpace() {
    return this.spaces.find((s) => s.id === this.activeSpaceId) || this.spaces[0];
  }

  get activeTab() {
    return this.activeTabId ? this.findTab(this.activeTabId) : null;
  }

  allTabs() {
    const out = [...this.favorites];
    for (const s of this.spaces) out.push(...s.pinned, ...s.tabs);
    if (this.peek) out.push(this.peek);
    return out;
  }

  findTab(id) {
    if (this.peek && this.peek.id === id) return this.peek;
    return this.allTabs().find((t) => t.id === id) || null;
  }

  listOf(tab) {
    if (tab.kind === 'favorite') return this.favorites;
    const space = this.spaces.find((s) => s.id === tab.spaceId);
    if (!space) return null;
    return tab.kind === 'pinned' ? space.pinned : space.tabs;
  }

  spaceOf(tab) {
    return this.spaces.find((s) => s.id === tab.spaceId) || null;
  }

  /** The tab list as the sidebar shows it for the active space (used for Ctrl+Tab and Cmd+1…9). */
  visibleOrder() {
    const s = this.activeSpace;
    return [...this.favorites, ...s.pinned, ...s.tabs];
  }

  registerWebContents(wc, tab) {
    this.wcToTab.set(wc.id, tab);
    wc.once('destroyed', () => {
      if (this.wcToTab.get(wc.id) === tab) this.wcToTab.delete(wc.id);
    });
  }

  unregisterWebContents(wc) {
    this.wcToTab.delete(wc.id);
    this.dropPromptsFor(wc.id);
  }

  tabForWebContents(wc) {
    return wc ? this.wcToTab.get(wc.id) || null : null;
  }

  // ---------------------------------------------------------------- views & layout

  attachView(tab) {
    if (!this.win) return;
    this.win.contentView.addChildView(tab.view);
    if (this.peek && this.peek.view && tab !== this.peek) this.win.contentView.addChildView(this.peek.view); // keep peek on top
  }

  detachView(view) {
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.contentView.removeChildView(view);
      } catch {
        /* already removed */
      }
    }
  }

  setLayout(layout) {
    this.layout = layout;
    this.renderViews();
  }

  splitShown() {
    return !!this.split && (this.activeTabId === this.split.a || this.activeTabId === this.split.b);
  }

  renderViews() {
    if (!this.win || this.win.isDestroyed()) return;
    const placements = new Map();
    const L = this.layout;
    const fs = this.htmlFullscreenTab;
    if (fs && fs.view) {
      const [w, h] = this.win.getContentSize();
      placements.set(fs, { x: 0, y: 0, width: w, height: h, radius: 0 });
    } else if (!L.overlay && L.main) {
      const place = (tab, rect) => {
        if (!tab || !rect || tab.error) return;
        tab.ensureView();
        placements.set(tab, { ...rect, radius: 10 });
      };
      if (this.peek && L.peek) {
        // While peeking, the page behind is shown as a frozen picture by the UI.
        place(this.peek, L.peek);
      } else if (this.splitShown() && L.split) {
        place(this.findTab(this.split.a), L.main);
        place(this.findTab(this.split.b), L.split);
      } else {
        place(this.activeTab, L.main);
      }
    }
    for (const tab of this.allTabs()) {
      if (!tab.view) continue;
      const p = placements.get(tab);
      if (p) {
        tab.view.setBounds({ x: Math.round(p.x), y: Math.round(p.y), width: Math.max(1, Math.round(p.width)), height: Math.max(1, Math.round(p.height)) });
        tab.view.setBorderRadius(p.radius);
        tab.view.setVisible(true);
      } else {
        tab.view.setVisible(false);
      }
    }
  }

  setHtmlFullscreen(tab, on) {
    if (on) {
      this.htmlFullscreenTab = tab;
      this.wasFullScreen = this.win.isFullScreen();
      if (!this.wasFullScreen) this.win.setFullScreen(true);
    } else if (this.htmlFullscreenTab === tab) {
      this.htmlFullscreenTab = null;
      if (!this.wasFullScreen) this.win.setFullScreen(false);
    }
    this.renderViews();
    this.pushState();
  }

  /** Grab pictures of the visible pages so overlays can sit on a frozen, blurred backdrop. */
  async captureViews() {
    const shots = {};
    const grab = async (tab, key) => {
      if (!tab || !tab.wc || tab.error || !tab.view.getVisible()) return;
      try {
        const img = await tab.wc.capturePage();
        if (img.isEmpty()) return;
        const { width } = img.getSize();
        const small = width > 900 ? img.resize({ width: 900, quality: 'good' }) : img;
        shots[key] = 'data:image/jpeg;base64,' + small.toJPEG(70).toString('base64');
      } catch {
        /* page may be navigating; just skip the picture */
      }
    };
    if (this.splitShown()) {
      await Promise.all([grab(this.findTab(this.split.a), 'main'), grab(this.findTab(this.split.b), 'split')]);
    } else await grab(this.activeTab, 'main');
    if (this.peek) await grab(this.peek, 'peek');
    return shots;
  }

  // ---------------------------------------------------------------- tabs

  activateTab(id, { focus = true } = {}) {
    const tab = this.findTab(id);
    if (!tab || tab.kind === 'peek') return;
    if (tab.spaceId && tab.spaceId !== this.activeSpaceId) this.activeSpaceId = tab.spaceId;
    this.activeTabId = tab.id;
    this.activeSpace.activeTabId = tab.id;
    tab.lastActive = Date.now();
    if (this.focus && hostOf(tab.url) && this.isFocusBlocked(hostOf(tab.url)) && !tab.error) {
      tab.destroyView();
      tab.markFocusBlocked(tab.url);
    }
    this.renderViews();
    if (focus && tab.wc && !this.layout.overlay) tab.wc.focus();
    this.pushState();
    this.save();
  }

  newTab(input, { spaceId, background = false, index, focus = true } = {}) {
    const url = normalizeInput(input, this.settings.searchEngine);
    if (!url) return null;
    const space = this.spaces.find((s) => s.id === spaceId) || this.activeSpace;
    const tab = this.makeTab({ url, title: '' }, { kind: 'tab', spaceId: space.id });
    insertAt(space.tabs, tab, index);
    tab.ensureView();
    if (!background) this.activateTab(tab.id, { focus });
    else this.pushState();
    this.save();
    return tab;
  }

  navigate(id, input) {
    const tab = this.findTab(id);
    const url = normalizeInput(input, this.settings.searchEngine);
    if (!tab || !url) return;
    tab.load(url);
    this.renderViews();
    if (tab.wc && !this.layout.overlay) tab.wc.focus();
  }

  closeTab(id) {
    const tab = this.findTab(id);
    if (!tab) return;
    if (tab.kind === 'peek') return this.closePeek();
    if (this.split && (this.split.a === id || this.split.b === id)) this.split = null;
    this.dropPromptsForTab(tab);

    // Favorites and pinned tabs are never deleted by "close": they unload and reset home.
    if (tab.kind === 'favorite' || tab.kind === 'pinned') {
      tab.destroyView();
      tab.url = tab.homeUrl;
      tab.error = null;
      if (this.activeTabId === id) this.activateNeighbour(tab);
      this.pushState();
      this.save();
      return;
    }

    const list = this.listOf(tab);
    const space = this.spaceOf(tab);
    const idx = list.indexOf(tab);
    this.closedStack.push({ rec: tab.record(), spaceId: tab.spaceId, index: idx });
    if (this.closedStack.length > 30) this.closedStack.shift();
    const wasActive = this.activeTabId === id;
    if (wasActive) this.activateNeighbour(tab);
    list.splice(idx, 1);
    tab.destroyView();
    if (space.activeTabId === id) space.activeTabId = null;
    if (wasActive && this.activeTabId === id) this.activeTabId = null;
    this.renderViews();
    this.pushState();
    this.save();
  }

  activateNeighbour(tab) {
    const space = this.spaceOf(tab) || this.activeSpace;
    const list = tab.kind === 'favorite' ? this.favorites : tab.kind === 'pinned' ? space.pinned : space.tabs;
    const idx = list.indexOf(tab);
    // Prefer the most recently used open tab in this space; fall back to list neighbours.
    const candidates = [...space.tabs, ...space.pinned.filter((t) => !t.sleeping)].filter((t) => t !== tab);
    candidates.sort((x, y) => y.lastActive - x.lastActive);
    const next = candidates[0] || list[idx + 1] || list[idx - 1] || null;
    if (next && next !== tab) this.activateTab(next.id);
    else {
      this.activeTabId = null;
      space.activeTabId = null;
      this.renderViews();
      if (this.win) this.win.webContents.focus();
    }
  }

  reopenClosed() {
    const item = this.closedStack.pop();
    if (!item) return;
    const space = this.spaces.find((s) => s.id === item.spaceId) || this.activeSpace;
    const tab = this.makeTab(item.rec, { kind: 'tab', spaceId: space.id });
    insertAt(space.tabs, tab, item.index);
    this.activateTab(tab.id);
  }

  duplicateTab(id) {
    const tab = this.findTab(id);
    if (!tab) return;
    const spaceId = tab.spaceId || this.activeSpaceId;
    const space = this.spaces.find((s) => s.id === spaceId);
    const copy = this.makeTab({ url: tab.url, title: tab.title, favicon: tab.favicon }, { kind: 'tab', spaceId });
    const list = tab.kind === 'tab' ? space.tabs : null;
    insertAt(space.tabs, copy, list ? list.indexOf(tab) + 1 : 0);
    this.activateTab(copy.id);
  }

  /**
   * Move a tab between Favorites / Pinned / Today and between spaces.
   * Ghost-space tabs may only move within their own ghost space, so private
   * browsing can never leak into a saved space.
   */
  moveTab(id, { kind, spaceId, index }) {
    const tab = this.findTab(id);
    if (!tab || tab.kind === 'peek') return;
    const fromSpace = this.spaceOf(tab);
    const targetSpace = kind === 'favorite' ? null : this.spaces.find((s) => s.id === (spaceId || tab.spaceId || this.activeSpaceId));
    if (kind !== 'favorite' && !targetSpace) return;
    const fromGhost = !!(fromSpace && fromSpace.ghost);
    const toGhost = !!(targetSpace && targetSpace.ghost);
    if (fromGhost || toGhost) {
      if (kind === 'favorite' || !fromSpace || fromSpace !== targetSpace) return;
    }
    if (kind === 'favorite' && this.favorites.length >= 24 && tab.kind !== 'favorite') return;

    const from = this.listOf(tab);
    const oldIdx = from.indexOf(tab);
    from.splice(oldIdx, 1);
    const to = kind === 'favorite' ? this.favorites : kind === 'pinned' ? targetSpace.pinned : targetSpace.tabs;
    let at = Number.isInteger(index) ? index : to.length;
    if (from === to && oldIdx < at) at -= 1;
    insertAt(to, tab, at);

    const wasKind = tab.kind;
    tab.kind = kind;
    if ((kind === 'pinned' || kind === 'favorite') && wasKind === 'tab') tab.homeUrl = tab.url;
    const newSpaceId = kind === 'favorite' ? null : targetSpace.id;
    if (fromSpace && fromSpace.activeTabId === id && newSpaceId && newSpaceId !== fromSpace.id) fromSpace.activeTabId = null;
    tab.spaceId = newSpaceId;
    const newPartition = targetSpace ? targetSpace.partition : PERSIST_PARTITION;
    if (newPartition !== tab.partition) {
      tab.destroyView();
      tab.partition = newPartition;
    }
    if (this.activeTabId === id && newSpaceId && newSpaceId !== this.activeSpaceId) this.activeTabId = this.activeSpace.activeTabId;
    this.renderViews();
    this.pushState();
    this.save();
  }

  togglePin(id) {
    const tab = this.findTab(id);
    if (!tab || tab.kind === 'peek') return;
    if (tab.kind === 'tab') this.moveTab(id, { kind: 'pinned', spaceId: tab.spaceId });
    else if (tab.kind === 'pinned') this.moveTab(id, { kind: 'tab', spaceId: tab.spaceId, index: 0 });
    else if (tab.kind === 'favorite') this.moveTab(id, { kind: 'tab', spaceId: this.activeSpaceId, index: 0 });
  }

  removeTab(id) {
    // Permanently delete a favorite / pinned tab.
    const tab = this.findTab(id);
    if (!tab || tab.kind === 'tab' || tab.kind === 'peek') return this.closeTab(id);
    if (this.activeTabId === id) this.activateNeighbour(tab);
    const list = this.listOf(tab);
    list.splice(list.indexOf(tab), 1);
    tab.destroyView();
    if (this.activeTabId === id) this.activeTabId = null;
    this.renderViews();
    this.pushState();
    this.save();
  }

  resetToHome(id) {
    const tab = this.findTab(id);
    if (tab && tab.homeUrl) tab.load(tab.homeUrl);
  }

  setMuted(id, muted) {
    const tab = this.findTab(id);
    if (!tab || !tab.wc) return;
    tab.muted = !!muted;
    tab.wc.setAudioMuted(tab.muted);
    this.pushState();
  }

  closeOthers(id) {
    const tab = this.findTab(id);
    const space = tab && this.spaceOf(tab);
    if (!space) return;
    for (const t of [...space.tabs]) if (t.id !== id) this.closeTab(t.id);
  }

  tabFocused(tab) {
    if (this.split && this.splitShown() && (tab.id === this.split.a || tab.id === this.split.b) && this.activeTabId !== tab.id) {
      this.activeTabId = tab.id;
      this.activeSpace.activeTabId = tab.id;
      this.pushState();
    }
  }

  // ---------------------------------------------------------------- split view

  openSplit(otherId, input) {
    const active = this.activeTab;
    if (!active) return;
    let other = otherId ? this.findTab(otherId) : null;
    if (!other && input) {
      const spaceId = active.spaceId || (this.activeSpace.partition === active.partition ? this.activeSpaceId : this.spaces.find((x) => x.partition === active.partition)?.id);
      const list = this.listOf(active) || [];
      other = this.newTab(input, { background: true, spaceId, index: active.kind === 'tab' ? list.indexOf(active) + 1 : 0 });
    }
    if (!other || other.id === active.id || other.kind === 'peek') return;
    if (this.spaceOf(other) && this.spaceOf(active) && this.spaceOf(other).ghost !== this.spaceOf(active).ghost) return;
    this.split = { a: active.id, b: other.id };
    other.ensureView();
    this.renderViews();
    this.pushState();
  }

  closeSplit() {
    this.split = null;
    this.renderViews();
    this.pushState();
  }

  swapSplit() {
    if (!this.split) return;
    this.split = { a: this.split.b, b: this.split.a };
    this.renderViews();
    this.pushState();
  }

  // ---------------------------------------------------------------- peek

  openPeek(input, opener) {
    const url = normalizeInput(input, this.settings.searchEngine);
    if (!url) return;
    const tab = this.makePeek(opener);
    tab.url = url;
    tab.ensureView();
    this.showPeek(tab);
  }

  makePeek(opener) {
    const partition = opener ? opener.partition : this.activeSpace.partition;
    const spaceId = opener && opener.spaceId ? opener.spaceId : this.activeSpaceId;
    const tab = new Tab(this, { url: '', title: '' }, { kind: 'peek', spaceId, partition });
    return tab;
  }

  showPeek(tab) {
    if (this.peek) this.closePeek(false);
    this.peek = tab;
    if (tab.view) this.win.contentView.addChildView(tab.view);
    this.pushState();
  }

  closePeek(push = true) {
    const p = this.peek;
    if (!p) return;
    this.peek = null;
    this.dropPromptsForTab(p);
    p.destroyView();
    this.renderViews();
    if (push) this.pushState();
    const a = this.activeTab;
    if (a && a.wc) a.wc.focus();
  }

  expandPeek() {
    const p = this.peek;
    if (!p) return;
    this.peek = null;
    const space = this.spaces.find((s) => s.id === p.spaceId && s.partition === p.partition) || this.spaces.find((s) => s.partition === p.partition) || this.activeSpace;
    p.kind = 'tab';
    p.spaceId = space.id;
    if (p.partition !== space.partition) {
      p.destroyView();
      p.partition = space.partition;
    }
    space.tabs.unshift(p);
    this.activateTab(p.id);
  }

  handleWindowOpen(opener, details) {
    const { url, disposition, features } = details;
    if (!isAllowedNavigation(url)) return { action: 'deny' };
    const popup = disposition === 'new-window' && /\b(width|height|left|top|popup)\b/i.test(features || '');
    if (popup) {
      // At most two pop-ups per page at a time, so a site can't flood the screen.
      const mine = BrowserWindow.getAllWindows().filter((w) => w !== this.win && w.__tarunOpener === opener.id);
      if (mine.length >= 2) return { action: 'deny' };
      return {
        action: 'allow',
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          title: 'Tarun Search',
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, safeDialogs: true },
        },
      };
    }
    let mode = 'foreground';
    if (disposition === 'background-tab') mode = 'background';
    else if (disposition === 'new-window') mode = 'peek';
    else if ((opener.kind === 'pinned' || opener.kind === 'favorite') && hostOf(url) !== hostOf(opener.url)) mode = 'peek';
    if (opener.kind === 'peek' && mode === 'peek') mode = 'foreground';
    return {
      action: 'allow',
      outlivesOpener: true, // closing or sleeping the opener must never kill this tab
      createWindow: (options) => this.adoptOpened(opener, options, mode, url),
    };
  }

  adoptOpened(opener, options, mode, url) {
    // window.open() hands us the new page to adopt (keeping window.opener). Modifier
    // clicks (Shift/Ctrl/Cmd+click) don't: then we create a fresh sandboxed page and
    // load the URL ourselves.
    const adopt = options && options.webContents ? { webContents: options.webContents, webPreferences: options.webPreferences } : null;
    if (mode === 'peek') {
      const tab = this.makePeek(opener);
      tab.url = url;
      tab.ensureView(adopt);
      this.showPeek(tab);
      return tab.view.webContents;
    }
    // Keep the new tab in a space that shares the opener's session (cookies, logins).
    const space =
      this.spaces.find((s) => s.id === opener.spaceId && s.partition === opener.partition) ||
      (this.activeSpace.partition === opener.partition ? this.activeSpace : this.spaces.find((s) => s.partition === opener.partition)) ||
      this.activeSpace;
    const tab = this.makeTab({ url, title: '' }, { kind: 'tab', spaceId: space.id });
    tab.partition = opener.partition;
    const openerIdx = opener.kind === 'tab' ? space.tabs.indexOf(opener) : -1;
    insertAt(space.tabs, tab, openerIdx + 1);
    tab.ensureView(adopt);
    if (mode === 'foreground') {
      if (opener.kind === 'peek') this.closePeek(false);
      this.activateTab(tab.id);
    } else this.pushState();
    this.save();
    return tab.view.webContents;
  }

  // ---------------------------------------------------------------- spaces

  newSpace({ name, emoji, color, ghost }) {
    if (this.spaces.length >= 20) return;
    const space = this.makeSpace({
      name: (name || '').trim().slice(0, 40) || (ghost ? 'Ghost' : `Space ${this.spaces.length + 1}`),
      emoji: emoji || (ghost ? '👻' : '✨'),
      color: ghost ? '#5b5675' : color || SPACE_COLORS[this.spaces.length % SPACE_COLORS.length],
      ghost,
    });
    this.spaces.push(space);
    if (ghost) this.data.mysteries.ghost = true;
    this.switchSpace(space.id);
    this.save();
  }

  updateSpace(id, { name, emoji, color }) {
    const s = this.spaces.find((x) => x.id === id);
    if (!s) return;
    if (typeof name === 'string' && name.trim()) s.name = name.trim().slice(0, 40);
    if (typeof emoji === 'string' && emoji) s.emoji = emoji.slice(0, 16);
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) && !s.ghost) s.color = color;
    this.pushState();
    this.save();
  }

  deleteSpace(id) {
    const s = this.spaces.find((x) => x.id === id);
    if (!s) return;
    if (!s.ghost && this.spaces.filter((x) => !x.ghost).length <= 1) return; // always keep one real space
    if (this.split) {
      const ids = new Set([...s.pinned, ...s.tabs].map((t) => t.id));
      if (ids.has(this.split.a) || ids.has(this.split.b)) this.split = null;
    }
    if (this.peek && this.peek.partition === s.partition && s.ghost) this.closePeek(false);
    for (const t of [...s.pinned, ...s.tabs]) {
      this.dropPromptsForTab(t);
      t.destroyView();
    }
    this.spaces = this.spaces.filter((x) => x !== s);
    this.closedStack = this.closedStack.filter((c) => c.spaceId !== id);
    if (s.ghost) {
      delete this.ghostZaps[s.id];
      const ses = session.fromPartition(s.partition);
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
      ses.clearAuthCache().catch(() => {});
    }
    if (this.activeSpaceId === id) this.switchSpace(this.spaces[0].id);
    this.pushState();
    this.save();
  }

  switchSpace(id) {
    const s = this.spaces.find((x) => x.id === id);
    if (!s) return;
    if (this.peek && this.peek.partition !== s.partition) this.closePeek(false);
    this.activeSpaceId = s.id;
    const t = s.activeTabId && this.findTab(s.activeTabId);
    if (t) this.activateTab(t.id);
    else {
      this.activeTabId = null;
      this.renderViews();
      this.pushState();
      if (this.win) this.win.webContents.focus();
    }
    this.save();
  }

  cycleSpace(dir) {
    const i = this.spaces.findIndex((s) => s.id === this.activeSpaceId);
    const next = this.spaces[(i + dir + this.spaces.length) % this.spaces.length];
    this.switchSpace(next.id);
  }

  cycleTab(dir) {
    const s = this.activeSpace;
    const order = [...s.pinned, ...s.tabs];
    if (!order.length) return;
    const i = order.findIndex((t) => t.id === this.activeTabId);
    const next = order[(i + dir + order.length) % order.length];
    this.activateTab(next.id);
  }

  // ---------------------------------------------------------------- archive & sleep

  autoArchive() {
    const hours = this.settings.archiveAfterHours;
    if (!hours) return;
    const cutoff = Date.now() - hours * 3600 * 1000;
    let changed = false;
    for (const s of this.spaces) {
      for (const t of [...s.tabs]) {
        if (t.id === this.activeTabId || t.audible || t.lastActive > cutoff) continue;
        if (this.split && (this.split.a === t.id || this.split.b === t.id)) continue;
        if (!s.ghost) this.addToArchive(t);
        s.tabs.splice(s.tabs.indexOf(t), 1);
        t.destroyView();
        if (s.activeTabId === t.id) s.activeTabId = null;
        changed = true;
      }
    }
    if (changed) {
      this.pushState();
      this.save();
    }
  }

  addToArchive(tab) {
    if (!isWebUrl(tab.url)) return;
    this.data.archive.unshift({ url: tab.url, title: tab.title, favicon: tab.favicon, archivedAt: Date.now() });
    if (this.data.archive.length > MAX_ARCHIVE) this.data.archive.length = MAX_ARCHIVE;
  }

  archiveTab(id) {
    const tab = this.findTab(id);
    if (!tab || tab.kind !== 'tab') return;
    const space = this.spaceOf(tab);
    if (space && !space.ghost) this.addToArchive(tab);
    this.closeTab(id);
    this.closedStack.pop(); // archived tabs live in the archive, not the reopen stack
  }

  restoreArchived(index) {
    const item = this.data.archive[index];
    if (!item) return;
    this.data.archive.splice(index, 1);
    const space = this.activeSpace.ghost ? this.spaces.find((s) => !s.ghost) : this.activeSpace;
    const tab = this.makeTab(item, { kind: 'tab', spaceId: space.id });
    space.tabs.unshift(tab);
    this.activateTab(tab.id);
  }

  sleepIdleTabs() {
    const mins = this.settings.sleepAfterMinutes;
    if (!mins) return;
    const cutoff = Date.now() - mins * 60 * 1000;
    let changed = false;
    for (const t of this.allTabs()) {
      if (!t.view || t.kind === 'peek' || t.id === this.activeTabId || t.audible || t.lastActive > cutoff) continue;
      if (this.split && (this.split.a === t.id || this.split.b === t.id)) continue;
      if (t.wc && t.wc.isCurrentlyAudible()) continue;
      if (this.prompts.some((p) => p.tabId === t.id)) continue;
      t.destroyView();
      changed = true;
    }
    if (changed) this.pushState();
  }

  // ---------------------------------------------------------------- history

  recordHistory(tab) {
    const space = this.spaceOf(tab);
    if ((space && space.ghost) || !isWebUrl(tab.url)) return;
    let h = this.historyIndex.get(tab.url);
    if (h) {
      this.data.history.splice(this.data.history.indexOf(h), 1);
      h.visits += 1;
      h.visitedAt = Date.now();
      if (tab.title) h.title = tab.title;
    } else {
      h = { url: tab.url, title: tab.title, visitedAt: Date.now(), visits: 1 };
      this.historyIndex.set(tab.url, h);
    }
    this.data.history.unshift(h);
    this.topSitesCache = null;
    while (this.data.history.length > MAX_HISTORY) this.historyIndex.delete(this.data.history.pop().url);
    this.save();
  }

  updateHistoryTitle(tab) {
    const h = this.historyIndex.get(tab.url);
    const space = this.spaceOf(tab);
    if (h && tab.title && !(space && space.ghost)) {
      h.title = tab.title;
      this.save();
    }
  }

  clearHistory() {
    this.data.history = [];
    this.historyIndex.clear();
    this.topSitesCache = null;
    this.save();
    this.pushState();
  }

  async clearBrowsingData() {
    this.clearHistory();
    this.data.archive = [];
    this.closedStack = [];
    const ses = session.fromPartition(PERSIST_PARTITION);
    await Promise.allSettled([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()]);
    for (const t of this.allTabs()) if (t.wc) t.wc.reload();
    this.toast('Cookies, cache, history and archive cleared.');
    this.pushState();
    this.save();
  }

  // ---------------------------------------------------------------- search (command bar)

  search(text) {
    const q = String(text || '').trim().toLowerCase().slice(0, 300);
    const terms = q.split(/\s+/).filter(Boolean);
    const matches = (s) => terms.every((t) => s.includes(t));
    const tabs = [];
    for (const s of this.spaces) {
      for (const t of [...s.pinned, ...s.tabs]) {
        const hay = `${t.title} ${t.url}`.toLowerCase();
        if (!terms.length || matches(hay)) tabs.push({ id: t.id, title: t.title || prettyTitle(t.url), url: t.url, favicon: t.favicon, space: `${s.emoji} ${s.name}`, active: t.id === this.activeTabId });
      }
    }
    for (const t of this.favorites) {
      const hay = `${t.title} ${t.url}`.toLowerCase();
      if (!terms.length || matches(hay)) tabs.push({ id: t.id, title: t.title || prettyTitle(t.url), url: t.url, favicon: t.favicon, space: '★ Favorites', active: t.id === this.activeTabId });
    }
    const openUrls = new Set(tabs.map((t) => t.url));
    const history = [];
    if (terms.length) {
      const now = Date.now();
      for (const h of this.data.history) {
        if (openUrls.has(h.url)) continue;
        const hay = `${h.title} ${h.url}`.toLowerCase();
        if (!matches(hay)) continue;
        const ageDays = (now - h.visitedAt) / 86400000;
        const hostHit = terms.some((t) => hostOf(h.url).includes(t));
        history.push({ url: h.url, title: h.title || prettyTitle(h.url), score: Math.log2(h.visits + 1) * 10 - ageDays + (hostHit ? 15 : 0) });
        if (history.length > 400) break;
      }
      history.sort((a, b) => b.score - a.score);
    }
    const archive = terms.length
      ? this.data.archive
          .map((a, index) => ({ ...a, index }))
          .filter((a) => matches(`${a.title} ${a.url}`.toLowerCase()))
          .slice(0, 5)
      : [];
    return { tabs: tabs.slice(0, terms.length ? 8 : 6), history: history.slice(0, 8), archive };
  }

  topSites() {
    if (this.topSitesCache) return this.topSitesCache;
    const scores = new Map();
    for (const h of this.data.history.slice(0, 1500)) {
      const host = hostOf(h.url);
      if (!host || isLocalHost(host) || this.isSearchPage(h.url)) continue;
      const cur = scores.get(host) || { host, url: `https://${host}/`, title: '', score: 0 };
      cur.score += 1;
      if (!cur.title && h.url.replace(/\/$/, '') === `https://${host}`) cur.title = h.title;
      scores.set(host, cur);
    }
    this.topSitesCache = [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((s) => ({ url: s.url, title: s.title || s.host.replace(/^www\./, ''), host: s.host }));
    return this.topSitesCache;
  }

  isDefaultBrowser() {
    // Asking the OS can spawn a process (xdg-settings on Linux), so cache the answer.
    if (this.defaultBrowserCache === undefined) {
      try {
        this.defaultBrowserCache = app.isDefaultProtocolClient('https');
      } catch {
        this.defaultBrowserCache = false;
      }
    }
    return this.defaultBrowserCache;
  }

  isSearchPage(url) {
    return Object.values(SEARCH_ENGINES).some((e) => {
      try {
        const a = new URL(e.url.replace('%s', 'x'));
        const b = new URL(url);
        return a.hostname === b.hostname && a.pathname === b.pathname;
      } catch {
        return false;
      }
    });
  }

  // ---------------------------------------------------------------- page tools

  zoom(tab, delta) {
    if (!tab || !tab.wc) return;
    tab.zoom = delta === 0 ? 0 : Math.max(-5, Math.min(5, tab.zoom + delta));
    tab.wc.setZoomLevel(tab.zoom);
    this.pushState();
  }

  findInPage(text, { forward = true, findNext = false } = {}) {
    const tab = this.activeTab;
    if (!tab || !tab.wc) return;
    if (!text) {
      tab.wc.stopFindInPage('clearSelection');
      tab.find = { text: '', active: 0, matches: 0 };
      return this.pushState();
    }
    tab.find = { ...(tab.find || {}), text };
    tab.wc.findInPage(text, { forward, findNext });
  }

  stopFind() {
    const tab = this.activeTab;
    if (!tab) return;
    if (tab.wc) tab.wc.stopFindInPage('keepSelection');
    tab.find = null;
    this.pushState();
    if (tab.wc) tab.wc.focus();
  }

  copyUrl(tab = this.activeTab) {
    if (!tab || !isWebUrl(tab.url)) return;
    clipboard.writeText(tab.url);
    this.toast('Link copied to clipboard');
  }

  // ---------------------------------------------------------------- zap (mystery #2)

  zapStore(tab) {
    const space = this.spaceOf(tab);
    if (!space || !space.ghost) return this.data.zaps;
    return (this.ghostZaps[space.id] = this.ghostZaps[space.id] || {});
  }

  async startZap(tab = this.activeTab) {
    const wc = tab && tab.wc;
    if (!wc || tab.error || !hostOf(tab.url)) return this.toast('Open a web page first, then zap away.');
    if (tab.zapping) {
      wc.executeJavaScriptInIsolatedWorld(ZAP_WORLD_ID, [{ code: CANCEL_SOURCE }]).catch(() => {});
      return;
    }
    tab.zapping = true;
    this.pushState();
    wc.focus();
    const host = hostOf(tab.url);
    let selector = null;
    try {
      selector = await wc.executeJavaScriptInIsolatedWorld(ZAP_WORLD_ID, [{ code: PICKER_SOURCE }], true);
    } catch {
      selector = null;
    }
    tab.zapping = false;
    this.pushState();
    if (!selector || !isSafeSelector(selector) || tab.wc !== wc || hostOf(tab.url) !== host) return;
    const store = this.zapStore(tab);
    const list = (store[host] = store[host] || []);
    if (!list.includes(selector)) list.push(selector);
    if (list.length > 100) list.shift();
    wc.insertCSS(cssFor([selector]), { cssOrigin: 'user' }).catch(() => {});
    this.data.mysteries.zap = true;
    this.toast(`Zapped! ${host} will stay that way.`, { action: 'Undo all on this site', command: 'zap:clear', payload: { host } });
    this.save();
  }

  applyZaps(tab) {
    const host = hostOf(tab.url);
    if (!host || !tab.wc) return;
    const sels = (this.zapStore(tab)[host] || []).filter(isSafeSelector);
    if (sels.length) tab.wc.insertCSS(cssFor(sels), { cssOrigin: 'user' }).catch(() => {});
  }

  clearZaps(host) {
    delete this.data.zaps[host];
    for (const z of Object.values(this.ghostZaps)) delete z[host];
    for (const t of this.allTabs()) if (t.wc && hostOf(t.url) === host) t.wc.reload();
    this.toast(`Zaps removed for ${host}`);
    this.save();
  }

  // ---------------------------------------------------------------- focus flow (mystery #3)

  isFocusBlocked(host) {
    return !!this.focus && !!host && this.settings.focusBlocklist.some((d) => hostMatches(host, d));
  }

  startFocus(minutes) {
    const m = Math.max(1, Math.min(180, Math.round(minutes)));
    clearTimeout(this.focusTimer);
    const now = Date.now();
    this.focus = { startedAt: now, endsAt: now + m * 60000, minutes: m };
    this.focusTimer = setTimeout(() => this.stopFocus(true), m * 60000);
    this.data.mysteries.focus = true;
    for (const t of this.allTabs()) {
      if (this.isFocusBlocked(hostOf(t.url))) {
        t.destroyView();
        t.markFocusBlocked(t.url);
      }
    }
    this.renderViews();
    this.toast(`Focus Flow on for ${m} min. Distracting sites are on pause.`);
    this.pushState();
    this.save();
  }

  stopFocus(completed) {
    if (!this.focus) return;
    const m = this.focus.minutes;
    clearTimeout(this.focusTimer);
    this.focus = null;
    for (const t of this.allTabs()) {
      if (t.error && t.error.type === 'focus') t.error = null;
    }
    this.renderViews();
    if (completed) {
      this.toast(`🎉 Focus Flow complete — ${m} minutes of deep work!`);
      if (Notification.isSupported()) new Notification({ title: 'Focus Flow complete 🎉', body: `You stayed focused for ${m} minutes. Take a break!`, silent: false }).show();
    } else this.toast('Focus Flow ended.');
    this.pushState();
  }

  // ---------------------------------------------------------------- permissions

  savedPermission(origin, permission) {
    const rec = this.data.permissions[origin];
    return rec ? rec[permission] || null : null;
  }

  askPermission(wc, { permission, origin, detail, remember, callback }) {
    const tab = this.tabForWebContents(wc);
    const existing = this.prompts.find((p) => p.wcId === (wc && wc.id) && p.origin === origin && p.permission === permission && p.detail === detail);
    if (existing) {
      existing.callbacks.push(callback);
      return;
    }
    if (this.prompts.length >= 6) return callback(false);
    this.prompts.push({ id: newId(), wcId: wc ? wc.id : null, tabId: tab ? tab.id : null, tabTitle: tab ? tab.title : '', origin, permission, detail, remember, callbacks: [callback] });
    this.pushState();
    if (this.win && !this.win.isFocused()) this.win.flashFrame(true);
  }

  answerPrompt(id, allow, remember) {
    const p = this.prompts.find((x) => x.id === id);
    if (!p) return;
    this.prompts = this.prompts.filter((x) => x !== p);
    if (remember && p.remember) {
      this.data.permissions[p.origin] = { ...(this.data.permissions[p.origin] || {}), [p.permission]: allow ? 'allow' : 'deny' };
      this.save();
    }
    for (const cb of p.callbacks) {
      try {
        cb(!!allow);
      } catch {
        /* the requesting page is gone */
      }
    }
    this.pushState();
  }

  dropPromptsFor(wcId) {
    const gone = this.prompts.filter((p) => p.wcId === wcId);
    if (!gone.length) return;
    this.prompts = this.prompts.filter((p) => p.wcId !== wcId);
    for (const p of gone) for (const cb of p.callbacks) try { cb(false); } catch { /* ignore */ }
    this.pushState();
  }

  dropPromptsForTab(tab) {
    if (tab.wc) this.dropPromptsFor(tab.wc.id);
  }

  sitePermissions() {
    return Object.entries(this.data.permissions)
      .filter(([, rec]) => Object.keys(rec).length)
      .map(([origin, rec]) => ({ origin, perms: rec }));
  }

  forgetSitePermissions(origin) {
    delete this.data.permissions[origin];
    this.save();
  }

  // ---------------------------------------------------------------- downloads

  trackDownload(item, savePath) {
    const d = {
      id: newId(),
      filename: path.basename(savePath),
      path: savePath,
      received: 0,
      total: item.getTotalBytes(),
      state: 'progressing',
      risky: isRiskyFile(savePath),
      item,
    };
    this.downloads.push(d);
    if (this.downloads.length > 20) this.downloads.shift();
    item.on('updated', (_e, state) => {
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      this.pushStateSoon();
    });
    item.once('done', (_e, state) => {
      d.received = item.getReceivedBytes();
      d.state = state; // completed | cancelled | interrupted
      d.item = null;
      if (state === 'completed') {
        this.toast(`Downloaded ${d.filename}`);
        if (IS_MAC) app.dock?.downloadFinished(savePath);
      }
      this.pushState();
    });
    this.pushState();
  }

  downloadAction(id, action) {
    const d = this.downloads.find((x) => x.id === id);
    if (!d) return;
    if (action === 'show') shell.showItemInFolder(d.path);
    else if (action === 'open' && d.state === 'completed') {
      if (d.risky) shell.showItemInFolder(d.path);
      else shell.openPath(d.path);
    } else if (action === 'cancel' && d.item) d.item.cancel();
    else if (action === 'clear') this.downloads = this.downloads.filter((x) => x !== d);
    this.pushState();
  }

  // ---------------------------------------------------------------- settings & misc

  setSetting(key, value) {
    const clean = sanitizeSetting(key, value);
    if (clean === undefined) return;
    this.data.settings[key] = clean;
    if (key === 'theme') nativeTheme.themeSource = clean;
    if (key === 'archiveAfterHours') this.autoArchive();
    this.pushState();
    this.save();
  }

  toggleShields(tab = this.activeTab) {
    const host = tab && hostOf(tab.url);
    if (!host) return;
    const site = host.replace(/^www\./, '');
    const list = this.settings.shieldsDownSites;
    const down = list.some((d) => hostMatches(host, d));
    this.setSetting('shieldsDownSites', down ? list.filter((d) => !hostMatches(host, d)) : [...list, site]);
    this.toast(down ? `Tracker blocking back on for ${site}` : `Tracker blocking paused for ${site}`);
    if (tab.wc) tab.wc.reload();
  }

  allowHttp(tabId) {
    const tab = this.findTab(tabId);
    if (!tab || !tab.error || tab.error.type !== 'https') return;
    const { host, url } = tab.error;
    this.httpAllowed.add(host);
    tab.httpsUpgrade = null;
    tab.load(url);
    this.renderViews();
  }

  reloadTab(tab, hard = false) {
    if (!tab) return;
    if (tab.error && tab.error.type === 'focus' && this.focus) return;
    tab.error = null;
    if (!tab.wc) {
      tab.ensureView();
      this.renderViews();
      return;
    }
    if (hard) tab.wc.reloadIgnoringCache();
    else tab.wc.reload();
    this.renderViews();
  }

  toast(text, extra = {}) {
    this.sendUi('event', { type: 'toast', text: String(text).slice(0, 300), ...extra });
  }

  async checkForUpdates(manual) {
    try {
      // A separate, cookie-less session just for this one request.
      const res = await session.fromPartition('tarun-updates').fetch(UPDATE_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      const latest = String(json.tag_name || '').replace(/^v/, '');
      if (/^\d+\.\d+\.\d+$/.test(latest) && newerVersion(latest, app.getVersion())) {
        const url = typeof json.html_url === 'string' && json.html_url.startsWith('https://github.com/') ? json.html_url : RELEASES_PAGE;
        this.update = { version: latest, url };
        this.pushState();
        if (manual) this.toast(`Tarun Search ${latest} is available!`);
      } else if (manual) this.toast("You're on the latest version.");
    } catch {
      if (manual) this.toast("Couldn't check for updates right now.");
    }
  }

  openExternalSafe(url) {
    if (isWebUrl(url)) shell.openExternal(url);
  }

  setDefaultBrowser() {
    if (process.platform === 'win32') {
      shell.openExternal('ms-settings:defaultapps');
      this.toast('Pick “Tarun Search” as your web browser in Windows Settings.');
      return;
    }
    const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
    this.defaultBrowserCache = undefined;
    this.toast(ok ? 'Tarun Search is now your default browser 🎉' : 'Your system did not allow changing the default browser.');
    this.pushState();
  }

  openUrlsFromOs(urls) {
    const clean = urls.filter(isWebUrl).slice(0, 10);
    if (!clean.length) return;
    if (this.activeSpace.ghost) {
      const normal = this.spaces.find((s) => !s.ghost);
      if (normal) this.switchSpace(normal.id);
    }
    for (const u of clean) this.newTab(u);
    this.showWindow();
  }

  // ---------------------------------------------------------------- input & commands

  handleInput(event, input) {
    if (IS_MAC) return; // macOS uses real menu accelerators
    const id = matchInput(this.keymap, input);
    if (!id) return;
    if (id === 'peek-expand' && !this.peek) return; // keep Ctrl+Enter for pages
    event.preventDefault();
    this.runCommand(id);
  }

  runCommand(id) {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && this.win && focused !== this.win) {
      // A site popup (e.g. a sign-in window) has focus.
      if (id === 'close-tab') focused.close();
      return;
    }
    const tab = this.activeTab;
    const target = this.peek && this.peekFocused() ? this.peek : tab;
    const ui = (cmd) => this.sendUi('event', { type: 'command', id: cmd });
    switch (id) {
      case 'new-tab':
      case 'open-location':
      case 'new-space':
      case 'find':
      case 'toggle-sidebar':
      case 'settings':
      case 'history':
      case 'split':
        if (id === 'find' && !(tab && tab.wc)) return;
        return ui(id);
      case 'find-next':
      case 'find-prev':
        if (tab && tab.find && tab.find.text) this.findInPage(tab.find.text, { forward: id === 'find-next', findNext: true });
        else if (tab && tab.wc) ui('find');
        return;
      case 'new-ghost':
        return this.newSpace({ ghost: true });
      case 'reopen-tab':
        return this.reopenClosed();
      case 'close-tab':
        if (this.peek) return this.closePeek();
        if (tab) this.closeTab(tab.id);
        return;
      case 'print':
        if (target && target.wc) target.wc.print();
        return;
      case 'copy-url':
        return this.copyUrl(target);
      case 'reload':
        return this.reloadTab(target);
      case 'hard-reload':
        return this.reloadTab(target, true);
      case 'zoom-in':
        return this.zoom(target, 0.5);
      case 'zoom-out':
        return this.zoom(target, -0.5);
      case 'zoom-reset':
        return this.zoom(target, 0);
      case 'fullscreen':
        if (this.win) this.win.setFullScreen(!this.win.isFullScreen());
        return;
      case 'devtools':
        if (target && target.wc) target.wc.toggleDevTools();
        return;
      case 'back':
        if (target && target.wc && target.wc.navigationHistory.canGoBack()) target.wc.navigationHistory.goBack();
        return;
      case 'forward':
        if (target && target.wc && target.wc.navigationHistory.canGoForward()) target.wc.navigationHistory.goForward();
        return;
      case 'next-tab':
        return this.cycleTab(1);
      case 'prev-tab':
        return this.cycleTab(-1);
      case 'next-space':
        return this.cycleSpace(1);
      case 'prev-space':
        return this.cycleSpace(-1);
      case 'pin-tab':
        if (tab) this.togglePin(tab.id);
        return;
      case 'peek-expand':
        return this.expandPeek();
      case 'zap':
        return this.startZap(target);
      case 'focus':
        if (this.focus) return this.stopFocus(false);
        return ui('focus');
      default: {
        const m = /^tab-(\d)$/.exec(id);
        if (m) {
          const order = this.visibleOrder();
          const n = Number(m[1]);
          const t = n === 9 ? order[order.length - 1] : order[n - 1];
          if (t) this.activateTab(t.id);
        }
      }
    }
  }

  peekFocused() {
    return !!(this.peek && this.peek.wc && this.peek.wc.isFocused());
  }

  showPageMenu(tab, params) {
    menus.showPageMenu(this, tab, params);
  }

  // ---------------------------------------------------------------- state sync

  sendUi(channel, payload) {
    if (this.win && !this.win.isDestroyed() && !this.win.webContents.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  tabChanged(tab) {
    if (tab.error && tab.view && tab.view.getVisible()) this.renderViews();
    else if (!tab.error && tab.view && !tab.view.getVisible() && this.isPlaced(tab)) this.renderViews();
    this.pushStateSoon();
  }

  tabChangedSoon() {
    this.pushStateSoon(250);
  }

  isPlaced(tab) {
    if (this.peek === tab) return true;
    if (this.splitShown()) return tab.id === this.split.a || tab.id === this.split.b;
    return tab.id === this.activeTabId;
  }

  pushStateSoon(delay = 40) {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => this.pushState(), delay);
  }

  pushState() {
    clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.sendUi('state', this.snapshot());
  }

  snapshot() {
    const sum = (t) => t.summary();
    return {
      platform: process.platform,
      version: app.getVersion(),
      settings: this.settings,
      engines: Object.fromEntries(Object.entries(SEARCH_ENGINES).map(([k, v]) => [k, v.name])),
      favorites: this.favorites.map(sum),
      spaces: this.spaces.map((s) => ({ id: s.id, name: s.name, emoji: s.emoji, color: s.color, ghost: s.ghost, pinned: s.pinned.map(sum), tabs: s.tabs.map(sum) })),
      activeSpaceId: this.activeSpaceId,
      activeTabId: this.activeTabId,
      split: this.split && this.splitShown() ? { ...this.split } : null,
      splitPair: this.split ? { ...this.split } : null,
      peek: this.peek ? this.peek.summary() : null,
      prompts: this.prompts.map(({ id, tabId, tabTitle, origin, permission, detail, remember }) => ({ id, tabId, tabTitle, origin, permission, detail, remember })),
      downloads: this.downloads.map(({ id, filename, received, total, state, risky }) => ({ id, filename, received, total, state, risky })),
      archiveCount: this.data.archive.length,
      canReopen: this.closedStack.length > 0,
      focus: this.focus,
      mysteries: this.data.mysteries,
      update: this.update,
      htmlFullscreen: !!this.htmlFullscreenTab,
      windowFullscreen: !!(this.win && !this.win.isDestroyed() && this.win.isFullScreen()),
      isDefaultBrowser: this.isDefaultBrowser(),
      topSites: this.topSites(),
    };
  }

  // ---------------------------------------------------------------- persistence

  save() {
    this.store.save(() => this.serialize(), 1500);
  }

  serialize() {
    const rec = (t) => t.record();
    const real = this.spaces.filter((s) => !s.ghost);
    const activeReal = real.findIndex((s) => s.id === this.activeSpaceId);
    return {
      version: 1,
      settings: this.settings,
      favorites: this.favorites.map(rec),
      spaces: real.map((s) => {
        const all = [...s.pinned, ...s.tabs];
        return { name: s.name, emoji: s.emoji, color: s.color, pinned: s.pinned.map(rec), tabs: s.tabs.map(rec), activeIndex: all.findIndex((t) => t.id === s.activeTabId) };
      }),
      activeSpaceIndex: Math.max(0, activeReal),
      archive: this.data.archive,
      history: this.data.history,
      permissions: this.data.permissions,
      zaps: this.data.zaps,
      mysteries: this.data.mysteries,
      windowBounds: this.data.windowBounds,
    };
  }

  shutdown() {
    this.quitting = true;
    clearInterval(this.housekeeping);
    clearTimeout(this.focusTimer);
    this.store.getSnapshot = () => this.serialize();
    this.store.flush();
    for (const s of this.spaces.filter((x) => x.ghost)) {
      const ses = session.fromPartition(s.partition);
      ses.clearStorageData().catch(() => {});
    }
  }
}

function insertAt(list, item, index) {
  const i = Number.isInteger(index) ? Math.max(0, Math.min(index, list.length)) : list.length;
  list.splice(i, 0, item);
}

function newerVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

module.exports = { Browser, PERSIST_PARTITION, RENDERER_URL, newerVersion, searchUrl };
