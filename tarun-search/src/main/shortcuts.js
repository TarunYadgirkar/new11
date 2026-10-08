'use strict';

// One table of every keyboard shortcut. The macOS app menu uses it for real
// accelerators; on Windows/Linux the same table is matched in before-input-event,
// so shortcuts work no matter which page has focus.

const COMMANDS = [
  // id, label, accelerator(s), menu
  { id: 'new-tab', label: 'New Tab…', accel: ['CmdOrCtrl+T', 'CmdOrCtrl+N'], menu: 'File' },
  { id: 'open-location', label: 'Open Location…', accel: ['CmdOrCtrl+L', 'Alt+D'], macAccel: ['Cmd+L'], menu: 'File' },
  { id: 'new-space', label: 'New Space…', accel: ['CmdOrCtrl+Shift+N'], menu: 'File' },
  { id: 'new-ghost', label: 'New Ghost Space', accel: ['CmdOrCtrl+Shift+B'], menu: 'File' },
  { id: 'reopen-tab', label: 'Reopen Closed Tab', accel: ['CmdOrCtrl+Shift+T'], menu: 'File' },
  { id: 'close-tab', label: 'Close Tab', accel: ['CmdOrCtrl+W', 'CmdOrCtrl+F4'], menu: 'File' },
  { id: 'print', label: 'Print…', accel: ['CmdOrCtrl+P'], menu: 'File' },

  { id: 'find', label: 'Find…', accel: ['CmdOrCtrl+F'], menu: 'Edit' },
  { id: 'find-next', label: 'Find Next', accel: ['CmdOrCtrl+G', 'F3'], menu: 'Edit' },
  { id: 'find-prev', label: 'Find Previous', accel: ['CmdOrCtrl+Shift+G', 'Shift+F3'], menu: 'Edit' },
  { id: 'copy-url', label: 'Copy Page Link', accel: ['CmdOrCtrl+Shift+C'], menu: 'Edit' },

  { id: 'toggle-sidebar', label: 'Toggle Sidebar', accel: ['CmdOrCtrl+S'], menu: 'View' },
  { id: 'reload', label: 'Reload', accel: ['CmdOrCtrl+R', 'F5'], menu: 'View' },
  { id: 'hard-reload', label: 'Hard Reload', accel: ['CmdOrCtrl+Shift+R', 'Ctrl+F5'], menu: 'View' },
  { id: 'zoom-in', label: 'Zoom In', accel: ['CmdOrCtrl+=', 'CmdOrCtrl+Shift+=', 'CmdOrCtrl+Plus'], menu: 'View' },
  { id: 'zoom-out', label: 'Zoom Out', accel: ['CmdOrCtrl+-'], menu: 'View' },
  { id: 'zoom-reset', label: 'Actual Size', accel: ['CmdOrCtrl+0'], menu: 'View' },
  { id: 'split', label: 'Split View', accel: ['CmdOrCtrl+Shift+E'], menu: 'View' },
  { id: 'fullscreen', label: 'Toggle Full Screen', accel: ['F11'], macAccel: ['Ctrl+Cmd+F'], menu: 'View' },
  { id: 'devtools', label: 'Developer Tools', accel: ['Ctrl+Shift+I', 'F12'], macAccel: ['Cmd+Alt+I'], menu: 'View' },

  { id: 'back', label: 'Back', accel: ['Ctrl+[', 'Alt+Left'], macAccel: ['Cmd+['], menu: 'Go' },
  { id: 'forward', label: 'Forward', accel: ['Ctrl+]', 'Alt+Right'], macAccel: ['Cmd+]'], menu: 'Go' },
  { id: 'next-tab', label: 'Next Tab', accel: ['Ctrl+Tab', 'CmdOrCtrl+Alt+Down'], menu: 'Go' },
  { id: 'prev-tab', label: 'Previous Tab', accel: ['Ctrl+Shift+Tab', 'CmdOrCtrl+Alt+Up'], menu: 'Go' },
  { id: 'next-space', label: 'Next Space', accel: ['CmdOrCtrl+Alt+Right'], menu: 'Go' },
  { id: 'prev-space', label: 'Previous Space', accel: ['CmdOrCtrl+Alt+Left'], menu: 'Go' },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `tab-${i + 1}`, label: `Tab ${i + 1}`, accel: [`CmdOrCtrl+${i + 1}`], menu: 'Go', hidden: true })),
  { id: 'history', label: 'History & Archive', accel: ['Ctrl+H'], macAccel: ['Cmd+Y'], menu: 'Go' },

  { id: 'pin-tab', label: 'Pin / Unpin Tab', accel: ['CmdOrCtrl+D'], menu: 'Tab' },
  { id: 'peek-expand', label: 'Open Peek as Tab', accel: ['CmdOrCtrl+Enter'], menu: 'Tab' },
  { id: 'zap', label: 'Zap an Element', accel: ['CmdOrCtrl+Shift+X'], menu: 'Tab' },
  { id: 'focus', label: 'Start / Stop Focus Flow', accel: ['CmdOrCtrl+Shift+F'], menu: 'Tab' },

  { id: 'settings', label: 'Settings…', accel: ['CmdOrCtrl+,'], menu: 'App' },
];

const KEY_CODES = {
  '=': ['Equal'], plus: ['Equal', 'NumpadAdd'], '-': ['Minus', 'NumpadSubtract'],
  '[': ['BracketLeft'], ']': ['BracketRight'], ',': ['Comma'], tab: ['Tab'],
  left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
  enter: ['Enter', 'NumpadEnter'], '\\': ['Backslash'],
};

function codesForKey(key) {
  const k = key.toLowerCase();
  if (KEY_CODES[k]) return KEY_CODES[k];
  if (/^[a-z]$/.test(k)) return ['Key' + k.toUpperCase()];
  if (/^[0-9]$/.test(k)) return ['Digit' + k, 'Numpad' + k];
  if (/^f\d{1,2}$/.test(k)) return [k.toUpperCase()];
  return [key];
}

/** Parses "CmdOrCtrl+Shift+T" into a matcher for the given platform. */
function parseAccelerator(accel, platform) {
  const isMac = platform === 'darwin';
  const parts = accel.split('+');
  // "CmdOrCtrl+Plus" style; a literal "+" key is written as "Plus".
  const key = parts.pop();
  const mods = { ctrl: false, meta: false, alt: false, shift: false };
  for (const p of parts) {
    const m = p.toLowerCase();
    if (m === 'cmdorctrl' || m === 'commandorcontrol') mods[isMac ? 'meta' : 'ctrl'] = true;
    else if (m === 'cmd' || m === 'command' || m === 'super' || m === 'meta') mods.meta = true;
    else if (m === 'ctrl' || m === 'control') mods.ctrl = true;
    else if (m === 'alt' || m === 'option') mods.alt = true;
    else if (m === 'shift') mods.shift = true;
  }
  return { ...mods, codes: codesForKey(key) };
}

function acceleratorsFor(cmd, platform) {
  return platform === 'darwin' && cmd.macAccel ? cmd.macAccel : cmd.accel;
}

function buildKeymap(platform) {
  const map = [];
  for (const cmd of COMMANDS) {
    for (const a of acceleratorsFor(cmd, platform)) map.push({ id: cmd.id, m: parseAccelerator(a, platform) });
  }
  return map;
}

/** Electron `input` (from before-input-event) -> command id, or null. */
function matchInput(keymap, input) {
  if (!input || input.type !== 'keyDown') return null;
  for (const { id, m } of keymap) {
    if (!!input.control === m.ctrl && !!input.meta === m.meta && !!input.alt === m.alt && !!input.shift === m.shift && m.codes.includes(input.code)) {
      return id;
    }
  }
  return null;
}

module.exports = { COMMANDS, parseAccelerator, acceleratorsFor, buildKeymap, matchInput };
