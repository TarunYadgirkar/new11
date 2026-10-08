'use strict';

// The Zap picker runs inside an isolated JavaScript world of the page: it can
// read the DOM but shares no globals with the page's own scripts, and it has no
// access to Node or Electron. It resolves with a CSS selector (or null).
// The selector is validated in the main process before it is ever used.

/* eslint-disable no-undef */
function picker() {
  const IDENT = /^[A-Za-z_][A-Za-z0-9_-]{0,80}$/;
  const old = document.getElementById('__tarun_zap_box');
  if (old) old.remove();

  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.id = '__tarun_zap_box';
    box.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #ff3d71;' +
      'background:rgba(255,61,113,.14);border-radius:6px;transition:all 90ms ease;top:0;left:0;width:0;height:0;' +
      'box-shadow:0 0 0 4000px rgba(10,10,20,.12)';
    const tip = document.createElement('div');
    tip.textContent = '⚡ Click anything to zap it · Esc to cancel';
    tip.style.cssText =
      'position:fixed;z-index:2147483647;left:50%;top:16px;transform:translateX(-50%);pointer-events:none;' +
      'font:600 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;background:#ff3d71;' +
      'padding:9px 14px;border-radius:999px;box-shadow:0 8px 24px rgba(255,61,113,.45)';
    document.documentElement.append(box, tip);

    let target = null;
    const segment = (el) => {
      let s = el.localName;
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(s)) return null;
      const classes = [...el.classList].filter((c) => IDENT.test(c)).slice(0, 3);
      for (const c of classes) s += '.' + c;
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === el.localName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      return s;
    };
    const build = (el) => {
      const parts = [];
      let cur = el;
      while (cur && cur !== document.documentElement && parts.length < 15) {
        if (cur.id && IDENT.test(cur.id) && document.querySelectorAll('#' + cur.id).length === 1 && /^[a-z][a-z0-9-]{0,30}$/.test(cur.localName)) {
          parts.unshift(cur.localName + '#' + cur.id);
          break;
        }
        const seg = segment(cur);
        if (!seg) return null;
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      const sel = parts.join(' > ');
      try {
        return document.querySelector(sel) === el ? sel : null;
      } catch {
        return null;
      }
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('mousedown', block, true);
      window.removeEventListener('mouseup', block, true);
      window.removeEventListener('keydown', onKey, true);
      box.remove();
      tip.remove();
    };
    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === document.documentElement || el === document.body) return;
      target = el;
      const r = el.getBoundingClientRect();
      box.style.top = r.top + 'px';
      box.style.left = r.left + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    };
    const block = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onClick = (e) => {
      block(e);
      if (!target) return;
      const sel = build(target);
      cleanup();
      resolve(sel);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        block(e);
        cleanup();
        resolve(null);
      }
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('mousedown', block, true);
    window.addEventListener('mouseup', block, true);
    window.addEventListener('keydown', onKey, true);
  });
}

function cancelPicker() {
  const b = document.getElementById('__tarun_zap_box');
  if (b) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

const ZAP_WORLD_ID = 1337;
const PICKER_SOURCE = `(${picker.toString()})()`;
const CANCEL_SOURCE = `(${cancelPicker.toString()})()`;

function cssFor(selectors) {
  return selectors.map((s) => `${s}{display:none!important}`).join('\n');
}

module.exports = { ZAP_WORLD_ID, PICKER_SOURCE, CANCEL_SOURCE, cssFor };
