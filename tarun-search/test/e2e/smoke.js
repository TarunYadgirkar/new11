'use strict';
// End-to-end test: launches the real app (Electron) against a local test site
// and checks the main features plus the security guarantees.
//
//   npm run test:e2e            (needs a display; on Linux CI use xvfb-run)
//   SHOTS=dir npm run test:e2e  (also saves screenshots of the UI)

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright-core');
const { start } = require('./server');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;

async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t}ms)`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    throw err;
  }
}

async function launch(userData) {
  const args = ['.'];
  if (process.platform === 'linux') args.push('--no-sandbox'); // CI containers often lack user namespaces
  const app = await electron.launch({ cwd: ROOT, args, env: { ...process.env, TARUN_TEST: '1', TARUN_USER_DATA: userData } });
  app.process().stderr.on('data', (d) => {
    const s = String(d);
    if (process.env.VERBOSE && !/dbus|Fontconfig|Debugger|devtools|For help/.test(s)) process.stderr.write('[main] ' + s);
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => {
    throw new Error('UI error: ' + e.message);
  });
  await win.waitForSelector('#sidebar');
  return { app, win };
}

/** Run a function against the Browser object in the main process. */
const B = (app, fn, arg) => app.evaluate(({}, [src, a]) => new Function('b', 'arg', `return (${src})(b, arg)`)(global.__tarun, a), [fn.toString(), arg]);

async function waitFor(app, fn, arg, { timeout = 8000, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await B(app, fn, arg).catch((e) => e.message);
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/** Evaluate JS inside the tab whose URL ends with `suffix`. */
const inPage = (app, suffix, code, gesture = false) =>
  app.evaluate(
    async ({ webContents }, [suffix, code, gesture]) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith(suffix));
      if (!wc) throw new Error('no page ' + suffix);
      return wc.executeJavaScript(code, gesture);
    },
    [suffix, code, gesture],
  );

/** Real mouse click (OS-level input) inside a page. */
const clickInPage = async (app, suffix, selector, modifiers = []) => {
  const [x, y] = await inPage(app, suffix, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + 8, r.top + 8]; })()`);
  await app.evaluate(
    ({ webContents }, [suffix, x, y, modifiers]) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith(suffix));
      wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1, modifiers });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1, modifiers });
    },
    [suffix, x, y, modifiers],
  );
};

async function shot(app, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await sleep(350);
  // Capture the whole window including the web page views.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('tarun://'));
    const ui = await win.capturePage();
    return ui.toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(png, 'base64'));
}

(async () => {
  const { server, base } = await start();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tarun-e2e-'));
  console.log('Tarun Search end-to-end test');
  let { app, win } = await launch(userData);

  try {
    await step('first run shows the welcome tour, and Skip closes it', async () => {
      await win.waitForSelector('.onboard h1');
      await shot(app, 'onboarding');
      await win.getByRole('button', { name: 'Skip', exact: true }).click();
      await win.waitForSelector('.home-clock');
      await win.waitForSelector('#overlay-root', { state: 'hidden' });
    });

    await step('command bar opens a typed address in a new tab', async () => {
      await win.click('#btn-new-tab');
      await win.waitForSelector('.palette input');
      await win.keyboard.type(base + '/a');
      await win.keyboard.press('Enter');
      await waitFor(app, (b) => b.activeTab && b.activeTab.title === 'Page A', null, { label: 'Page A' });
      await win.waitForSelector('.tab.active .tab-title >> text=Page A');
      const visible = await B(app, (b) => b.activeTab.view.getVisible());
      assert.equal(visible, true);
      await shot(app, 'page-a');
    });

    await step('web pages get no Node.js, Electron or browser-internal APIs', async () => {
      const r = await inPage(app, '/a', 'JSON.stringify([typeof require, typeof process, typeof window.tarun, typeof module])');
      assert.equal(r, JSON.stringify(['undefined', 'undefined', 'undefined', 'undefined']));
      const sandboxed = await B(app, (b) => b.activeTab.wc.getLastWebPreferences());
      assert.equal(sandboxed.sandbox, true);
      assert.equal(sandboxed.contextIsolation, true);
      assert.equal(sandboxed.nodeIntegration, false);
    });

    await step('pages cannot navigate to file://, javascript: or the internal tarun:// UI', async () => {
      const before = await B(app, (b) => b.allTabs().length);
      await inPage(app, '/a', "location.href = 'file:///etc/hosts'; 1");
      await sleep(400);
      assert.ok((await B(app, (b) => b.activeTab.wc.getURL())).endsWith('/a'));
      await inPage(app, '/a', "window.open('file:///etc/hosts'); 1", true);
      await sleep(400);
      assert.equal(await B(app, (b) => b.allTabs().length), before);
      // Like Chrome, window.open('javascript:…') may only ever yield a sandboxed about:blank page.
      await inPage(app, '/a', "window.open('javascript:document.title=1'); 1", true);
      await sleep(400);
      const urls = await B(app, (b) => b.allTabs().map((t) => t.wc ? t.wc.getURL() : t.url));
      assert.ok(urls.every((u) => u === '' || /^(https?:|about:blank$)/.test(u)), urls.join(', '));
      await B(app, (b) => {
        for (const t of b.allTabs()) if (t.url === 'about:blank') b.closeTab(t.id);
        b.activateTab(b.activeSpace.tabs.find((t) => t.url.endsWith('/a')).id);
        return true;
      });
      const fetchUi = await inPage(app, '/a', "fetch('tarun://app/index.html').then(() => 'loaded', () => 'blocked')");
      assert.equal(fetchUi, 'blocked');
    });

    await step('window.open() opens a tab that keeps its opener (sign-in flows work)', async () => {
      await inPage(app, '/a', "window.open('/b'); 1", true);
      await waitFor(app, (b) => b.activeTab && b.activeTab.title === 'Page B opener=yes', null, { label: 'opener tab' });
    });

    await step('target=_blank links open a new tab next to the opener', async () => {
      await B(app, (b) => b.activateTab(b.activeSpace.tabs.find((t) => t.url.endsWith('/a')).id));
      const n = await B(app, (b) => b.activeSpace.tabs.length);
      await clickInPage(app, '/a', '#blank');
      await waitFor(app, (b, n) => b.activeSpace.tabs.length === n + 1 && b.activeTab.url.endsWith('/b'), n, { label: '_blank tab' });
    });

    await step('Shift-click opens Peek; it can be expanded into a tab', async () => {
      await B(app, (b) => b.activateTab(b.activeSpace.tabs.find((t) => t.url.endsWith('/a')).id));
      await clickInPage(app, '/a', '#same', ['shift']);
      await waitFor(app, (b) => b.peek && b.peek.url.endsWith('/c') && b.peek.view && b.peek.view.getVisible(), null, { label: 'peek visible' });
      await win.waitForSelector('.peek-frame');
      await shot(app, 'peek');
      const n = await B(app, (b) => b.activeSpace.tabs.length);
      await win.getByTitle(/Open as tab/).click();
      await waitFor(app, (b, n) => !b.peek && b.activeSpace.tabs.length === n + 1 && b.activeTab.url.endsWith('/c'), n, { label: 'peek expanded' });
      await win.waitForSelector('.peek-frame', { state: 'detached' });
    });

    await step('pop-up windows with a size open as real pop-ups', async () => {
      await B(app, (b) => b.activateTab(b.activeSpace.tabs.find((t) => t.url.endsWith('/a')).id));
      await clickInPage(app, '/a', '#popup');
      let count = 0;
      for (let i = 0; i < 50 && count < 2; i++) {
        count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
        await sleep(100);
      }
      assert.equal(count, 2);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.webContents.getURL().startsWith('tarun://')).forEach((w) => w.close()));
    });

    await step('⚡ Zap removes an element and it stays gone after reload', async () => {
      B(app, (b) => {
        b.startZap();
        return true;
      });
      await waitFor(app, (b) => b.activeTab.zapping, null, { label: 'zap mode' });
      await sleep(200);
      await clickInPage(app, '/a', '#banner');
      await waitFor(app, (b) => (b.data.zaps['127.0.0.1'] || []).length === 1, null, { label: 'zap saved' });
      await sleep(200);
      assert.equal(await inPage(app, '/a', "getComputedStyle(document.getElementById('banner')).display"), 'none');
      await B(app, (b) => b.activeTab.wc.reload());
      await sleep(900);
      assert.equal(await inPage(app, '/a', "getComputedStyle(document.getElementById('banner')).display"), 'none');
      assert.equal(await B(app, (b) => b.data.mysteries.zap), true);
    });

    await step('tracker requests are blocked and counted', async () => {
      await B(app, (b, url) => b.newTab(url), base + '/tracker');
      await waitFor(app, (b) => b.activeTab.url.endsWith('/tracker') && !b.activeTab.loading && b.activeTab.blocked >= 1, null, { label: 'blocked count' });
      await win.waitForSelector('.shield-btn .badge');
    });

    await step('🧘 Focus Flow puts distracting sites to sleep and wakes them up after', async () => {
      await B(app, (b) => {
        b.settings.focusBlocklist = ['127.0.0.1'];
        b.startFocus(25);
        return true;
      });
      await waitFor(app, (b) => b.activeTab.error && b.activeTab.error.type === 'focus' && !b.activeTab.view, null, { label: 'focus block' });
      await win.waitForSelector('.breath');
      await win.waitForSelector('.focus-card');
      await shot(app, 'focus');
      await B(app, (b, url) => b.newTab(url), base + '/c?focus');
      await waitFor(app, (b) => b.activeTab.error && b.activeTab.error.type === 'focus', null, { label: 'new nav blocked' });
      await win.getByRole('button', { name: 'End Focus Flow' }).click();
      await waitFor(app, (b) => !b.focus && !b.activeTab.error, null, { label: 'focus ended' });
      await B(app, (b) => {
        b.settings.focusBlocklist = [];
        return true;
      });
      await waitFor(app, (b) => b.activeTab.view && b.activeTab.view.getVisible(), null, { label: 'tab awake' });
    });

    await step('👻 Ghost Space has its own cookies and leaves no history', async () => {
      await B(app, (b) => {
        b.activateTab(b.activeSpace.tabs.find((t) => t.url.endsWith('/a')).id);
        return true;
      });
      await waitFor(app, (b) => b.activeTab.wc && !b.activeTab.loading && b.activeTab.wc.getURL().endsWith('/a'), null, { label: 'tab a awake' });
      await inPage(app, '/a', "document.cookie = 'who=normal; path=/'; document.cookie");
      await B(app, (b) => {
        b.newSpace({ ghost: true });
        return true;
      });
      await win.waitForSelector('.ghost-pill');
      await B(app, (b, url) => b.newTab(url), base + '/c?ghost-visit');
      await waitFor(app, (b) => b.activeTab.title === 'Page C' && !b.activeTab.loading, null, { label: 'ghost page' });
      assert.equal(await inPage(app, '/c?ghost-visit', 'document.cookie'), '');
      assert.equal(await B(app, (b) => b.data.history.some((h) => h.url.includes('ghost-visit'))), false);
      await shot(app, 'ghost');
      await B(app, (b) => {
        b.deleteSpace(b.activeSpaceId);
        return true;
      });
      await waitFor(app, (b) => !b.spaces.some((s) => s.ghost), null, { label: 'ghost closed' });
    });

    await step('pin, favorite and split view', async () => {
      await B(app, (b) => {
        const a = b.activeSpace.tabs.find((t) => t.url.endsWith('/a'));
        b.activateTab(a.id);
        b.togglePin(a.id);
        const c = b.activeSpace.tabs.find((t) => t.url.endsWith('/c'));
        b.moveTab(c.id, { kind: 'favorite' });
        return true;
      });
      await waitFor(app, (b) => b.activeSpace.pinned.length === 1 && b.favorites.length === 1, null, { label: 'pinned+fav' });
      await win.waitForSelector('#pinned .tab');
      await win.waitForSelector('#favorites .fav');
      await B(app, (b) => {
        b.openSplit(b.activeSpace.tabs[0].id);
        return true;
      });
      await waitFor(app, (b) => b.splitShown() && b.findTab(b.split.a).view.getVisible() && b.findTab(b.split.b).view.getVisible(), null, { label: 'split' });
      await win.waitForSelector('#pane-split:not([hidden])');
      await shot(app, 'split');
      await B(app, (b) => {
        b.closeSplit();
        return true;
      });
    });

    await step('command bar finds actions (type "split")', async () => {
      await B(app, (b) => {
        b.runCommand('new-tab');
        return true;
      });
      await win.waitForSelector('.palette input');
      await win.keyboard.type('split');
      await win.waitForSelector('.p-item >> text=Split View');
      await shot(app, 'palette');
      await win.keyboard.press('Escape');
      await win.waitForSelector('#overlay-root', { state: 'hidden' });
    });

    await step('settings, library and dark theme render', async () => {
      await win.click('#btn-settings');
      await win.waitForSelector('.settings-nav');
      await win.getByRole('button', { name: 'Privacy & Security' }).click();
      await win.waitForSelector('text=HTTPS-First');
      await shot(app, 'settings');
      await win.keyboard.press('Escape');
      await win.click('#btn-library');
      await win.waitForSelector('.list-item');
      await win.keyboard.press('Escape');
      await B(app, (b) => {
        b.setSetting('theme', 'dark');
        return true;
      });
      await win.waitForFunction(() => document.documentElement.classList.contains('dark'));
      await shot(app, 'dark');
    });

    await step('keyboard shortcuts work while a web page has focus', async () => {
      if (process.platform === 'darwin') return; // macOS uses native menu accelerators
      await B(app, (b) => {
        b.activateTab(b.allTabs().find((t) => t.url.endsWith('/c')).id);
        return true;
      });
      await waitFor(app, (b) => b.activeTab.wc && b.activeTab.view.getVisible() && !b.activeTab.loading, null, { label: 'page shown' });
      await app.evaluate(({ webContents }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/c'));
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] });
      });
      await win.waitForSelector('.palette input');
      await win.keyboard.press('Escape');
      await win.waitForSelector('#overlay-root', { state: 'hidden' });
      // Plain typing must reach the page, not the browser.
      const before = await B(app, (b) => b.allTabs().length);
      await app.evaluate(({ webContents }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/c'));
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
        wc.sendInputEvent({ type: 'char', keyCode: 'w' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
      });
      await sleep(200);
      assert.equal(await B(app, (b) => b.allTabs().length), before);
    });

    await step('friendly error page when a site cannot be reached', async () => {
      await B(app, (b) => {
        b.newTab('http://127.0.0.1:9/');
        return true;
      });
      await waitFor(app, (b) => b.activeTab.error && b.activeTab.error.type === 'network', null, { label: 'network error' });
      await win.waitForSelector('.err h2');
      assert.equal(await B(app, (b) => !b.activeTab.view || !b.activeTab.view.getVisible()), true);
      await shot(app, 'error');
      await B(app, (b) => {
        b.closeTab(b.activeTabId);
        return true;
      });
    });

    await step('permission requests ask first, and "Block" denies', async () => {
      await B(app, (b, url) => b.newTab(url), base + '/geo');
      await waitFor(app, (b) => b.activeTab.title === 'Geo' && !b.activeTab.loading, null, { label: 'geo page' });
      const answer = inPage(app, '/geo', 'window.ask()', true);
      await win.waitForSelector('.prompt');
      await shot(app, 'permission');
      await win.locator('.prompt').getByRole('button', { name: 'Block' }).click();
      assert.match(await answer, /^denied/);
      assert.equal(await B(app, (b) => b.data.permissions[new URL(b.activeTab.url).origin].geolocation), 'deny');
      // Remembered: the second request is denied without asking.
      assert.match(await inPage(app, '/geo', 'window.ask()', true), /^denied/);
      assert.equal(await win.locator('.prompt').count(), 0);
    });

    await step('downloads save to the Downloads folder and show progress', async () => {
      await B(app, (b, url) => b.activeTab.wc.downloadURL(url), base + '/download');
      await waitFor(app, (b) => b.downloads.some((d) => d.state === 'completed'), null, { label: 'download done' });
      const file = await B(app, (b) => b.downloads.find((d) => d.state === 'completed').path);
      assert.equal(fs.readFileSync(file, 'utf8'), 'hello from tarun search');
      await win.waitForSelector('.dl-name >> text=notes.txt');
    });

    await step('the UI rejects malformed IPC messages without crashing', async () => {
      await win.evaluate(() => {
        tarun.send('tab:activate', { id: '../../etc/passwd' });
        tarun.send('tab:new', { input: 42 });
        tarun.send('layout:set', { main: { x: 'a' } });
        tarun.send('settings:set', { key: '__proto__', value: { polluted: true } });
        tarun.send('nope', {});
      });
      await sleep(300);
      assert.equal(await B(app, (b) => ({}).polluted === undefined && b.allTabs().length > 0), true);
      const denied = await win.evaluate(() => tarun.query('not-a-query').then(() => 'ok', () => 'denied'));
      assert.equal(denied, 'denied');
    });

    await step('everything is restored after a restart', async () => {
      await app.close();
      ({ app, win } = await launch(userData));
      await waitFor(app, (b) => b.favorites.length === 1 && b.spaces[0].pinned.length === 1, null, { label: 'restored' });
      assert.equal(await win.locator('.onboard').count(), 0);
      assert.equal(await B(app, (b) => (b.data.zaps['127.0.0.1'] || []).length), 1);
      assert.equal(await B(app, (b) => b.settings.theme), 'dark');
      await win.waitForSelector('#favorites .fav');
      await shot(app, 'restored');
    });

    console.log(`\n${passed} checks passed.`);
  } finally {
    await app.close().catch(() => {});
    server.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});
