'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { app, protocol, session } = require('electron');
const { Store } = require('./store');
const { Browser } = require('./browser');
const { registerIpc } = require('./ipc');
const { buildAppMenu } = require('./menus');
const { isAllowedNavigation, isWebUrl } = require('./url');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// ---- Process-wide hardening (must run before "ready") -----------------------
// Sandbox every renderer. (Only skipped when the OS sandbox is explicitly turned
// off with --no-sandbox, e.g. automated tests running as root in a container.)
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
app.setName('Tarun Search');

// A plain Chrome user agent: some sites refuse to work with "Electron" in it.
const chromeVersion = process.versions.chrome.split('.')[0];
const platformToken =
  process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
app.userAgentFallback = `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`;

protocol.registerSchemesAsPrivileged([{ scheme: 'tarun', privileges: { standard: true, secure: true } }]);

if (process.env.TARUN_USER_DATA) app.setPath('userData', path.resolve(process.env.TARUN_USER_DATA));
if (process.env.TARUN_TEST === '1' && process.env.TARUN_USER_DATA) app.setPath('downloads', path.join(path.resolve(process.env.TARUN_USER_DATA), 'downloads'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let browser = null;
  const pendingUrls = [];
  const urlsFromArgv = (argv) => argv.slice(1).filter((a) => isWebUrl(a));
  pendingUrls.push(...urlsFromArgv(process.argv));

  app.on('second-instance', (_e, argv) => {
    const urls = urlsFromArgv(argv);
    if (browser) {
      if (urls.length) browser.openUrlsFromOs(urls);
      else browser.showWindow();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (!isWebUrl(url)) return;
    if (browser && browser.win) browser.openUrlsFromOs([url]);
    else pendingUrls.push(url);
  });

  // Every web contents ever created (tabs, popups, the UI) gets these guards.
  app.on('web-contents-created', (_e, wc) => {
    const isUi = () => wc.getType() === 'window' && browser && browser.win && wc === browser.win.webContents;
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('will-navigate', (event, url) => {
      const target = event.url || url;
      if (isUi() || !isAllowedNavigation(target)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => {
      const target = event.url || url;
      if (!isUi() && !isAllowedNavigation(target)) event.preventDefault();
    });
    // Tabs install their own handler; anything else (popups) opens links as tabs.
    wc.setWindowOpenHandler(({ url }) => {
      if (browser && isWebUrl(url) && !isUi()) setImmediate(() => browser.newTab(url));
      return { action: 'deny' };
    });
  });

  app.whenReady().then(async () => {
    // The UI is served from a private scheme on the default session. Website tabs
    // use a different session, so pages can never fetch tarun:// files.
    const ui = session.defaultSession;
    ui.protocol.handle('tarun', async (request) => {
      try {
        const url = new URL(request.url);
        if (url.host !== 'app') return new Response('Not found', { status: 404 });
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        const file = path.normalize(path.join(RENDERER_DIR, rel));
        if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
        const type = MIME[path.extname(file)];
        if (!type) return new Response('Not found', { status: 404 });
        const body = await fs.readFile(file);
        return new Response(body, {
          headers: { 'content-type': type, 'content-security-policy': UI_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    ui.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
    ui.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
    // The UI session only ever loads its own files plus https favicons — no cookies either way.
    ui.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
      cb({ cancel: !(details.resourceType === 'image' && details.url.startsWith('https://')) });
    });
    ui.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, cb) => {
      const headers = { ...details.requestHeaders };
      delete headers.Cookie;
      cb({ requestHeaders: headers });
    });
    ui.webRequest.onHeadersReceived({ urls: ['https://*/*'] }, (details, cb) => {
      const headers = { ...details.responseHeaders };
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'set-cookie') delete headers[k];
      cb({ responseHeaders: headers });
    });

    const store = new Store(app.getPath('userData'));
    browser = new Browser(store);
    if (process.env.TARUN_TEST === '1') global.__tarun = browser; // lets the e2e test inspect state
    registerIpc(browser);
    buildAppMenu(browser);
    browser.start();
    if (pendingUrls.length) browser.win.webContents.once('did-finish-load', () => browser.openUrlsFromOs(pendingUrls.splice(0)));

    app.on('activate', () => browser.showWindow());
  });

  app.on('before-quit', () => {
    if (browser) browser.shutdown();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || (browser && browser.quitting)) app.quit();
  });
}
