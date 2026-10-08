'use strict';

// Preload for the browser's own interface only (never for websites).
// Exposes a tiny, fixed API: no ipcRenderer, no Node, no Electron objects.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = { state: new Set(), event: new Set() };
for (const channel of Object.keys(listeners)) {
  ipcRenderer.on(channel, (_event, payload) => {
    for (const fn of listeners[channel]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(err);
      }
    }
  });
}

contextBridge.exposeInMainWorld('tarun', {
  platform: process.platform,
  send: (name, payload) => ipcRenderer.send('cmd', String(name), payload ?? {}),
  query: (name, payload) => ipcRenderer.invoke('query', String(name), payload ?? {}),
  on: (channel, fn) => {
    if (!Object.hasOwn(listeners, channel) || typeof fn !== 'function') return () => {};
    listeners[channel].add(fn);
    return () => listeners[channel].delete(fn);
  },
});
