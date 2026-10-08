'use strict';
// Tiny local website used by the end-to-end test.
const http = require('node:http');

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:40px;background:#fafafa}#banner{background:#ffd54f;padding:24px;font-weight:700}a{display:block;margin:12px 0;font-size:20px}</style>
</head><body>${body}</body></html>`;

function start() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let html;
    switch (url.pathname) {
      case '/a':
        html = page('Page A', `<h1>Page A</h1>
          <a id="blank" href="/b" target="_blank">Open B in new tab</a>
          <a id="same" href="/c">Go to C</a>
          <div id="banner">ANNOYING BANNER</div>
          <button id="popup" onclick="window.open('/b','pop','width=400,height=300')">popup</button>`);
        break;
      case '/b':
        html = page('Page B', `<h1>Page B</h1><script>document.title = 'Page B opener=' + (window.opener ? 'yes' : 'no')</script>`);
        break;
      case '/c':
        html = page('Page C', '<h1>Page C</h1>');
        break;
      case '/evil':
        html = page('Evil', `<h1>Evil</h1><script>
          window.results = {
            require: typeof require, process: typeof process, tarun: typeof window.tarun,
            electron: typeof window.electron, ipc: typeof window.ipcRenderer,
          };
          document.title = 'Evil ' + JSON.stringify(window.results);
        </script>`);
        break;
      case '/download':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="notes.txt"' });
        return res.end('hello from tarun search');
      case '/geo':
        html = page('Geo', `<h1>Geo</h1><script>
          window.ask = () => new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('allowed'), (e) => resolve('denied:' + e.code)));
        </script>`);
        break;
      case '/tracker':
        html = page('Tracker test', `<h1>Tracker</h1><script src="http://www.google-analytics.com/analytics.js"></script>`);
        break;
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { start };
