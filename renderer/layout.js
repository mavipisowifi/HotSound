'use strict';

/**
 * HotSound keyboard map.
 *
 * A PC keyboard layout with the numeric keypad excluded, and without the
 * editing/nav block (PrtSc, ScrLk, Pause, Ins, Home, PgUp, Del, End, PgDn).
 * The arrow cluster stays: Up sits above Down, as on a real board.
 *
 * Two kinds of key live here:
 *
 *   slot  - holds music. Binds to the hotkey at that physical position.
 *   muted - printed on the board but not a slot: it can never hold music, is not
 *           captured by the app, and is left entirely to the OS (Tab still moves
 *           focus, Esc still closes things, and so on).
 *
 * `code` is the physical key (KeyboardEvent.code), so a slot stays on its keycap
 * whatever the OS layout types for it. Widths are in key units (1u = one
 * alphanumeric key).
 */
window.HS = window.HS || {};

(function () {
  const ZONES = {
    rose: { fill: '#b27e7c', edge: '#d8a9a6', text: '#2a1618', label: 'Rose' },
    olive: { fill: '#aab72a', edge: '#ccd95c', text: '#20240a', label: 'Olive' },
    indigo: { fill: '#7574b8', edge: '#9c9bda', text: '#14142c', label: 'Indigo' },
    green: { fill: '#82ab77', edge: '#a9d19e', text: '#132016', label: 'Green' },
    teal: { fill: '#69a09f', edge: '#93c9c8', text: '#0e2120', label: 'Teal' },
    orange: { fill: '#c68e8c', edge: '#e6b6b3', text: '#2c1717', label: 'Orange' },
    mint: { fill: '#8fe0b6', edge: '#bdf0d5', text: '#0d2418', label: 'Mint' },
    muted: { fill: '#3b4a42', edge: '#55665d', text: '#9fb3a8', label: 'Muted (no slot)' }
  };

  /**
   * Keys that stay on the board but are not slots. They are never captured, never
   * loadable, and never a drop target.
   */
  const MUTED_CODES = new Set([
    'Escape',
    'Backquote',
    'Tab',
    'CapsLock',
    'ShiftLeft',
    'ShiftRight',
    'ControlLeft',
    'ControlRight',
    'AltLeft',
    'AltRight',
    'ContextMenu',
    'MetaLeft',
    'MetaRight',
    'Backspace',
    'Backslash'
  ]);

  /** Keys dropped from the board entirely. */
  const REMOVED_CODES = new Set([
    'PrintScreen', 'ScrollLock', 'Pause',
    'Insert', 'Home', 'PageUp',
    'Delete', 'End', 'PageDown'
  ]);

  const fnRow = [
    { code: 'Escape', label: 'Esc' },
    { gap: 1 },
    { code: 'F1', label: 'F1', zone: 'rose' },
    { code: 'F2', label: 'F2', zone: 'rose' },
    { code: 'F3', label: 'F3', zone: 'rose' },
    { code: 'F4', label: 'F4', zone: 'rose' },
    { gap: 0.5 },
    { code: 'F5', label: 'F5', zone: 'teal' },
    { code: 'F6', label: 'F6', zone: 'teal' },
    { code: 'F7', label: 'F7', zone: 'teal' },
    { code: 'F8', label: 'F8', zone: 'teal' },
    { gap: 0.5 },
    { code: 'F9', label: 'F9', zone: 'indigo' },
    { code: 'F10', label: 'F10', zone: 'indigo' },
    { code: 'F11', label: 'F11', zone: 'indigo' },
    { code: 'F12', label: 'F12', zone: 'indigo' }
  ];

  const numberRow = [
    { code: 'Backquote', label: '`', alt: '~' },
    { code: 'Digit1', label: '1', alt: '!' },
    { code: 'Digit2', label: '2', alt: '@' },
    { code: 'Digit3', label: '3', alt: '#' },
    { code: 'Digit4', label: '4', alt: '$' },
    { code: 'Digit5', label: '5', alt: '%' },
    { code: 'Digit6', label: '6', alt: '^' },
    { code: 'Digit7', label: '7', alt: '&' },
    { code: 'Digit8', label: '8', alt: '*' },
    { code: 'Digit9', label: '9', alt: '(' },
    { code: 'Digit0', label: '0', alt: ')' },
    { code: 'Minus', label: '-', alt: '_' },
    { code: 'Equal', label: '=', alt: '+' },
    { code: 'Backspace', label: 'Backspace', w: 2, zone: 'orange' }
  ];

  const qwertyRow = [
    { code: 'Tab', label: 'Tab', w: 1.5 },
    { code: 'KeyQ', label: 'Q' },
    { code: 'KeyW', label: 'W' },
    { code: 'KeyE', label: 'E' },
    { code: 'KeyR', label: 'R' },
    { code: 'KeyT', label: 'T' },
    { code: 'KeyY', label: 'Y' },
    { code: 'KeyU', label: 'U' },
    { code: 'KeyI', label: 'I' },
    { code: 'KeyO', label: 'O' },
    { code: 'KeyP', label: 'P' },
    { code: 'BracketLeft', label: '[', alt: '{' },
    { code: 'BracketRight', label: ']', alt: '}' },
    { code: 'Backslash', label: '\\', alt: '|', w: 1.5 }
  ];

  const homeRow = [
    { code: 'CapsLock', label: 'Caps', w: 1.75 },
    { code: 'KeyA', label: 'A' },
    { code: 'KeyS', label: 'S' },
    { code: 'KeyD', label: 'D' },
    { code: 'KeyF', label: 'F' },
    { code: 'KeyG', label: 'G' },
    { code: 'KeyH', label: 'H' },
    { code: 'KeyJ', label: 'J' },
    { code: 'KeyK', label: 'K' },
    { code: 'KeyL', label: 'L' },
    { code: 'Semicolon', label: ';', alt: ':' },
    { code: 'Quote', label: "'", alt: '"' },
    { code: 'Enter', label: 'Enter', w: 2.25, zone: 'orange' }
  ];

  // The 1.25u lead-in puts Up over Down rather than over Left.
  const zxcvRow = [
    { code: 'ShiftLeft', label: 'Shift', w: 2.25 },
    { code: 'KeyZ', label: 'Z' },
    { code: 'KeyX', label: 'X' },
    { code: 'KeyC', label: 'C' },
    { code: 'KeyV', label: 'V' },
    { code: 'KeyB', label: 'B' },
    { code: 'KeyN', label: 'N' },
    { code: 'KeyM', label: 'M' },
    { code: 'Comma', label: ',', alt: '<' },
    { code: 'Period', label: '.', alt: '>' },
    { code: 'Slash', label: '/', alt: '?' },
    { code: 'ShiftRight', label: 'Shift', w: 2.75 },
    { gap: 1.25, nav: true },
    { code: 'ArrowUp', label: 'Up', zone: 'teal', nav: true }
  ];

  const bottomRow = [
    { code: 'ControlLeft', label: 'Ctrl', w: 1.25 },
    { code: 'MetaLeft', label: 'Win', w: 1.25 },
    { code: 'AltLeft', label: 'Alt', w: 1.25 },
    { code: 'Space', label: 'Space', w: 6.25, zone: 'mint' },
    { code: 'AltRight', label: 'Alt', w: 1.25 },
    { code: 'MetaRight', label: 'Win', w: 1.25 },
    { code: 'ContextMenu', label: 'Menu', w: 1.25 },
    { code: 'ControlRight', label: 'Ctrl', w: 1.25 },
    { gap: 0.25, nav: true },
    { code: 'ArrowLeft', label: 'Left', zone: 'teal', nav: true },
    { code: 'ArrowDown', label: 'Down', zone: 'teal', nav: true },
    { code: 'ArrowRight', label: 'Right', zone: 'teal', nav: true }
  ];

  // Slot keys take their row colour; WASD gets an accent so the board does not
  // read as six flat bands.
  const ROW_ZONE = { fn: 'rose', numbers: 'green', qwerty: 'olive', home: 'rose', bottom: 'green', mods: 'indigo' };
  const ACCENTS = { KeyW: 'mint', KeyA: 'mint', KeyS: 'mint', KeyD: 'mint' };

  const LAYOUT = [
    { id: 'fn', name: 'Function', keys: fnRow },
    { id: 'numbers', name: 'Numbers', keys: numberRow },
    { id: 'qwerty', name: 'Top', keys: qwertyRow },
    { id: 'home', name: 'Home', keys: homeRow },
    { id: 'bottom', name: 'Bottom', keys: zxcvRow },
    { id: 'mods', name: 'Modifiers', keys: bottomRow }
  ];

  /** Keys with resolved geometry, in reading order. */
  const KEYS = [];
  const BY_CODE = new Map();
  LAYOUT.forEach((row, y) => {
    let x = 0;
    row.keys = row.keys.map((item) => {
      if (item.gap != null) {
        x += item.gap;
        return item;
      }
      const muted = MUTED_CODES.has(item.code);
      const unit = {
        ...item,
        w: item.w || 1,
        x,
        y,
        rowId: row.id,
        muted,
        zone: muted ? 'muted' : item.zone || ACCENTS[item.code] || ROW_ZONE[row.id]
      };
      KEYS.push(unit);
      BY_CODE.set(unit.code, unit);
      x += unit.w;
      return unit;
    });
  });

  /** Keys that can hold music. */
  const SLOT_KEYS = KEYS.filter((k) => !k.muted);

  const totalUnits = Math.max(
    ...LAYOUT.map((row) => row.keys.reduce((acc, k) => acc + (k.gap != null ? k.gap : k.w), 0))
  );

  window.HS.layout = {
    ZONES,
    LAYOUT,
    KEYS,
    SLOT_KEYS,
    BY_CODE,
    totalUnits,
    MUTED_CODES,
    REMOVED_CODES,
    isMuted: (code) => MUTED_CODES.has(code),
    /** Hotkey label for a slot, as printed on the keycap. */
    hotkeyLabel: (code) => (BY_CODE.get(code) || {}).label || code,
    /** Codes that can hold music and therefore take part in playback. */
    slotCodes: () => SLOT_KEYS.map((k) => k.code)
  };
})();
