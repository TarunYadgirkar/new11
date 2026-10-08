'use strict';
// Tiny DOM helpers. Everything that comes from web pages (titles, URLs) is set
// with textContent or attributes — never parsed as HTML.

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function icon(name, size = 16, cls = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    svg.innerHTML = window.ICONS[name] || ''; // trusted constant markup only
    return svg;
  }

  function setIcon(el, name, size) {
    el.replaceChildren(icon(name, size));
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : '';
    } catch {
      return '';
    }
  }

  function hashHue(s) {
    let x = 0;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
    return x % 360;
  }

  function letterIcon(url, size) {
    const host = hostOf(url) || '?';
    const hue = hashHue(host);
    return h('span', {
      class: 'fav-letter',
      text: host[0].toUpperCase(),
      style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.62) + 'px', background: `hsl(${hue} 62% 52%)` },
    });
  }

  function favicon(url, src, size = 16) {
    if (src && src.startsWith('https://')) {
      const img = h('img', { class: 'favicon', src, width: size, height: size, alt: '', referrerpolicy: 'no-referrer', draggable: 'false', loading: 'lazy' });
      img.addEventListener('error', () => img.replaceWith(letterIcon(url, size)), { once: true });
      return img;
    }
    return letterIcon(url, size);
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  }

  function timeAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? 'yesterday' : `${d}d ago`;
  }

  function displayUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
      const path = u.pathname === '/' ? '' : decodeURIComponent(u.pathname);
      return u.hostname.replace(/^www\./, '') + path + (u.search ? u.search : '');
    } catch {
      return url;
    }
  }

  window.UI = { h, append, icon, setIcon, favicon, hostOf, formatBytes, timeAgo, displayUrl, hashHue };
})();
