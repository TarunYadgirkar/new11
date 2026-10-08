'use strict';
/* global UI, tarun */
(function () {
  const { h, icon, setIcon, favicon, hostOf, formatBytes, timeAgo, displayUrl } = UI;
  const $ = (id) => document.getElementById(id);
  const send = (name, payload) => tarun.send(name, payload);
  const query = (name, payload) => tarun.query(name, payload);
  const IS_MAC = tarun.platform === 'darwin';
  const MOD = IS_MAC ? '⌘' : 'Ctrl+';
  const SHIFT = IS_MAC ? '⇧' : 'Shift+';
  const ALT = IS_MAC ? '⌥' : 'Alt+';
  const TAB_MIME = 'application/x-tarun-tab';

  let S = null; // latest state from the main process
  let overlay = null; // { kind, close }
  let overlayOpening = false;
  let peekShown = false;
  let findOpen = false;
  let dragging = false;
  let sidebarPeek = false;
  let lastLayout = '';
  let stageKey = '';
  let lastFindTab = null;
  let peekCapturing = false;
  let onboardingDone = false;
  let probeCtx = null;

  document.body.classList.add('platform-' + tarun.platform);
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  // =========================================================== helpers
  const activeSpace = () => (S ? S.spaces.find((s) => s.id === S.activeSpaceId) || S.spaces[0] : null);
  const allTabs = () => (S ? [...S.favorites, ...S.spaces.flatMap((s) => [...s.pinned, ...s.tabs])] : []);
  const tabById = (id) => (id && S ? (S.peek && S.peek.id === id ? S.peek : allTabs().find((t) => t.id === id)) : null);
  const activeTab = () => (S ? tabById(S.activeTabId) : null);
  const kbd = (text) => h('span', { class: 'kbd', text });
  const engineName = () => (S ? S.engines[S.settings.searchEngine] : 'the web');

  function looksLikeUrl(text) {
    const t = text.trim();
    if (!t || /\s/.test(t)) return false;
    if (/^https?:\/\//i.test(t)) return true;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(t)) return true;
    return /^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t);
  }

  // =========================================================== state
  tarun.on('state', (state) => {
    const prevActive = S && S.activeTabId;
    S = state;
    if (findOpen && prevActive !== S.activeTabId) closeFind(false);
    render();
  });

  tarun.on('event', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'toast') return toast(ev.text, ev.action ? { label: ev.action, run: () => send(ev.command, ev.payload) } : null);
    if (ev.type === 'command') return runUiCommand(ev.id, ev);
  });

  function runUiCommand(id, ev = {}) {
    switch (id) {
      case 'new-tab':
        return openPalette('new');
      case 'open-location':
        return openPalette(activeTab() ? 'edit' : 'new');
      case 'new-space':
        return openSpaceEditor();
      case 'edit-space':
        return openSpaceEditor(ev.spaceId);
      case 'delete-space':
        return deleteSpace(ev.spaceId);
      case 'find':
        return openFind();
      case 'toggle-sidebar':
        return toggleSidebar();
      case 'settings':
        return openSettings();
      case 'history':
        return openLibrary();
      case 'split':
        if (S && S.split) return send('split:close');
        if (activeTab()) return openPalette('split');
        return toast('Open a page first, then split the view.');
      case 'focus':
        return openFocusDialog();
      case 'about':
        return openSettings('about');
    }
  }

  // =========================================================== render
  function render() {
    if (!S) return;
    const space = activeSpace();
    const b = document.body;
    const root = document.documentElement;
    const theme = S.settings.theme;
    root.classList.toggle('dark', theme === 'dark' || (theme === 'system' && darkQuery.matches));
    root.classList.toggle('ghost', !!space.ghost);
    b.classList.toggle('collapsed', !!S.settings.sidebarCollapsed);
    b.classList.toggle('sidebar-peek', !!S.settings.sidebarCollapsed && (sidebarPeek || S.prompts.length > 0));
    b.classList.toggle('html-fullscreen', !!S.htmlFullscreen);
    b.classList.toggle('find-open', findOpen);
    root.style.setProperty('--space', space.ghost ? '#8b85a8' : space.color);
    b.style.setProperty('--sidebar-w', S.settings.sidebarWidth + 'px');

    if (!dragging) renderSidebar(space);
    renderDock();
    renderStage();
    renderPeek();
    renderFindCount();
    syncChrome();
    if (!S.settings.onboarded && !onboardingDone && !overlay && !overlayOpening) openOnboarding();
    queueLayout();
  }

  function renderSidebar(space) {
    const tab = activeTab();
    const nav = tab || null;
    setIcon($('btn-sidebar'), 'sidebar');
    setIcon($('btn-sidebar-2'), 'sidebar');
    setIcon($('btn-back'), 'back');
    setIcon($('btn-forward'), 'forward');
    setIcon($('btn-reload'), nav && nav.loading ? 'stop' : 'reload');
    $('btn-back').disabled = !(nav && nav.canGoBack);
    $('btn-forward').disabled = !(nav && nav.canGoForward);
    $('btn-reload').disabled = !nav;
    $('btn-reload').title = nav && nav.loading ? 'Stop' : 'Reload';
    setIcon($('btn-library'), 'library');
    setIcon($('btn-new-space'), 'plus');
    setIcon($('btn-settings'), 'settings');

    // URL bar
    const urlText = $('url-text');
    const urlIcon = $('url-icon');
    const actions = $('url-actions');
    actions.replaceChildren();
    if (tab && tab.url) {
      urlText.textContent = displayUrl(tab.url);
      urlText.classList.remove('placeholder');
      const secure = tab.secure;
      urlIcon.className = 'url-icon' + (secure ? '' : ' insecure');
      urlIcon.title = secure ? 'Connection is secure' : 'Not secure — this page does not use HTTPS';
      setIcon(urlIcon, secure ? 'lock' : 'warn', 14);
      const site = hostOf(tab.url);
      const shieldsDown = S.settings.shieldsDownSites.some((d) => site === d || site.endsWith('.' + d));
      if (S.settings.blockTrackers) {
        const sb = h('button', {
          class: 'icon-btn shield-btn',
          title: shieldsDown ? 'Tracker blocking is paused here — click to resume' : `${tab.blocked} trackers blocked — click to pause on this site`,
          onclick: (e) => {
            e.stopPropagation();
            send('tab:shields');
          },
        }, icon(shieldsDown ? 'shieldOff' : 'shield', 15));
        if (!shieldsDown && tab.blocked > 0) sb.append(h('span', { class: 'badge', text: tab.blocked > 99 ? '99+' : String(tab.blocked) }));
        actions.append(sb);
      }
      actions.append(
        h('button', { class: 'icon-btn', title: `Zap an element (${MOD}${SHIFT}X)`, onclick: (e) => (e.stopPropagation(), send('zap:start')) }, icon('zap', 15)),
        h('button', { class: 'icon-btn', title: `Copy link (${MOD}${SHIFT}C)`, onclick: (e) => (e.stopPropagation(), send('tab:copy-url')) }, icon('copy', 15)),
      );
    } else {
      urlText.textContent = 'Search or enter address';
      urlText.classList.add('placeholder');
      urlIcon.className = 'url-icon';
      urlIcon.title = '';
      setIcon(urlIcon, 'search', 14);
    }

    // Favorites
    const favs = $('favorites');
    favs.replaceChildren(
      ...S.favorites.map((t) =>
        h(
          'div',
          {
            class: `fav${t.id === S.activeTabId ? ' active' : ''}${t.sleeping ? '' : ' loaded'}`,
            title: `${t.title}\n${displayUrl(t.url)}`,
            draggable: 'true',
            dataset: { id: t.id },
            onclick: () => send('tab:activate', { id: t.id }),
            onauxclick: (e) => e.button === 1 && send('tab:close', { id: t.id }),
            oncontextmenu: (e) => (e.preventDefault(), send('tab:menu', { id: t.id })),
          },
          favicon(t.url, t.favicon, 20),
        ),
      ),
    );

    // Space title
    const st = $('space-title');
    st.replaceChildren(
      ...[
        h('span', { class: 'st-emoji', text: space.emoji }),
        h('span', { class: 'st-name', text: space.name }),
        space.ghost ? h('span', { class: 'ghost-pill', text: 'Ghost · not saved' }) : null,
      ].filter(Boolean),
    );
    st.oncontextmenu = (e) => (e.preventDefault(), send('space:menu', { id: space.id }));
    st.ondblclick = () => !space.ghost && openSpaceEditor(space.id);
    st.title = space.ghost ? 'Ghost Space: nothing here is saved. Right-click to close it.' : 'Double-click to edit · right-click for options';

    $('pinned').replaceChildren(...space.pinned.map((t) => tabRow(t)));
    $('tabs').replaceChildren(...space.tabs.map((t) => tabRow(t)));
    $('btn-clear-today').hidden = space.tabs.length === 0;
    $('btn-new-tab').querySelector('.nt-plus').replaceChildren(icon('plus', 15));
    $('btn-new-tab').title = `New tab (${MOD}T)`;

    // Space dots
    $('space-dots').replaceChildren(
      ...S.spaces.map((s, i) =>
        h('button', {
          class: `space-dot${s.id === S.activeSpaceId ? ' active' : ''}`,
          text: s.emoji,
          title: `${s.name}${s.ghost ? ' (Ghost)' : ''} — ${MOD}${ALT}←/→ to switch`,
          dataset: { space: s.id, index: String(i) },
          onclick: () => send('space:switch', { id: s.id }),
          oncontextmenu: (e) => (e.preventDefault(), send('space:menu', { id: s.id })),
        }),
      ),
    );
  }

  function tabRow(t) {
    const pinnedLike = t.kind === 'pinned';
    const inSplit = S.splitPair && (S.splitPair.a === t.id || S.splitPair.b === t.id);
    const row = h(
      'div',
      {
        class: [
          'tab',
          t.id === S.activeTabId ? 'active' : '',
          t.loading ? 'loading' : '',
          t.sleeping ? 'sleeping' : '',
          t.error && t.error.type !== 'focus' ? 'error' : '',
          t.changedFromHome ? 'pinned-changed' : '',
        ].join(' '),
        title: `${t.title}\n${displayUrl(t.url)}`,
        draggable: 'true',
        dataset: { id: t.id },
        onclick: () => send('tab:activate', { id: t.id }),
        onauxclick: (e) => e.button === 1 && send('tab:close', { id: t.id }),
        oncontextmenu: (e) => (e.preventDefault(), send('tab:menu', { id: t.id })),
      },
      h('span', { class: 'tab-icon' }, favicon(t.url, t.favicon, 16)),
      h('span', { class: 'tab-title', text: t.title || displayUrl(t.url) }),
    );
    if (inSplit) row.append(h('span', { class: 'split-mark', title: 'In split view' }, icon('split', 13)));
    if (t.audible || t.muted) {
      row.append(
        h('button', {
          class: 'icon-btn tab-audio',
          title: t.muted ? 'Unmute' : 'Mute',
          onclick: (e) => (e.stopPropagation(), send('tab:mute', { id: t.id, muted: !t.muted })),
        }, icon(t.muted ? 'mute' : 'volume', 13)),
      );
    }
    if (!(pinnedLike && t.sleeping)) {
      row.append(
        h(
          'button',
          {
            class: 'icon-btn tab-close',
            title: pinnedLike ? 'Unload (stays pinned)' : `Close (${MOD}W)`,
            onclick: (e) => (e.stopPropagation(), send('tab:close', { id: t.id })),
          },
          pinnedLike ? h('span', { text: '—', style: { fontWeight: '700', fontSize: '12px' } }) : icon('close', 13),
        ),
      );
    }
    return row;
  }

  // =========================================================== dock: prompts, focus, downloads, toasts
  const PERM_TEXT = {
    media: (d) => [`use your ${d || 'camera & microphone'}`, 'video'],
    geolocation: () => ['know your location', 'globe'],
    notifications: () => ['show notifications', 'info'],
    'clipboard-read': () => ['read your clipboard', 'copy'],
    midi: () => ['use MIDI devices', 'keyboard'],
    openExternal: (d) => [`open a “${d}” link in another app`, 'external'],
  };

  function renderDock() {
    const prompts = $('prompts');
    prompts.replaceChildren(
      ...S.prompts.map((p) => {
        const [what, ic] = (PERM_TEXT[p.permission] || (() => [p.permission, 'info']))(p.detail);
        const remember = h('input', { type: 'checkbox', checked: true });
        return h(
          'div',
          { class: 'card prompt' },
          h('div', { class: 'prompt-title' }, icon(ic === 'video' ? 'monitor' : ic, 16), h('span', {}, h('span', { class: 'origin', text: hostOf(p.origin) || p.origin }), ` wants to ${what}`)),
          p.tabTitle ? h('div', { class: 'prompt-sub', text: `From “${p.tabTitle.slice(0, 60)}”` }) : h('div', { class: 'prompt-sub', text: ' ' }),
          h(
            'div',
            { class: 'prompt-actions' },
            h('button', { class: 'btn', text: 'Block', onclick: () => send('prompt:answer', { id: p.id, allow: false, remember: p.remember && remember.checked }) }),
            h('button', { class: 'btn primary', text: 'Allow', onclick: () => send('prompt:answer', { id: p.id, allow: true, remember: p.remember && remember.checked }) }),
            p.remember ? h('label', { class: 'check' }, remember, 'Remember') : null,
          ),
        );
      }),
    );

    renderFocusChip();

    const dl = $('downloads');
    const visible = S.downloads.slice(-3).reverse();
    dl.replaceChildren(
      ...visible.map((d) => {
        const pct = d.total > 0 ? Math.min(100, (d.received / d.total) * 100) : d.state === 'completed' ? 100 : 30;
        const sub =
          d.state === 'completed'
            ? `Done · ${formatBytes(d.received)}`
            : d.state === 'progressing'
              ? `${formatBytes(d.received)}${d.total ? ' of ' + formatBytes(d.total) : ''}`
              : d.state === 'cancelled'
                ? 'Cancelled'
                : d.state === 'paused'
                  ? 'Paused'
                  : 'Failed';
        return h(
          'div',
          { class: 'card dl' },
          h('span', { style: { color: 'var(--muted)', display: 'grid' } }, icon('download', 16)),
          h(
            'div',
            { class: 'dl-main' },
            h('div', { class: 'dl-name', text: d.filename, title: d.filename }),
            h('div', { class: 'dl-sub', text: sub + (d.risky && d.state === 'completed' ? ' · app/installer — open with care' : '') }),
            d.state === 'progressing' || d.state === 'paused' ? h('div', { class: 'progress' }, h('i', { style: { width: pct + '%' } })) : null,
          ),
          d.state === 'progressing'
            ? h('button', { class: 'icon-btn small', title: 'Cancel', onclick: () => send('download:action', { id: d.id, action: 'cancel' }) }, icon('close', 13))
            : d.state === 'completed'
              ? h('button', { class: 'icon-btn small', title: d.risky ? 'Show in folder' : 'Open', onclick: () => send('download:action', { id: d.id, action: 'open' }) }, icon(d.risky ? 'folder' : 'external', 13))
              : null,
          d.state !== 'progressing'
            ? h('button', { class: 'icon-btn small', title: 'Dismiss', onclick: () => send('download:action', { id: d.id, action: 'clear' }) }, icon('close', 13))
            : null,
        );
      }),
    );
  }

  let focusTick = null;
  function renderFocusChip() {
    const chip = $('focus-chip');
    clearInterval(focusTick);
    if (!S.focus) return chip.replaceChildren();
    const R = 13;
    const C = 2 * Math.PI * R;
    const draw = () => {
      const f = S.focus;
      if (!f) return;
      const left = Math.max(0, f.endsAt - Date.now());
      const total = f.endsAt - f.startedAt;
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 34 34');
      svg.setAttribute('class', 'ring');
      const track = document.createElementNS(svg.namespaceURI, 'circle');
      const fill = document.createElementNS(svg.namespaceURI, 'circle');
      for (const c of [track, fill]) {
        c.setAttribute('cx', '17');
        c.setAttribute('cy', '17');
        c.setAttribute('r', String(R));
      }
      track.setAttribute('class', 'track');
      fill.setAttribute('class', 'fill');
      fill.setAttribute('stroke-dasharray', String(C));
      fill.setAttribute('stroke-dashoffset', String(C * (1 - left / total)));
      svg.append(track, fill);
      chip.replaceChildren(
        h(
          'div',
          { class: 'card focus-card' },
          svg,
          h('div', { class: 'grow' }, h('div', { class: 'focus-time', text: `${m}:${String(s).padStart(2, '0')}` }), h('div', { class: 'focus-sub', text: 'Focus Flow · distractions asleep' })),
          h('button', { class: 'btn', text: 'End', onclick: () => send('focus:stop') }),
        ),
      );
    };
    draw();
    focusTick = setInterval(draw, 1000);
  }

  function toast(text, action) {
    const box = $('toasts');
    const el = h(
      'div',
      { class: 'card toast' },
      h('span', { class: 'toast-text', text }),
      action ? h('button', { class: 'btn', text: action.label, onclick: () => (action.run(), dismiss()) }) : null,
    );
    const dismiss = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };
    box.append(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(dismiss, action ? 6000 : 3500);
  }

  // =========================================================== stage (home / error / split)
  function renderStage() {
    const tab = activeTab();
    const space = activeSpace();
    const split = S.split;
    $('title-text').textContent = tab ? tab.title : space.ghost ? 'Ghost Space' : 'Tarun Search';
    document.title = tab && tab.title ? `${tab.title} — Tarun Search` : 'Tarun Search';

    const paneMain = $('pane-main');
    const paneSplit = $('pane-split');
    paneSplit.hidden = !split;
    const tools = $('split-tools');
    tools.hidden = !split;
    if (split) {
      tools.replaceChildren(
        h('button', { class: 'icon-btn small', title: 'Swap sides', onclick: () => send('split:swap') }, icon('swap', 13)),
        h('button', { class: 'icon-btn small', title: 'Close split view', onclick: () => send('split:close') }, icon('close', 13)),
      );
    }
    paneMain.classList.toggle('focused-pane', !!split && S.activeTabId === split.a);
    paneSplit.classList.toggle('focused-pane', !!split && S.activeTabId === split.b);

    const mainTab = split ? tabById(split.a) : tab;
    const key = JSON.stringify([
      mainTab ? [mainTab.id, mainTab.error] : ['home', space.id, space.ghost, S.mysteries, S.topSites.map((s) => s.url)],
      split ? [tabById(split.b) && tabById(split.b).id, tabById(split.b) && tabById(split.b).error] : null,
      S.focus && S.focus.endsAt,
    ]);
    if (key === stageKey) return;
    stageKey = key;
    paneMain.replaceChildren(mainTab ? (mainTab.error ? errorPage(mainTab) : '') : homePage(space));
    if (split) {
      const b = tabById(split.b);
      paneSplit.replaceChildren(b && b.error ? errorPage(b) : '');
    }
  }

  let clockTimer = null;
  function homePage(space) {
    const clock = h('div', { class: 'home-clock' });
    const greet = h('div', { class: 'home-greet' });
    const tick = () => {
      const d = new Date();
      clock.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const hr = d.getHours();
      const part = hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
      greet.textContent = space.ghost ? '👻 Ghost Space — nothing you do here is saved. Close the space and it all disappears.' : `${part}. Where to next?`;
    };
    tick();
    clearInterval(clockTimer);
    clockTimer = setInterval(tick, 10000);

    const wrap = h(
      'div',
      { class: 'page-wrap' },
      clock,
      greet,
      h('button', { class: 'home-search', onclick: () => openPalette('new') }, icon('search', 18), h('span', { text: `Search ${engineName()} or type a URL` }), kbd(`${MOD}T`)),
    );
    if (S.topSites.length && !space.ghost) {
      wrap.append(
        h(
          'div',
          { class: 'home-section' },
          h('div', { class: 'home-h', text: 'Jump back in' }),
          h('div', { class: 'sites' }, ...S.topSites.map((s) => h('button', { class: 'site', title: s.url, onclick: () => send('tab:new', { input: s.url }) }, favicon(s.url, '', 18), h('span', { text: s.title })))),
        ),
      );
    }
    wrap.append(
      h(
        'div',
        { class: 'home-section' },
        h('div', { class: 'home-h' }, icon('gift', 13), `3 mysteries · ${['ghost', 'zap', 'focus'].filter((k) => S.mysteries[k]).length} found`),
        h('div', { class: 'mysteries' }, ...MYSTERIES.map(mysteryCard)),
      ),
      h('div', { class: 'tip' }, icon('sparkles', 13), h('span', { text: TIPS[Math.floor(Math.random() * TIPS.length)] })),
    );
    return wrap;
  }

  const TIPS = [
    `Press ${MOD}T anywhere to search, open tabs, or run any command.`,
    `${MOD}S hides the sidebar for a distraction-free view.`,
    'Drag a tab up into Pinned or Favorites to keep it around.',
    `Shift-click a link to open it in Peek — a quick floating preview.`,
    'Swipe sideways on the sidebar to hop between spaces.',
    `${MOD}${SHIFT}E puts two pages side by side.`,
    "Today's tabs tidy themselves away into the Archive after 12 hours — change it in Settings.",
    'Right-click a tab to move it to another space.',
  ];

  const MYSTERIES = [
    {
      key: 'ghost',
      emoji: '👻',
      riddle: 'Some rooms forget you the moment you leave. Want one?',
      title: 'Ghost Space',
      desc: 'A whole private space. Its cookies, logins, history and tabs vanish the instant you close it — while your other spaces stay untouched.',
      shortcut: `${MOD}${SHIFT}B`,
      tryIt: () => send('space:new', { ghost: true }),
    },
    {
      key: 'zap',
      emoji: '⚡',
      riddle: 'That cookie banner. That sticky video. What if you could just… delete it?',
      title: 'Zap',
      desc: 'Click any element on any website to make it disappear. Tarun Search remembers, so it stays gone every time you visit.',
      shortcut: `${MOD}${SHIFT}X`,
      tryIt: () => (activeTab() ? send('zap:start') : toast(`Open any website, then press ${MOD}${SHIFT}X to zap.`)),
    },
    {
      key: 'focus',
      emoji: '🧘',
      riddle: 'The internet is loud. What if it could go quiet on command?',
      title: 'Focus Flow',
      desc: 'A focus timer that puts YouTube, social feeds and other time-sinks to sleep until you are done. Pick your own list in Settings.',
      shortcut: `${MOD}${SHIFT}F`,
      tryIt: () => openFocusDialog(),
    },
  ];

  function mysteryCard(m) {
    const revealed = !!S.mysteries[m.key];
    const card = h(
      'div',
      { class: 'mystery' + (revealed ? ' revealed' : '') },
      h(
        'div',
        { class: 'mystery-inner' },
        h(
          'div',
          {
            class: 'm-face m-front',
            role: 'button',
            tabindex: '0',
            title: 'Click to reveal',
            onclick: () => {
              card.classList.add('revealed');
              setTimeout(() => send('mystery:reveal', { key: m.key }), 650);
            },
          },
          h('div', { class: 'm-q', text: '?' }),
          h('div', { class: 'm-riddle', text: m.riddle }),
          h('div', { class: 'm-tap', text: 'Tap to reveal' }),
        ),
        h(
          'div',
          { class: 'm-face m-back' },
          h('div', { class: 'm-title' }, h('span', { text: m.emoji }), h('span', { text: m.title })),
          h('div', { class: 'm-desc', text: m.desc }),
          h('div', { class: 'm-actions' }, h('button', { class: 'btn primary', text: 'Try it', onclick: m.tryIt }), kbd(m.shortcut)),
        ),
      ),
    );
    return card;
  }

  const NET_ERRORS = {
    '-105': ["Couldn't find this site", (h) => `We couldn't find ${h}. Check the address for typos, or search for it instead.`],
    '-137': ["Couldn't find this site", (h) => `We couldn't find ${h}. Check the address for typos, or search for it instead.`],
    '-106': ["You're offline", () => 'Check your Wi-Fi or network cable, then try again.'],
    '-21': ['Your network changed', () => 'The connection was interrupted by a network change. Try again.'],
    '-102': ['This site refused to connect', (h) => `${h} is not accepting connections right now.`],
    '-118': ['This site took too long to respond', (h) => `${h} might be busy or down. Try again in a moment.`],
    '-7': ['This site took too long to respond', (h) => `${h} might be busy or down. Try again in a moment.`],
    '-101': ['The connection was reset', () => 'Something interrupted the connection. Try again.'],
    '-109': ["Couldn't reach this site", (h) => `${h} is unreachable from your network.`],
    '-324': ['This page sent no data', (h) => `${h} closed the connection without sending anything.`],
    '-312': ['This address is blocked for safety', () => 'Browsers block this network port because it is used by non-web services.'],
    '-310': ['Too many redirects', (h) => `${h} redirected you too many times. Clearing this site's cookies may help.`],
    '-30': ['Blocked for your safety', () => 'This page tried to load in a way the browser does not allow.'],
  };

  function errorPage(tab) {
    const e = tab.error;
    const host = hostOf(e.url || tab.url) || 'this site';
    const wrap = (ic, title, text, buttons, extra) =>
      h('div', { class: 'page-wrap' }, h('div', { class: 'err' }, ic, h('h2', { text: title }), h('p', { text }), extra || null, h('div', { class: 'err-actions' }, ...buttons)));
    const retry = h('button', { class: 'btn primary big', text: 'Try again', onclick: () => send('tab:reload', { id: tab.id }) });

    if (e.type === 'focus') {
      const left = S.focus ? Math.max(1, Math.ceil((S.focus.endsAt - Date.now()) / 60000)) : 0;
      return wrap(
        h('div', { class: 'breath' }, h('div', { class: 'err-icon focus' }, icon('focus', 30))),
        `Shh… ${host} is resting`,
        S.focus ? `You're in Focus Flow for about ${left} more minute${left === 1 ? '' : 's'}. Breathe in, breathe out, back to it.` : 'Focus Flow has ended.',
        [
          h('button', { class: 'btn big', text: 'Back to work', onclick: () => (tab.canGoBack ? send('tab:back', { id: tab.id }) : send('tab:close', { id: tab.id })) }),
          S.focus ? h('button', { class: 'btn primary big', text: 'End Focus Flow', onclick: () => send('focus:stop') }) : retry,
        ],
      );
    }
    if (e.type === 'https') {
      return wrap(
        h('div', { class: 'err-icon' }, icon('warn', 30)),
        "This site doesn't support a secure connection",
        `Tarun Search tried to load ${host} over HTTPS, but it doesn't support it. If you continue, anyone on your network could see or change what you send and receive.`,
        [
          h('button', { class: 'btn big', text: 'Go back', onclick: () => (tab.canGoBack ? send('tab:back', { id: tab.id }) : send('tab:close', { id: tab.id })) }),
          h('button', { class: 'btn big danger', text: 'Continue (not secure)', onclick: () => send('tab:allow-http', { id: tab.id }) }),
        ],
      );
    }
    if (e.type === 'crashed' || e.type === 'hung') {
      return wrap(
        h('div', { class: 'err-icon' }, icon('bug', 30)),
        e.type === 'crashed' ? 'This tab crashed' : "This page isn't responding",
        e.type === 'crashed' ? 'Something went wrong while showing this page. Reloading usually fixes it.' : 'You can wait for it, or reload the page.',
        [h('button', { class: 'btn primary big', text: 'Reload', onclick: () => send('tab:reload', { id: tab.id }) })],
      );
    }
    if (e.code && e.code <= -200 && e.code > -300) {
      return wrap(
        h('div', { class: 'err-icon' }, icon('shield', 30)),
        "Your connection isn't private",
        `Tarun Search stopped loading ${host} because its security certificate isn't valid. Someone could be trying to steal your information. You can't continue to this site.`,
        [h('button', { class: 'btn primary big', text: 'Go back to safety', onclick: () => (tab.canGoBack ? send('tab:back', { id: tab.id }) : send('tab:close', { id: tab.id })) })],
        h('div', { class: 'code', text: e.description || '' }),
      );
    }
    const known = NET_ERRORS[String(e.code)];
    const title = known ? known[0] : "Can't open this page";
    const text = known ? known[1](host) : `Something went wrong while loading ${host}.`;
    const buttons = [retry];
    if (e.code === -105 || e.code === -137) {
      buttons.push(h('button', { class: 'btn big', text: `Search ${engineName()}`, onclick: () => send('tab:navigate', { id: tab.id, input: host + ' ' }) }));
    }
    return wrap(h('div', { class: 'err-icon' }, icon(e.code === -106 ? 'wifiOff' : 'globe', 30)), title, text, buttons, h('div', { class: 'code', text: e.description || '' }));
  }

  // =========================================================== layout sync
  let layoutQueued = false;
  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      syncLayout();
    });
  }

  const rectOf = (el) => {
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };

  function syncLayout() {
    if (!S) return;
    const peekBody = document.querySelector('#peek-root .peek-body');
    const layout = {
      main: rectOf($('pane-main')),
      split: S.split ? rectOf($('pane-split')) : null,
      peek: peekShown && !peekCapturing ? rectOf(peekBody) : null,
      overlay: !!overlay,
    };
    const key = JSON.stringify(layout);
    if (key === lastLayout) return;
    lastLayout = key;
    send('layout:set', layout);
  }

  new ResizeObserver(queueLayout).observe($('content'));
  window.addEventListener('resize', queueLayout);
  $('sidebar').addEventListener('transitionend', queueLayout);
  $('stage').addEventListener('transitionend', queueLayout);

  let lastChrome = '';
  function syncChrome() {
    if (!probeCtx) probeCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const probe = probeCtx;
    const el = h('div', { style: { position: 'fixed', width: '1px', height: '1px', background: 'var(--tint)', color: 'var(--text)', pointerEvents: 'none' } });
    document.body.append(el);
    const cs = getComputedStyle(el);
    const tintColor = cs.backgroundColor;
    const textColor = cs.color;
    el.remove();
    const sample = (v) => {
      probe.fillStyle = '#000';
      probe.fillRect(0, 0, 1, 1);
      probe.fillStyle = v;
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
    };
    let bg = sample(tintColor);
    if (overlay || peekShown) {
      // Match the dimming scrim so native window buttons blend in.
      const mix = (hex) => Math.round(parseInt(hex, 16) * 0.78 + [15, 12, 30][mixI++] * 0.22);
      let mixI = 0;
      bg = '#' + [bg.slice(1, 3), bg.slice(3, 5), bg.slice(5, 7)].map((x) => mix(x).toString(16).padStart(2, '0')).join('');
    }
    const fg = sample(textColor);
    const collapsed = !!S.settings.sidebarCollapsed && !document.body.classList.contains('sidebar-peek');
    const key = bg + fg + collapsed;
    if (key === lastChrome) return;
    lastChrome = key;
    send('ui:chrome', { bg, fg, collapsed });
  }
  darkQuery.addEventListener('change', () => S && render());

  // =========================================================== backdrop (frozen page pictures under overlays)
  function showBackdrop(shots) {
    const bd = $('backdrop');
    bd.replaceChildren();
    const place = (rect, src) => {
      if (!rect) return;
      const el = h('div', { class: 'shot', style: { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' } });
      if (src && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(src)) el.style.backgroundImage = `url("${src}")`;
      bd.append(el);
    };
    const tab = activeTab();
    if (S.split) {
      if (!tabById(S.split.a)?.error) place(rectOf($('pane-main')), shots.main);
      if (!tabById(S.split.b)?.error) place(rectOf($('pane-split')), shots.split);
    } else if (tab && !tab.error) place(rectOf($('pane-main')), shots.main);
    bd.hidden = false;
    requestAnimationFrame(() => bd.classList.add('dim'));
    return shots;
  }

  function hideBackdrop() {
    const bd = $('backdrop');
    bd.hidden = true;
    bd.classList.remove('dim');
    bd.replaceChildren();
  }

  // =========================================================== overlays
  async function openOverlay(kind, build) {
    if (overlay) {
      overlay.cleanup && overlay.cleanup();
      overlay = { kind };
      mountOverlay(build);
      return;
    }
    if (overlayOpening) return;
    overlayOpening = true;
    let shots = {};
    try {
      shots = await query('views:capture');
    } catch {
      shots = {};
    }
    overlayOpening = false;
    overlay = { kind, shots };
    if (!peekShown) showBackdrop(shots);
    else setPeekShot(shots.peek);
    mountOverlay(build);
    syncLayout();
    syncChrome();
  }

  function mountOverlay(build) {
    const root = $('overlay-root');
    root.hidden = false;
    root.replaceChildren(h('div', { class: 'scrim', onmousedown: closeOverlay }), build());
  }

  function closeOverlay() {
    if (!overlay) return;
    overlay.cleanup && overlay.cleanup();
    overlay = null;
    const root = $('overlay-root');
    root.hidden = true;
    root.replaceChildren();
    if (!peekShown) hideBackdrop();
    else setPeekShot(null);
    syncLayout();
    syncChrome();
    if (activeTab() || S.peek) send('app:focus-page');
  }

  // =========================================================== command palette
  const ACTIONS = () => {
    const tab = activeTab();
    const list = [
      { title: 'New Space', sub: 'A fresh space for a project or part of life', icon: 'plus', kw: 'space new create', run: () => openSpaceEditor() },
      { title: 'New Ghost Space', sub: 'Private — forgets everything when closed', icon: 'ghost', kw: 'ghost private incognito secret', hint: `${MOD}${SHIFT}B`, run: () => send('space:new', { ghost: true }) },
      tab && !S.split && { title: 'Split View', sub: 'Put another page beside this one', icon: 'split', kw: 'split side by side two', hint: `${MOD}${SHIFT}E`, run: () => openPalette('split'), opensOverlay: true },
      S.split && { title: 'Close Split View', icon: 'split', kw: 'split close', run: () => send('split:close') },
      tab && { title: 'Zap an Element', sub: 'Click anything on the page to remove it', icon: 'zap', kw: 'zap remove hide element block annoying', hint: `${MOD}${SHIFT}X`, run: () => send('zap:start') },
      !S.focus && { title: 'Focus Flow · 25 min', sub: 'Pause distracting sites', icon: 'focus', kw: 'focus pomodoro timer work deep', run: () => send('focus:start', { minutes: 25 }) },
      !S.focus && { title: 'Focus Flow · 50 min', icon: 'focus', kw: 'focus pomodoro timer work deep long', run: () => send('focus:start', { minutes: 50 }) },
      S.focus && { title: 'End Focus Flow', icon: 'focus', kw: 'focus stop end', run: () => send('focus:stop') },
      tab && { title: 'Find in Page', icon: 'search', kw: 'find search page text', hint: `${MOD}F`, run: () => setTimeout(openFind, 50) },
      tab && { title: 'Copy Link', icon: 'copy', kw: 'copy url link share', hint: `${MOD}${SHIFT}C`, run: () => send('tab:copy-url') },
      tab && tab.kind !== 'peek' && { title: tab.kind === 'tab' ? 'Pin Tab' : 'Unpin Tab', icon: 'pin', kw: 'pin unpin keep', hint: `${MOD}D`, run: () => send('tab:pin', { id: tab.id }) },
      tab && S.settings.blockTrackers && { title: 'Pause / Resume Tracker Blocking Here', icon: 'shield', kw: 'shields trackers ads block privacy', run: () => send('tab:shields') },
      S.canReopen && { title: 'Reopen Closed Tab', icon: 'reload', kw: 'reopen undo closed restore', hint: `${MOD}${SHIFT}T`, run: () => send('tab:reopen') },
      { title: 'History & Archive', icon: 'library', kw: 'history archive library past', hint: IS_MAC ? '⌘Y' : 'Ctrl+H', run: () => openLibrary(), opensOverlay: true },
      { title: 'Settings', icon: 'settings', kw: 'settings preferences options config', hint: `${MOD},`, run: () => openSettings(), opensOverlay: true },
      { title: 'Toggle Sidebar', icon: 'sidebar', kw: 'sidebar hide show collapse', hint: `${MOD}S`, run: () => toggleSidebar() },
      { title: 'Theme: Light', icon: 'sun', kw: 'theme light mode appearance', run: () => send('settings:set', { key: 'theme', value: 'light' }) },
      { title: 'Theme: Dark', icon: 'moon', kw: 'theme dark mode appearance night', run: () => send('settings:set', { key: 'theme', value: 'dark' }) },
      { title: 'Theme: Match System', icon: 'monitor', kw: 'theme system auto appearance', run: () => send('settings:set', { key: 'theme', value: 'system' }) },
      { title: 'Keyboard Shortcuts', icon: 'keyboard', kw: 'shortcuts keys keyboard help', run: () => openSettings('shortcuts'), opensOverlay: true },
      { title: 'Clear Browsing Data…', icon: 'trash', kw: 'clear cookies cache history data delete privacy', run: () => confirmClearData(), opensOverlay: true },
      !S.isDefaultBrowser && { title: 'Make Tarun Search Your Default Browser', icon: 'star', kw: 'default browser', run: () => send('app:default-browser') },
      { title: 'Check for Updates', icon: 'download', kw: 'update upgrade version', run: () => send('app:check-updates') },
    ];
    return list.filter(Boolean);
  };

  const MODE_LABEL = { new: null, edit: null, split: 'Split View', peek: 'Peek' };

  function openPalette(mode = 'new', initial) {
    const tab = activeTab();
    if (mode === 'edit' && !tab) mode = 'new';
    const prefill = initial != null ? initial : mode === 'edit' ? tab.url : '';
    openOverlay('palette', () => {
      const input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: mode === 'split' ? 'Open a page or tab beside this one…' : `Search ${engineName()}, type a URL, or a command…`, value: prefill });
      const results = h('div', { class: 'palette-results' });
      let items = [];
      let sel = 0;
      let seq = 0;

      const go = (text) => {
        if (!text.trim()) return;
        if (mode === 'edit') send('tab:navigate', { id: tab.id, input: text });
        else if (mode === 'split') send('split:open', { input: text });
        else if (mode === 'peek') send('peek:open', { input: text });
        else send('tab:new', { input: text });
      };

      const draw = () => {
        results.replaceChildren();
        let group = null;
        items.forEach((it, i) => {
          if (it.group !== group) {
            group = it.group;
            if (group) results.append(h('div', { class: 'p-group', text: group }));
          }
          const el = h(
            'button',
            { class: 'p-item' + (i === sel ? ' sel' : ''), onmousemove: () => i !== sel && ((sel = i), highlight()), onclick: () => run(i) },
            h('span', { class: 'p-icon' }, it.fav ? favicon(it.fav.url, it.fav.src, 18) : icon(it.icon || 'arrowRight', 17)),
            h('span', { class: 'p-text' }, h('span', { class: 'p-title', text: it.title }), it.sub ? h('span', { class: 'p-sub', text: it.sub }) : null),
            it.hint ? h('span', { class: 'p-hint', text: it.hint }) : null,
          );
          results.append(el);
        });
        highlight();
      };
      const highlight = () => {
        const els = results.querySelectorAll('.p-item');
        els.forEach((el, i) => el.classList.toggle('sel', i === sel));
        if (els[sel]) els[sel].scrollIntoView({ block: 'nearest' });
      };
      const run = (i) => {
        const it = items[i];
        if (!it) return;
        // Actions that open another dialog replace this one in place (no flicker).
        if (!it.opensOverlay) closeOverlay();
        it.run();
      };

      const update = async () => {
        const text = input.value;
        const t = text.trim();
        const my = ++seq;
        let r = { tabs: [], history: [], archive: [] };
        try {
          r = await query('search', { text: t });
        } catch {
          /* keep empty */
        }
        if (my !== seq) return;
        const next = [];
        if (t) {
          next.push(
            looksLikeUrl(t)
              ? { group: null, title: t, sub: mode === 'edit' ? 'Go to address' : 'Open website', icon: 'globe', run: () => go(t) }
              : { group: null, title: t, sub: `Search ${engineName()}`, icon: 'search', run: () => go(t) },
          );
        }
        if (mode !== 'split' && mode !== 'peek') {
          const lc = t.toLowerCase();
          const acts = ACTIONS().filter((a) => t && lc.length >= 2 && (a.title.toLowerCase().includes(lc) || a.kw.split(' ').some((k) => k.startsWith(lc))));
          for (const a of acts.slice(0, 5)) next.push({ ...a, group: 'Actions' });
        }
        const tabsGroup = mode === 'split' ? 'Put beside' : 'Switch to tab';
        for (const tb of r.tabs) {
          if (mode === 'split' && tb.active) continue;
          next.push({
            group: tabsGroup,
            title: tb.title,
            sub: `${displayUrl(tb.url)} · ${tb.space}`,
            fav: { url: tb.url, src: tb.favicon },
            hint: tb.active ? 'Current' : '',
            run: () => (mode === 'split' ? send('split:open', { id: tb.id }) : send('tab:activate', { id: tb.id })),
          });
        }
        for (const hi of r.history) next.push({ group: 'History', title: hi.title, sub: displayUrl(hi.url), fav: { url: hi.url, src: '' }, run: () => go(hi.url) });
        for (const a of r.archive) next.push({ group: 'Archive', title: a.title || displayUrl(a.url), sub: `Archived ${timeAgo(a.archivedAt)}`, fav: { url: a.url, src: a.favicon }, run: () => send('archive:restore', { index: a.index }) });
        if (!t && mode === 'new') {
          for (const a of ACTIONS().filter((x) => ['New Ghost Space', 'Split View', 'Focus Flow · 25 min', 'History & Archive'].includes(x.title))) next.push({ ...a, group: 'Try' });
        }
        items = next;
        sel = 0;
        draw();
      };

      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(update, 50);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          sel = Math.min(items.length - 1, sel + 1);
          highlight();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          sel = Math.max(0, sel - 1);
          highlight();
        } else if (e.key === 'Enter') {
          if (e.isComposing) return; // let input methods (Chinese, Japanese…) commit first
          e.preventDefault();
          clearTimeout(timer);
          const t = input.value.trim();
          // If the list is stale (typed fast), act on the text itself.
          if (items[sel] && (sel > 0 || !t || items[0].title === t)) run(sel);
          else if (t) {
            closeOverlay();
            go(t);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeOverlay();
        }
      });

      setTimeout(() => {
        input.focus();
        if (mode === 'edit') input.select();
      }, 0);
      update();
      const label = MODE_LABEL[mode];
      return h(
        'div',
        { class: 'palette', role: 'dialog', 'aria-label': 'Command bar' },
        h('div', { class: 'palette-input' }, icon(mode === 'split' ? 'split' : 'search', 20), input, label ? h('span', { class: 'mode-pill', text: label }) : null),
        results,
        h(
          'div',
          { class: 'palette-foot' },
          h('span', {}, kbd('↑↓'), 'navigate'),
          h('span', {}, kbd('↵'), 'open'),
          h('span', {}, kbd('esc'), 'close'),
          h('span', { style: { marginLeft: 'auto' } }, 'Tip: type “ghost”, “zap” or “focus”'),
        ),
      );
    });
  }

  // =========================================================== modals
  function modal({ title, width, body, foot, onClose }) {
    const close = h('button', { class: 'icon-btn', title: 'Close', onclick: () => closeOverlay() }, icon('close', 16));
    const el = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-label': title || 'Dialog', style: width ? { '--modal-w': width + 'px' } : null },
      title ? h('div', { class: 'modal-head' }, h('h2', { text: title }), close) : null,
      body,
      foot ? h('div', { class: 'modal-foot' }, ...foot) : null,
    );
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeOverlay();
      }
    });
    if (onClose && overlay) overlay.cleanup = onClose;
    setTimeout(() => {
      const f = el.querySelector('input:not([type=checkbox]), textarea, .btn.primary');
      (f || el.querySelector('button')).focus();
    }, 0);
    return el;
  }

  function confirmDialog({ title, text, ok = 'OK', danger = false }) {
    return new Promise((resolve) => {
      let answered = false;
      const answer = (v) => {
        if (answered) return;
        answered = true;
        closeOverlay();
        resolve(v);
      };
      openOverlay('confirm', () => {
        const m = modal({
          title,
          width: 420,
          body: h('div', { class: 'modal-body' }, h('p', { text, style: { margin: '4px 0 0', color: 'var(--muted)', lineHeight: '1.5' } })),
          foot: [h('button', { class: 'btn big', text: 'Cancel', onclick: () => answer(false) }), h('button', { class: `btn big ${danger ? 'danger' : 'primary'}`, text: ok, onclick: () => answer(true) })],
        });
        overlay.cleanup = () => {
          if (!answered) {
            answered = true;
            resolve(false);
          }
        };
        return m;
      });
    });
  }

  async function confirmClearData() {
    if (await confirmDialog({ title: 'Clear browsing data?', text: 'This signs you out of websites and deletes cookies, cache, history and the archive. Your spaces, pinned tabs and favorites stay.', ok: 'Clear everything', danger: true })) {
      send('data:clear');
    }
  }

  async function deleteSpace(spaceId) {
    const s = S.spaces.find((x) => x.id === spaceId);
    if (!s) return;
    const ok = await confirmDialog(
      s.ghost
        ? { title: `Close “${s.name}”?`, text: 'Everything in this Ghost Space — tabs, logins, cookies — will be erased for good.', ok: 'Close & erase', danger: true }
        : { title: `Delete “${s.name}”?`, text: `Its ${s.pinned.length + s.tabs.length} tabs will be closed. This can't be undone.`, ok: 'Delete space', danger: true },
    );
    if (ok) send('space:delete', { id: spaceId });
  }

  const EMOJIS = ['✨', '🏠', '💼', '🎨', '📚', '🎮', '🎵', '🛒', '✈️', '🍳', '💡', '🚀', '🧪', '📈', '🏃', '🌱', '🔥', '🌙', '⚽', '🎬', '💬', '🧠', '💰', '❤️'];
  const COLORS = ['#7c5cff', '#ff5c8a', '#18b47b', '#ff9f1c', '#2d9cdb', '#e05757', '#9b51e0', '#00b8a9', '#6b7280'];

  function openSpaceEditor(spaceId) {
    const editing = spaceId ? S.spaces.find((s) => s.id === spaceId) : null;
    let emoji = editing ? editing.emoji : EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
    let color = editing ? editing.color : COLORS[S.spaces.length % COLORS.length];
    openOverlay('space', () => {
      const name = h('input', { class: 'text-input', type: 'text', maxlength: '40', placeholder: 'e.g. School, Side project, Travel', value: editing ? editing.name : '' });
      const emojis = h('div', { class: 'emojis' });
      const swatches = h('div', { class: 'swatches' });
      const drawPickers = () => {
        emojis.replaceChildren(...EMOJIS.map((e) => h('button', { class: 'emoji-btn' + (e === emoji ? ' sel' : ''), text: e, onclick: () => ((emoji = e), drawPickers()) })));
        swatches.replaceChildren(...COLORS.map((c) => h('button', { class: 'swatch' + (c === color ? ' sel' : ''), title: c, style: { background: c, color: c }, onclick: () => ((color = c), drawPickers()) })));
      };
      drawPickers();
      const submit = () => {
        const payload = { name: name.value.trim(), emoji, color };
        if (editing) send('space:update', { id: editing.id, ...payload });
        else send('space:new', payload);
        closeOverlay();
      };
      name.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
      return modal({
        title: editing ? 'Edit space' : 'New space',
        width: 460,
        body: h(
          'div',
          { class: 'modal-body' },
          h('div', { class: 'field' }, h('label', { text: 'Name' }), name),
          h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Icon' }), emojis),
          h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Color' }), swatches),
        ),
        foot: [
          editing ? h('button', { class: 'btn big danger', text: 'Delete', style: { marginRight: 'auto' }, onclick: () => deleteSpace(editing.id) }) : null,
          h('button', { class: 'btn big', text: 'Cancel', onclick: closeOverlay }),
          h('button', { class: 'btn big primary', text: editing ? 'Save' : 'Create space', onclick: submit }),
        ].filter(Boolean),
      });
    });
  }

  function openFocusDialog() {
    if (S.focus) return toast('Focus Flow is already running — end it from the sidebar.');
    let minutes = 25;
    openOverlay('focus', () => {
      const seg = h('div', { class: 'seg' });
      const draw = () => seg.replaceChildren(...[15, 25, 50, 90].map((m) => h('button', { class: m === minutes ? 'sel' : '', text: `${m} min`, onclick: () => ((minutes = m), draw()) })));
      draw();
      const list = S.settings.focusBlocklist;
      return modal({
        title: '🧘 Focus Flow',
        width: 460,
        body: h(
          'div',
          { class: 'modal-body' },
          h('p', { style: { color: 'var(--muted)', lineHeight: '1.5', margin: '0 0 14px' }, text: 'For the next stretch, distracting sites take a nap. When the timer ends, everything wakes up again.' }),
          h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'How long?' }), seg),
          h('div', { class: 'field' }, h('span', { class: 'field-label', text: `Sleeping sites (${list.length})` }), h('div', { style: { color: 'var(--muted)', fontSize: '12px', lineHeight: '1.5' }, text: list.join(', ') || 'None — add some in Settings → Mysteries.' })),
        ),
        foot: [h('button', { class: 'btn big', text: 'Edit sites', onclick: () => openSettings('mysteries') }), h('button', { class: 'btn big primary', text: 'Start focusing', onclick: () => (closeOverlay(), send('focus:start', { minutes })) })],
      });
    });
  }

  function openLibrary(which = 'history') {
    openOverlay('library', () => {
      let tab = which;
      const search = h('input', { class: 'text-input', type: 'text', placeholder: 'Search…', spellcheck: 'false' });
      const seg = h('div', { class: 'seg' });
      const list = h('div', { style: { padding: '0 14px 14px', overflowY: 'auto', flex: '1', minHeight: '200px' } });
      const clearBtn = h('button', { class: 'btn danger' });
      const draw = async () => {
        seg.replaceChildren(
          h('button', { class: tab === 'history' ? 'sel' : '', onclick: () => ((tab = 'history'), draw()) }, icon('library', 13), 'History'),
          h('button', { class: tab === 'archive' ? 'sel' : '', onclick: () => ((tab = 'archive'), draw()) }, icon('archive', 13), `Archive (${S.archiveCount})`),
        );
        clearBtn.textContent = tab === 'history' ? 'Clear history' : 'Clear archive';
        const q = search.value.trim().toLowerCase();
        let rows = [];
        if (tab === 'history') {
          const items = await query('history:list', { text: q }).catch(() => []);
          rows = items.map((it) => libRow(it.url, '', it.title, `${displayUrl(it.url)} · ${timeAgo(it.visitedAt)}`, () => (closeOverlay(), send('tab:new', { input: it.url }))));
        } else {
          const items = await query('archive:list').catch(() => []);
          rows = items
            .map((it, index) => ({ it, index }))
            .filter(({ it }) => !q || `${it.title} ${it.url}`.toLowerCase().includes(q))
            .map(({ it, index }) => libRow(it.url, it.favicon, it.title, `${displayUrl(it.url)} · archived ${timeAgo(it.archivedAt)}`, () => (closeOverlay(), send('archive:restore', { index }))));
        }
        list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty', text: tab === 'history' ? 'No history yet.' : 'Nothing archived. Tabs you leave alone for a while land here.' })]));
      };
      search.addEventListener('input', () => draw());
      clearBtn.onclick = async () => {
        const isHist = tab === 'history';
        const ok = await confirmDialog({ title: isHist ? 'Clear all history?' : 'Clear the archive?', text: isHist ? 'Your browsing history will be deleted.' : 'All archived tabs will be deleted.', ok: 'Clear', danger: true });
        if (ok) send(isHist ? 'history:clear' : 'archive:clear');
      };
      draw();
      const m = modal({
        title: 'History & Archive',
        width: 680,
        body: h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: '0', flex: '1' } }, h('div', { class: 'lib-tabs' }, seg, search, clearBtn), list),
      });
      m.style.height = 'min(640px, calc(100vh - 60px))';
      return m;
    });
  }

  function libRow(url, fav, title, sub, onclick) {
    return h(
      'button',
      { class: 'list-item', style: { width: '100%', textAlign: 'left' }, onclick, title: url },
      favicon(url, fav, 18),
      h('span', { class: 'li-text' }, h('div', { class: 'li-title', text: title || displayUrl(url) }), h('div', { class: 'li-sub', text: sub })),
    );
  }

  // ---- settings
  function openSettings(section = 'general') {
    openOverlay('settings', () => {
      let current = section;
      const nav = h('div', { class: 'settings-nav' });
      const main = h('div', { class: 'settings-main' });
      const SECTIONS = [
        ['general', 'General', 'settings'],
        ['tabs', 'Tabs & Spaces', 'sidebar'],
        ['privacy', 'Privacy & Security', 'shield'],
        ['mysteries', 'Mysteries', 'gift'],
        ['shortcuts', 'Shortcuts', 'keyboard'],
        ['about', 'About', 'info'],
      ];
      const draw = () => {
        nav.replaceChildren(...SECTIONS.map(([k, label, ic]) => h('button', { class: k === current ? 'sel' : '', onclick: () => ((current = k), draw()) }, icon(ic, 15), label)));
        main.replaceChildren(...SETTINGS_PAGES[current]());
        main.scrollTop = 0;
      };
      draw();
      overlay.redrawSettings = () => main.replaceChildren(...SETTINGS_PAGES[current]());
      const m = modal({ title: 'Settings', width: 820, body: h('div', { class: 'settings' }, nav, main) });
      m.style.height = 'min(640px, calc(100vh - 60px))';
      return m;
    });
  }

  const set = (key, value) => send('settings:set', { key, value });
  const row = (title, sub, control) => h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('div', { class: 'row-title', text: title }), sub ? h('div', { class: 'row-sub', text: sub }) : null), control);
  const toggle = (key) => {
    const t = h('input', { type: 'checkbox', class: 'toggle', checked: !!S.settings[key] });
    t.addEventListener('change', () => set(key, t.checked));
    return t;
  };
  const segmented = (key, options) => {
    const box = h('div', { class: 'seg' });
    const draw = (val) =>
      box.replaceChildren(...options.map(([v, label, ic]) => h('button', { class: v === val ? 'sel' : '', onclick: () => (set(key, v), draw(v)) }, ic ? icon(ic, 13) : null, label)));
    draw(S.settings[key]);
    return box;
  };
  const selectBox = (key, options) => {
    const sel = h('select', { class: 'text-input' }, ...options.map(([v, label]) => h('option', { value: v, text: label })));
    sel.value = String(S.settings[key]);
    sel.addEventListener('change', () => set(key, typeof S.settings[key] === 'number' ? Number(sel.value) : sel.value));
    return sel;
  };
  const domainList = (key, placeholder) => {
    const ta = h('textarea', { class: 'text-input', placeholder, spellcheck: 'false', value: S.settings[key].join('\n') });
    ta.addEventListener('change', () => set(key, ta.value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean)));
    return ta;
  };

  const SHORTCUTS = [
    ['Command bar / new tab', `${MOD}T`],
    ['Edit address', `${MOD}L`],
    ['Close tab', `${MOD}W`],
    ['Reopen closed tab', `${MOD}${SHIFT}T`],
    ['Pin / unpin tab', `${MOD}D`],
    ['Toggle sidebar', `${MOD}S`],
    ['Split view', `${MOD}${SHIFT}E`],
    ['Find in page', `${MOD}F`],
    ['Copy page link', `${MOD}${SHIFT}C`],
    ['Next / previous tab', IS_MAC ? '⌃Tab / ⌃⇧Tab' : 'Ctrl+Tab / Ctrl+Shift+Tab'],
    ['Switch space', `${MOD}${ALT}← / →`],
    ['Go to tab 1–9', `${MOD}1 … ${MOD}9`],
    ['Back / forward', IS_MAC ? '⌘[ / ⌘]' : 'Alt+← / Alt+→'],
    ['Reload', `${MOD}R`],
    ['Zoom in / out / reset', `${MOD}+ / ${MOD}− / ${MOD}0`],
    ['History & archive', IS_MAC ? '⌘Y' : 'Ctrl+H'],
    ['New space', `${MOD}${SHIFT}N`],
    ['👻 Ghost space', `${MOD}${SHIFT}B`],
    ['⚡ Zap an element', `${MOD}${SHIFT}X`],
    ['🧘 Focus Flow', `${MOD}${SHIFT}F`],
    ['Open Peek as a tab', `${MOD}↵`],
    ['Settings', `${MOD},`],
  ];

  const SETTINGS_PAGES = {
    general: () => [
      h('h3', { text: 'General' }),
      row('Search engine', 'Used when you type something that is not a web address.', selectBox('searchEngine', Object.entries(S.engines))),
      row('Appearance', null, segmented('theme', [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']])),
      row(
        'Default browser',
        S.isDefaultBrowser ? 'Tarun Search opens your links. 🎉' : 'Open links from other apps in Tarun Search.',
        S.isDefaultBrowser ? h('span', { style: { color: 'var(--ok)', display: 'grid' } }, icon('check', 18)) : h('button', { class: 'btn primary', text: 'Make default', onclick: () => send('app:default-browser') }),
      ),
      row('Check for updates automatically', 'Looks for a newer version once when you start the app.', toggle('checkUpdates')),
    ],
    tabs: () => [
      h('h3', { text: 'Tabs & Spaces' }),
      row('Archive today’s tabs after', 'Unpinned tabs you have not looked at for a while tidy themselves into the Archive. Nothing is lost.', selectBox('archiveAfterHours', [[0, 'Never'], [12, '12 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week']])),
      row('Put idle tabs to sleep after', 'Sleeping tabs free up memory and battery, and wake up instantly when you click them.', selectBox('sleepAfterMinutes', [[0, 'Never'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours']])),
      row('Hide the sidebar', `Toggle any time with ${MOD}S. Hover the left edge to peek at it.`, toggle('sidebarCollapsed')),
    ],
    privacy: () => {
      const permsBox = h('div', {}, h('div', { class: 'empty', text: 'Loading…' }));
      query('permissions:list')
        .then((list) => {
          permsBox.replaceChildren(
            ...(list.length
              ? list.map((p) =>
                  h(
                    'div',
                    { class: 'list-item' },
                    favicon(p.origin, '', 18),
                    h('span', { class: 'li-text' }, h('div', { class: 'li-title', text: hostOf(p.origin) || p.origin }), h('div', { class: 'li-sub', text: Object.entries(p.perms).map(([k, v]) => `${k}: ${v === 'allow' ? 'allowed' : 'blocked'}`).join(' · ') })),
                    h('button', { class: 'btn', text: 'Reset', onclick: () => (send('permissions:forget', { origin: p.origin }), overlay && overlay.redrawSettings && setTimeout(overlay.redrawSettings, 50)) }),
                  ),
                )
              : [h('div', { class: 'row-sub', style: { padding: '6px 0 0' }, text: 'No sites have saved permissions.' })]),
          );
        })
        .catch(() => permsBox.replaceChildren());
      return [
        h('h3', { text: 'Privacy & Security' }),
        row('Block trackers', 'Stops well-known ad and tracking scripts from following you across sites. Pause it per site from the shield in the address bar.', toggle('blockTrackers')),
        row('HTTPS-First', 'Always try a secure connection first, and warn you before loading a site that does not support one.', toggle('httpsFirst')),
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Sites with tracker blocking paused' }), domainList('shieldsDownSites', 'example.com')),
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Site permissions' }), permsBox),
        row('Clear browsing data', 'Cookies, cache, history and archive. Spaces and pinned tabs are kept.', h('button', { class: 'btn danger', text: 'Clear…', onclick: () => confirmClearData() })),
        h('div', { class: 'row-sub', style: { marginTop: '12px' }, text: 'Always on: every website runs in a locked-down sandbox, with no access to your files or the rest of the app. Pages with broken security certificates are blocked. Downloads never open apps automatically.' }),
      ];
    },
    mysteries: () => {
      const zapBox = h('div', {});
      query('zaps:list')
        .then((list) =>
          zapBox.replaceChildren(
            ...(list.length
              ? list.map((z) =>
                  h('div', { class: 'list-item' }, favicon('https://' + z.host, '', 18), h('span', { class: 'li-text' }, h('div', { class: 'li-title', text: z.host }), h('div', { class: 'li-sub', text: `${z.count} element${z.count === 1 ? '' : 's'} zapped` })), h('button', { class: 'btn', text: 'Undo', onclick: () => (send('zap:clear', { host: z.host }), setTimeout(() => overlay && overlay.redrawSettings && overlay.redrawSettings(), 80)) })),
                )
              : [h('div', { class: 'row-sub', style: { padding: '6px 0 0' }, text: `Nothing zapped yet. Try ${MOD}${SHIFT}X on any site.` })]),
          ),
        )
        .catch(() => {});
      return [
        h('h3', { text: 'Mysteries' }),
        h('div', { class: 'row-sub', style: { marginBottom: '6px' }, text: `${['ghost', 'zap', 'focus'].filter((k) => S.mysteries[k]).length} of 3 discovered.` }),
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: '🧘 Focus Flow — sites to put to sleep (one per line)' }), domainList('focusBlocklist', 'youtube.com')),
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: '⚡ Zapped sites' }), zapBox),
        h('div', { class: 'row-sub', text: `👻 Ghost Spaces: create one from the space “+” button or ${MOD}${SHIFT}B. Close it from its right-click menu to erase everything.` }),
      ];
    },
    shortcuts: () => [h('h3', { text: 'Keyboard shortcuts' }), h('div', { class: 'shortcuts' }, ...SHORTCUTS.flatMap(([a, k]) => [h('span', { text: a }), kbd(k)]))],
    about: () => [
      h('div', { class: 'onboard', style: { padding: '24px 0 8px' } }, h('div', { class: 'logo', text: 'T' }), h('h1', { text: 'Tarun Search' }), h('p', { text: `Version ${S.version}` })),
      S.update ? row(`Version ${S.update.version} is available`, 'Download the new installer from the releases page.', h('button', { class: 'btn primary', text: 'Get update', onclick: () => send('app:open-update') })) : row('Updates', 'Check if a newer version is out.', h('button', { class: 'btn', text: 'Check now', onclick: () => send('app:check-updates') })),
      row('Help & source', 'Read the guide, report a problem, or peek at the code.', h('button', { class: 'btn', text: 'Open', onclick: () => send('app:help') })),
      row('Show the welcome tour again', null, h('button', { class: 'btn', text: 'Replay', onclick: () => (closeOverlay(), (onboardingDone = false), set('onboarded', false)) })),
    ],
  };

  // ---- onboarding
  function openOnboarding() {
    let step = 0;
    openOverlay('onboarding', () => {
      const box = h('div', { class: 'modal', style: { '--modal-w': '520px' }, role: 'dialog', 'aria-label': 'Welcome' });
      const finish = () => {
        onboardingDone = true;
        closeOverlay();
        set('onboarded', true);
      };
      const draw = () => {
        const dots = h('div', { class: 'steps' }, ...[0, 1, 2].map((i) => h('i', { class: i === step ? 'on' : '' })));
        let content;
        if (step === 0) {
          content = h(
            'div',
            { class: 'onboard' },
            h('div', { class: 'logo', text: 'T' }),
            h('h1', { text: 'Welcome to Tarun Search' }),
            h('p', { text: 'A calm, fast, private browser. Tabs live in a tidy sidebar, spaces keep life and work apart, and everything is one keystroke away.' }),
            dots,
          );
        } else if (step === 1) {
          content = h(
            'div',
            { class: 'onboard' },
            h('h1', { text: 'Make it yours' }),
            h('p', { text: 'You can change these any time in Settings.' }),
            h('div', { class: 'field', style: { textAlign: 'left', marginTop: '18px' } }, h('span', { class: 'field-label', text: 'Appearance' }), segmented('theme', [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']])),
            h('div', { class: 'field', style: { textAlign: 'left' } }, h('span', { class: 'field-label', text: 'Search engine' }), selectBox('searchEngine', Object.entries(S.engines))),
            dots,
          );
        } else {
          content = h(
            'div',
            { class: 'onboard' },
            h('h1', { text: 'Three moves to remember' }),
            h(
              'div',
              { class: 'tips' },
              h('div', { class: 'tip-row' }, icon('search', 16), 'Open anything, run any command', kbd(`${MOD}T`)),
              h('div', { class: 'tip-row' }, icon('sidebar', 16), 'Hide the sidebar', kbd(`${MOD}S`)),
              h('div', { class: 'tip-row' }, icon('pin', 16), 'Drag a tab up to pin it', kbd('drag')),
              h('div', { class: 'tip-row' }, icon('gift', 16), '3 mystery features are hiding on your home screen…', h('span', { text: '🎁' })),
            ),
            dots,
          );
        }
        box.replaceChildren(
          content,
          h(
            'div',
            { class: 'modal-foot', style: { justifyContent: 'space-between' } },
            step > 0 ? h('button', { class: 'btn big', text: 'Back', onclick: () => (step--, draw()) }) : h('button', { class: 'btn big', text: 'Skip', onclick: finish }),
            h('button', { class: 'btn big primary', text: step === 2 ? "Let's go" : 'Next', onclick: () => (step === 2 ? finish() : (step++, draw())) }),
          ),
        );
        setTimeout(() => box.querySelector('.btn.primary').focus(), 0);
      };
      draw();
      box.addEventListener('keydown', (e) => e.key === 'Escape' && (e.preventDefault(), finish()));
      return box;
    });
  }

  // =========================================================== peek
  function renderPeek() {
    const root = $('peek-root');
    const p = S.peek;
    if (!p) {
      if (peekShown) {
        peekShown = false;
        root.hidden = true;
        root.replaceChildren();
        if (!overlay) hideBackdrop();
        queueLayout();
        syncChrome();
      }
      return;
    }
    const firstShow = !peekShown;
    peekShown = true;
    const content = $('content').getBoundingClientRect();
    const w = Math.min(1180, content.width * 0.9);
    const hgt = content.height * 0.94;
    const frameStyle = { left: content.left + (content.width - w) / 2 + 'px', top: content.top + (content.height - hgt) / 2 + 'px', width: w + 'px', height: hgt + 'px' };
    let frame = root.querySelector('.peek-frame');
    if (!frame) {
      frame = h('div', { class: 'peek-frame' }, h('div', { class: 'peek-bar' }), h('div', { class: 'peek-body' }));
      root.replaceChildren(h('div', { class: 'scrim', onmousedown: () => send('peek:close') }), frame);
    }
    Object.assign(frame.style, frameStyle);
    frame.querySelector('.peek-bar').replaceChildren(
      h('div', { class: 'peek-title' }, favicon(p.url, p.favicon, 16), h('span', { text: p.title || displayUrl(p.url) }), h('span', { class: 'p-sub', text: hostOf(p.url) })),
      h('button', { class: 'icon-btn', title: `Open as tab (${MOD}↵)`, onclick: () => send('peek:expand') }, icon('expand', 15)),
      h('button', { class: 'icon-btn', title: 'Close', onclick: () => send('peek:close') }, icon('close', 16)),
    );
    const body = frame.querySelector('.peek-body');
    body.replaceChildren(p.error ? errorPage(p) : '');
    root.hidden = false;
    if (firstShow) {
      // Freeze the page behind the peek, then let the peek view appear in the frame.
      peekCapturing = true;
      query('views:capture')
        .catch(() => ({}))
        .then((shots) => {
          peekCapturing = false;
          if (!peekShown) return;
          if (!overlay) showBackdrop(shots);
          queueLayout();
        });
    } else queueLayout();
  }

  function setPeekShot(src) {
    const body = document.querySelector('#peek-root .peek-body');
    if (!body) return;
    body.style.backgroundImage = src && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(src) ? `url("${src}")` : '';
  }

  // =========================================================== find in page
  function openFind() {
    if (!activeTab()) return;
    findOpen = true;
    lastFindTab = S.activeTabId;
    $('findbar').hidden = false;
    document.body.classList.add('find-open');
    const input = $('find-input');
    setIcon(document.querySelector('.find-icon'), 'search', 14);
    setIcon($('find-prev'), 'up', 14);
    setIcon($('find-next'), 'down', 14);
    setIcon($('find-close'), 'close', 14);
    input.focus();
    input.select();
    queueLayout();
    if (input.value) send('find:query', { text: input.value });
  }

  function closeFind(focusPage = true) {
    if (!findOpen) return;
    findOpen = false;
    $('findbar').hidden = true;
    document.body.classList.remove('find-open');
    if (focusPage) send('find:stop');
    else if (lastFindTab) send('find:stop');
    queueLayout();
  }

  function renderFindCount() {
    const t = activeTab();
    const f = t && t.find;
    $('find-count').textContent = findOpen && f && f.text ? (f.matches ? `${f.active}/${f.matches}` : 'No matches') : '';
  }

  $('find-input').addEventListener('input', (e) => send('find:query', { text: e.target.value }));
  $('find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send('find:query', { text: e.target.value, forward: !e.shiftKey, findNext: true });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  $('find-next').onclick = () => send('find:query', { text: $('find-input').value, forward: true, findNext: true });
  $('find-prev').onclick = () => send('find:query', { text: $('find-input').value, forward: false, findNext: true });
  $('find-close').onclick = () => closeFind();

  // =========================================================== sidebar interactions
  function toggleSidebar() {
    sidebarPeek = false;
    set('sidebarCollapsed', !S.settings.sidebarCollapsed);
  }

  $('btn-sidebar').onclick = toggleSidebar;
  $('btn-sidebar-2').onclick = toggleSidebar;
  $('btn-back').onclick = () => activeTab() && send('tab:back', { id: S.activeTabId });
  $('btn-forward').onclick = () => activeTab() && send('tab:forward', { id: S.activeTabId });
  $('btn-reload').onclick = () => {
    const t = activeTab();
    if (t) send(t.loading ? 'tab:stop' : 'tab:reload', { id: t.id });
  };
  $('urlbar').onclick = () => openPalette(activeTab() ? 'edit' : 'new');
  $('urlbar').onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openPalette(activeTab() ? 'edit' : 'new'));
  $('btn-new-tab').onclick = () => openPalette('new');
  $('btn-library').onclick = () => openLibrary();
  $('btn-settings').onclick = () => openSettings();
  $('btn-new-space').onclick = () => openSpaceEditor();
  $('btn-clear-today').onclick = async () => {
    const n = activeSpace().tabs.length;
    if (n > 3 && !(await confirmDialog({ title: `Archive ${n} tabs?`, text: "Today's tabs move to the Archive, where you can bring any of them back.", ok: 'Archive' }))) return;
    send('space:clear-today');
  };

  // Hover the left edge to peek at a hidden sidebar.
  let peekTimer = null;
  $('edge-zone').addEventListener('mouseenter', () => {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      sidebarPeek = true;
      render();
    }, 150);
  });
  $('edge-zone').addEventListener('mouseleave', () => clearTimeout(peekTimer));
  $('sidebar').addEventListener('mouseleave', () => {
    if (!sidebarPeek) return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      sidebarPeek = false;
      render();
    }, 450);
  });
  $('sidebar').addEventListener('mouseenter', () => clearTimeout(peekTimer));

  // Swipe sideways on the sidebar to switch spaces.
  let swipe = 0;
  let swipeCooldown = 0;
  $('sidebar').addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Date.now() < swipeCooldown) return;
      swipe += e.deltaX;
      if (Math.abs(swipe) > 140) {
        send('app:command', { id: swipe > 0 ? 'next-space' : 'prev-space' });
        swipe = 0;
        swipeCooldown = Date.now() + 600;
      }
    },
    { passive: true },
  );

  // Resize the sidebar.
  const resizer = $('resizer');
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    let width = S.settings.sidebarWidth;
    const move = (ev) => {
      width = Math.max(220, Math.min(420, ev.clientX));
      document.body.style.setProperty('--sidebar-w', width + 'px');
      queueLayout();
    };
    const up = () => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      set('sidebarWidth', Math.round(width));
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });

  // ---- drag & drop
  let dropLine = null;
  const clearDrop = () => {
    if (dropLine) dropLine.remove();
    dropLine = null;
    document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  };

  document.addEventListener('dragstart', (e) => {
    const el = e.target.closest && e.target.closest('[data-id]');
    if (!el) return;
    e.dataTransfer.setData(TAB_MIME, el.dataset.id);
    e.dataTransfer.setData('text/uri-list', (tabById(el.dataset.id) || {}).url || '');
    e.dataTransfer.effectAllowed = 'move';
    dragging = true;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragend', () => {
    dragging = false;
    document.body.classList.remove('dragging');
    clearDrop();
    render();
  });

  function dropIndex(container, e) {
    const kids = [...container.querySelectorAll(':scope > [data-id]')];
    const grid = container.classList.contains('fav-grid');
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (grid ? e.clientY < r.bottom && e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) return { index: i, ref: kids[i], rect: r };
    }
    return { index: kids.length, ref: null, rect: kids.length ? kids[kids.length - 1].getBoundingClientRect() : null };
  }

  for (const container of document.querySelectorAll('[data-drop]')) {
    container.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      if (!types.includes(TAB_MIME) && !types.includes('text/uri-list')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = types.includes(TAB_MIME) ? 'move' : 'copy';
      clearDrop();
      if (container.classList.contains('fav-grid')) {
        container.classList.add('drop-target');
        return;
      }
      const { rect, ref } = dropIndex(container, e);
      const cr = container.getBoundingClientRect();
      dropLine = h('div', { class: 'drop-line' });
      const y = rect ? (ref ? rect.top : rect.bottom) - cr.top - 1 : 0;
      dropLine.style.top = y + 'px';
      container.append(dropLine);
    });
    container.addEventListener('dragleave', (e) => {
      if (!container.contains(e.relatedTarget)) clearDrop();
    });
    container.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData(TAB_MIME);
      const { index } = dropIndex(container, e);
      clearDrop();
      if (id) {
        send('tab:move', { id, kind: container.dataset.drop, spaceId: S.activeSpaceId, index });
      } else {
        const url = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#'));
        if (url && /^https?:\/\//i.test(url.trim())) send('tab:new', { input: url.trim() });
      }
    });
  }

  $('space-dots').addEventListener('dragover', (e) => {
    const dot = e.target.closest('.space-dot');
    if (!dot || ![...e.dataTransfer.types].includes(TAB_MIME)) return;
    e.preventDefault();
    clearDrop();
    dot.classList.add('drop-target');
  });
  $('space-dots').addEventListener('drop', (e) => {
    const dot = e.target.closest('.space-dot');
    const id = e.dataTransfer.getData(TAB_MIME);
    clearDrop();
    if (!dot || !id) return;
    e.preventDefault();
    const t = tabById(id);
    send('tab:move', { id, kind: t && t.kind === 'pinned' ? 'pinned' : 'tab', spaceId: dot.dataset.space });
  });

  // ---- keyboard inside the UI
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (overlay) return closeOverlay();
      if (findOpen) return closeFind();
      if (S && S.peek) return send('peek:close');
    }
    // Typing on the home screen starts a search.
    const target = e.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    if (!overlay && !typing && S && !activeTab() && !S.peek && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
      e.preventDefault();
      openPalette('new', e.key);
    }
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
})();
