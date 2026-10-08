'use strict';

const { WebContentsView } = require('electron');
const { newId } = require('./store');
const { safeFaviconUrl, isWebUrl, hostOf } = require('./url');

// Network errors where offering "continue over http" makes sense after an HTTPS upgrade.
const HTTPS_FALLBACK_ERRORS = new Set([-310, -100, -101, -102, -104, -105, -106, -107, -109, -113, -118, -137, -200, -201, -202, -203, -204, -206, -207, -208, -210, -212, -213, -501]);

function tabWebPreferences(partition) {
  return {
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    enableBlinkFeatures: '',
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: true,
    disableDialogs: false,
  };
}

class Tab {
  /**
   * @param browser the Browser that owns this tab
   * @param rec     persisted record {url, homeUrl, title, favicon, lastActive}
   * @param place   {kind: 'favorite'|'pinned'|'tab'|'peek', spaceId}
   */
  constructor(browser, rec, place) {
    this.browser = browser;
    this.id = newId();
    this.url = rec.url || '';
    this.homeUrl = rec.homeUrl || rec.url || '';
    this.title = rec.title || '';
    this.favicon = rec.favicon || '';
    this.lastActive = rec.lastActive || Date.now();
    this.kind = place.kind;
    this.spaceId = place.spaceId || null;
    this.partition = place.partition;

    this.view = null;
    this.loading = false;
    this.error = null;
    this.blocked = 0;
    this.audible = false;
    this.muted = false;
    this.zoom = 0;
    this.find = null;
    this.canGoBack = false;
    this.canGoForward = false;
    this.fullscreen = false;
    this.httpsUpgrade = null;
    this.zapping = false;
  }

  get wc() {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
  }

  get sleeping() {
    return !this.view;
  }

  record() {
    return { url: this.url, homeUrl: this.homeUrl, title: this.title, favicon: this.favicon, lastActive: this.lastActive };
  }

  summary() {
    return {
      id: this.id,
      url: this.url,
      title: this.title || prettyTitle(this.url),
      favicon: this.browser.isGhostPartition(this.partition) ? '' : this.favicon, // keeps Ghost sites out of the UI's image cache
      kind: this.kind,
      loading: this.loading,
      sleeping: this.sleeping,
      audible: this.audible,
      muted: this.muted,
      blocked: this.blocked,
      error: this.error,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      zoom: this.zoom,
      secure: this.url.startsWith('https://'),
      find: this.find,
      zapping: this.zapping,
      changedFromHome: (this.kind === 'pinned' || this.kind === 'favorite') && hostOf(this.url) !== hostOf(this.homeUrl),
    };
  }

  changed() {
    this.browser.tabChanged(this);
  }

  /** Create (or adopt) the native view and start loading. */
  ensureView(adopt) {
    if (this.wc) return this.view;
    if (this.view) this.destroyView();
    if (adopt && !adopt.webContents) adopt = null;
    const view = adopt
      ? new WebContentsView({ webContents: adopt.webContents, webPreferences: { ...adopt.webPreferences, ...tabWebPreferences(this.partition) } })
      : new WebContentsView({ webPreferences: tabWebPreferences(this.partition) });
    view.setBorderRadius(10);
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    this.view = view;
    this.browser.attachView(this);
    this.wire(view.webContents);
    if (!adopt && this.url) this.load(this.url);
    return view;
  }

  load(url) {
    if (!isWebUrl(url)) return;
    this.url = url;
    this.error = null;
    const wc = this.wc;
    if (!wc) {
      this.ensureView();
      return;
    }
    wc.loadURL(url).catch(() => {
      /* failures are reported through did-fail-load */
    });
    this.changed();
  }

  destroyView() {
    const view = this.view;
    this.view = null;
    this.loading = false;
    this.audible = false;
    this.find = null;
    this.zapping = false;
    if (!view) return;
    this.browser.detachView(view);
    const wc = view.webContents;
    if (wc && !wc.isDestroyed()) {
      this.browser.unregisterWebContents(wc);
      wc.close();
    }
  }

  updateNav() {
    const wc = this.wc;
    if (!wc) return;
    this.canGoBack = wc.navigationHistory.canGoBack();
    this.canGoForward = wc.navigationHistory.canGoForward();
  }

  countBlocked() {
    this.blocked += 1;
    this.browser.tabChangedSoon(this);
  }

  markFocusBlocked(url) {
    this.error = { type: 'focus', url, host: hostOf(url) };
    this.url = url;
    this.changed();
  }

  wire(wc) {
    this.browser.registerWebContents(wc, this);
    wc.setWindowOpenHandler((details) => this.browser.handleWindowOpen(this, details));
    wc.on('did-create-window', (popup) => {
      // Pop-ups (e.g. "Sign in with…") always show the real site in their title bar.
      popup.__tarunOpener = this.id;
      const label = () => {
        const pwc = popup.webContents;
        if (popup.isDestroyed() || pwc.isDestroyed()) return;
        const host = hostOf(pwc.getURL()) || 'about:blank';
        const secure = pwc.getURL().startsWith('https://') ? '🔒 ' : '⚠ Not secure · ';
        popup.setTitle(`${secure}${host}${pwc.getTitle() && pwc.getTitle() !== pwc.getURL() ? ' — ' + pwc.getTitle().slice(0, 80) : ''}`);
      };
      popup.on('page-title-updated', (e) => {
        e.preventDefault();
        label();
      });
      popup.webContents.on('did-navigate', label);
      popup.webContents.on('did-navigate-in-page', label);
      label();
    });

    wc.on('did-start-loading', () => {
      this.loading = true;
      this.changed();
    });
    wc.on('did-stop-loading', () => {
      this.loading = false;
      this.updateNav();
      this.changed();
    });
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.blocked = 0;
        this.browser.dropPromptsFor(wc.id); // a page that navigates away loses its pending requests
        if (this.error && this.error.type !== 'focus') this.error = null;
        if (this.zapping) this.zapping = false;
      }
    });
    wc.on('did-navigate', (_e, url) => {
      this.url = url;
      if (this.error && this.error.type === 'focus') this.error = null;
      this.error = null;
      if (this.httpsUpgrade && this.httpsUpgrade.to !== url) this.httpsUpgrade = null;
      this.updateNav();
      this.browser.recordHistory(this);
      this.changed();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = url;
      this.updateNav();
      this.browser.recordHistory(this);
      this.changed();
    });
    wc.on('page-title-updated', (_e, title) => {
      this.title = String(title || '').slice(0, 500);
      this.browser.updateHistoryTitle(this);
      this.changed();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      this.favicon = (favicons || []).map(safeFaviconUrl).find(Boolean) || '';
      this.changed();
    });
    wc.on('dom-ready', () => this.browser.applyZaps(this));
    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = aborted (user navigated away)
      if (this.error && this.error.type === 'focus') return;
      const up = this.httpsUpgrade;
      if (up && hostOf(validatedURL) === hostOf(up.to) && HTTPS_FALLBACK_ERRORS.has(code)) {
        this.error = { type: 'https', url: up.from, host: hostOf(up.from), code, description };
      } else if (code === -20) {
        this.error = { type: 'blocked', url: validatedURL, code, description };
      } else {
        this.error = { type: 'network', url: validatedURL, code, description: description || 'Unknown error' };
      }
      if (isWebUrl(validatedURL)) this.url = up && this.error.type === 'https' ? up.from : validatedURL;
      this.loading = false;
      this.changed();
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this.error = { type: 'crashed', url: this.url, description: details.reason };
      this.loading = false;
      this.changed();
    });
    wc.on('unresponsive', () => {
      this.error = { type: 'hung', url: this.url };
      this.changed();
    });
    wc.on('responsive', () => {
      if (this.error && this.error.type === 'hung') {
        this.error = null;
        this.changed();
      }
    });
    wc.on('audio-state-changed', (e) => {
      this.audible = !!e.audible;
      this.changed();
    });
    wc.on('found-in-page', (_e, result) => {
      if (!this.find) return;
      this.find = { ...this.find, active: result.activeMatchOrdinal || 0, matches: result.matches || 0 };
      this.changed();
    });
    wc.on('zoom-changed', (_e, direction) => {
      this.browser.zoom(this, direction === 'in' ? 0.5 : -0.5);
    });
    wc.on('enter-html-full-screen', () => {
      this.fullscreen = true;
      this.browser.setHtmlFullscreen(this, true);
    });
    wc.on('leave-html-full-screen', () => {
      this.fullscreen = false;
      this.browser.setHtmlFullscreen(this, false);
    });
    wc.on('focus', () => this.browser.tabFocused(this));
    wc.on('context-menu', (_e, params) => this.browser.showPageMenu(this, params));
    wc.on('before-input-event', (event, input) => this.browser.handleInput(event, input));
    wc.on('destroyed', () => {
      if (this.view && this.view.webContents === wc) {
        this.browser.detachView(this.view);
        this.view = null;
        this.loading = false;
        this.changed();
      }
    });
  }
}

function prettyTitle(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') || url;
  } catch {
    return url || 'New Tab';
  }
}

module.exports = { Tab, tabWebPreferences, prettyTitle };
