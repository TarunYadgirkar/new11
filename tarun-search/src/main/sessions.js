'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');
const { hostOf, originOf, httpsUpgrade, hostMatches, isWebUrl, externalProtocolOf } = require('./url');
const { shouldBlock } = require('./trackers');

// Permissions granted without asking (harmless, or needed by ordinary sites).
const AUTO_ALLOW = new Set([
  'fullscreen', 'clipboard-sanitized-write', 'pointerLock',
  'storage-access', 'top-level-storage-access', 'speaker-selection', 'background-sync',
  'persistent-storage',
]);
// Permissions the user is asked about, and may remember per site.
const ASK = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'midi']);
// Everything else (usb, hid, serial, midiSysex, idle-detection, window-management …) is denied.

// Only these file types get an "Open" button. Everything else (apps, installers,
// scripts, shortcuts, unknown types) is only ever revealed in its folder.
const SAFE_TO_OPEN = new Set([
  'pdf', 'txt', 'md', 'csv', 'rtf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'bmp', 'tif', 'tiff',
  'mp3', 'm4a', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'epub',
]);

const configured = new WeakSet();

function uniquePath(dir, filename) {
  const clean = (filename || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'download';
  const ext = path.extname(clean);
  const base = clean.slice(0, clean.length - ext.length);
  let candidate = path.join(dir, clean);
  for (let i = 1; fs.existsSync(candidate) && i < 1000; i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function configureSession(ses, browser) {
  if (configured.has(ses)) return;
  configured.add(ses);

  ses.setUserAgent(app.userAgentFallback);
  ses.setSpellCheckerEnabled(true);

  // ---- Permissions ---------------------------------------------------------
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_ALLOW.has(permission)) return callback(true);

    if (permission === 'openExternal') {
      const ext = externalProtocolOf(details.externalURL || '');
      if (!ext) return callback(false);
      return browser.askPermission(wc, {
        permission,
        origin: originOf(details.requestingUrl) || 'This page',
        detail: ext.replace(':', ''),
        remember: false,
        callback,
      });
    }

    if (!ASK.has(permission)) return callback(false);
    const origin = originOf(details.requestingUrl || (wc && !wc.isDestroyed() ? wc.getURL() : ''));
    if (!origin) return callback(false);
    // Ghost spaces never reuse grants from normal spaces (that would link the two identities).
    const saved = browser.isGhostSession(ses) ? null : browser.savedPermission(origin, permission);
    if (saved) return callback(saved === 'allow');
    let detail = '';
    if (permission === 'media') {
      const types = details.mediaTypes || [];
      detail = types.includes('video') && types.includes('audio') ? 'camera & microphone' : types.includes('video') ? 'camera' : 'microphone';
    }
    return browser.askPermission(wc, { permission, origin, detail, remember: !browser.isGhostSession(ses), callback });
  });

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (AUTO_ALLOW.has(permission)) return true;
    if (!ASK.has(permission)) return false;
    const origin = originOf(requestingOrigin);
    return !!origin && !browser.isGhostSession(ses) && browser.savedPermission(origin, permission) === 'allow';
  });

  ses.setDevicePermissionHandler(() => false);

  // ---- Requests: HTTPS-first, Focus Flow shield, tracker blocking ----------
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    try {
      const tab = details.webContents ? browser.tabForWebContents(details.webContents) : null;
      if (details.resourceType === 'mainFrame') {
        const host = hostOf(details.url);
        if (tab && browser.isFocusBlocked(host)) {
          tab.markFocusBlocked(details.url);
          return callback({ cancel: true });
        }
        if (browser.settings.httpsFirst && !browser.httpAllowed.has(host)) {
          const upgraded = httpsUpgrade(details.url);
          if (upgraded) {
            if (tab) tab.httpsUpgrade = { from: details.url, to: upgraded };
            return callback({ redirectURL: upgraded });
          }
        }
        return callback({});
      }
      // Sub-resources and frames: block known trackers, except first-party ones.
      if (browser.settings.blockTrackers) {
        const pageHost = tab ? hostOf(tab.url) : hostOf(details.referrer || '');
        if (!browser.settings.shieldsDownSites.some((d) => hostMatches(pageHost, d)) && shouldBlock(hostOf(details.url), pageHost)) {
          if (tab) tab.countBlocked();
          return callback({ cancel: true });
        }
      }
    } catch (err) {
      console.error('[request]', err.message);
    }
    callback({});
  });

  // ---- Downloads -----------------------------------------------------------
  ses.on('will-download', (_event, item) => {
    const dir = app.getPath('downloads');
    const savePath = uniquePath(dir, item.getFilename());
    item.setSavePath(savePath);
    browser.trackDownload(item, savePath);
  });
}

function isRiskyFile(file) {
  return !SAFE_TO_OPEN.has(path.extname(file).slice(1).toLowerCase());
}

module.exports = { configureSession, isRiskyFile, uniquePath, AUTO_ALLOW, ASK, isWebUrl };
