'use strict';
// Renders build/icon.svg to build/icon.png (1024×1024) using Electron itself.
// Run with: npm run icons
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true, show: false, frame: false, transparent: true, webPreferences: { sandbox: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.showInactive();
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = img.getSize().width === 1024 ? img : img.resize({ width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), out.toPNG());
  console.log('wrote build/icon.png', out.getSize());
  app.quit();
});
