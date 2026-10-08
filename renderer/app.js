'use strict';

/**
 * HotSound renderer.
 *
 * Owns the slot state, the keyboard DOM, hotkey capture and the waveform preview.
 * State is a flat map of slot code -> assignment; everything else is derived.
 *
 * Interaction:
 *   click empty   -> add music (file picker, or drop files onto the key)
 *   click filled  -> play
 *   right-click   -> remove the music
 *   shift+click   -> toggle loop
 *
 * Keys in layout.MUTED_CODES stay on the board but are not slots at all: they are
 * never captured, never loadable and never a drop target.
 */
(function (HS) {
  const { layout, AudioEngine, WaveformView } = HS;
  const { createEqBank, createPlayingList } = HS.Panels;

  const app = window.hotsound || null;

  /**
   * When the page is opened outside Electron (plain browser preview or visual QA)
   * there is no bridge. Stub it so the board still renders instead of throwing.
   */
  const bridge = app || {
    isSmokeTest: false,
    loadProfile: async () => null,
    saveProfile: async () => false,
    readAudio: async () => ({ ok: false, error: 'no audio bridge' }),
    fileExists: async () => true,
    setActiveProfile: async () => ({ ok: true }),
    appInfo: async () => ({ name: 'HotSound', version: '1.0.0', developer: 'Marvin Bangcailan', developerUrl: 'https://github.com/mavipisowifi' }),
    openExternal: async () => ({ ok: false, error: 'no bridge' }),
    syncGlobals: async () => ({ registered: [], failed: [] }),
    onGlobalTrigger: () => () => {},
    pathForFile: () => '',
    reportSmoke: () => {}
  };

  /* ---------------------------------------------------------------- *
   * Slot state
   * ---------------------------------------------------------------- */

  const state = {
    slots: {}, // code -> slot assignment (slot keys only)
    masterVolume: 0.9
  };

  const engine = new AudioEngine();
  const errors = [];
  let keyCaptureEnabled = true;

  /**
   * The app's only font. Read back from the theme so the stylesheet stays the
   * single source of truth, and used for canvas text, which does not inherit it.
   */
  const UI_FONT = (getComputedStyle(document.documentElement).getPropertyValue('--font') || 'Google Sans')
    .replace(/["']/g, '')
    .trim() || 'Google Sans';

  /** Resolve once every declared face is loaded, with a deadline so a broken font
   *  file cannot hold the app hostage. */
  async function waitForFonts(timeoutMs = 4000) {
    if (!document.fonts) return false;
    const ready = document.fonts.ready;
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs));
    const outcome = await Promise.race([ready.then(() => 'ready'), timeout]);
    if (outcome === 'timeout') {
      errors.push('font loading timed out');
      console.error('[HotSound] font loading timed out');
      return false;
    }
    return true;
  }

  const isMuted = (code) => layout.isMuted(code);

  function slotFor(code) {
    if (isMuted(code)) return null;
    if (!state.slots[code]) {
      state.slots[code] = {
        code,
        path: '',
        name: '',
        label: '',
        volume: 1,
        rate: 1,
        pan: 0,
        loop: false,
        global: false,
        error: ''
      };
    }
    return state.slots[code];
  }

  /** Read-only slot view: browsing the board must not create empty entries. */
  function peekSlot(code) {
    return (
      state.slots[code] || {
        code,
        path: '',
        name: '',
        label: '',
        volume: 1,
        rate: 1,
        pan: 0,
        loop: false,
        global: false,
        error: ''
      }
    );
  }

  function isEmpty(slot) {
    return !slot || !slot.path;
  }

  function slotTitle(slot) {
    if (!slot) return '';
    if (slot.label) return slot.label;
    if (slot.name) return slot.name.replace(/\.[^.]+$/, '');
    return '';
  }

  /* ---------------------------------------------------------------- *
   * DOM
   * ---------------------------------------------------------------- */

  const els = {};
  const keyNodes = new Map();
  let wave = null;
  let eq = null;
  let playing = null;

  function q(id) {
    return document.getElementById(id);
  }

  function cacheEls() {
    for (const id of [
      'board', 'legend', 'master-volume', 'master-volume-out', 'btn-load-folder',
      'btn-open-profile', 'btn-save-profile', 'btn-stop-all', 'np-key', 'np-sound', 'np-sub',
      'np-time', 'wave-canvas', 'status-msg', 'status-voices', 'status-keys', 'profile-badge', 'developer', 'dev-name', 'dev-github', 'eq-canvas', 'playing-list', 'playing-count',
      'drop-veil'
    ]) {
      els[id] = q(id);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function buildBoard() {
    const board = els.board;
    board.innerHTML = '';

    for (const key of layout.KEYS) {
      // Muted keys are not controls: a div keeps them out of the focus order and
      // out of every drag/drop path.
      const node = document.createElement(key.muted ? 'div' : 'button');
      if (!key.muted) node.type = 'button';
      node.className = 'key';
      node.dataset.code = key.code;
      node.dataset.zone = key.zone;
      node.style.setProperty('--x', key.x);
      node.style.setProperty('--w', key.w);
      node.style.setProperty('--y', key.y);
      if (key.nav) node.classList.add('nav');

      const zone = layout.ZONES[key.zone] || layout.ZONES.green;
      node.style.setProperty('--fill', zone.fill);
      node.style.setProperty('--edge', zone.edge);
      node.style.setProperty('--ink', zone.text);

      if (key.muted) {
        node.classList.add('muted');
        node.setAttribute('aria-hidden', 'true');
        node.title = `${key.label} - not a slot`;
        node.innerHTML = `<span class="key-cap">${escapeHtml(key.label)}</span>`;
        board.appendChild(node);
        keyNodes.set(key.code, node);
        continue;
      }

      node.setAttribute('aria-label', `${key.label} slot`);
      node.innerHTML =
        `<span class="key-cap">${escapeHtml(key.label)}</span>` +
        `<span class="key-title"></span>` +
        `<span class="key-badges"></span>` +
        `<span class="key-pulse" aria-hidden="true"></span>`;

      node.addEventListener('click', (ev) => onKeyClick(key.code, ev));
      node.addEventListener('contextmenu', (ev) => onKeyContextMenu(key.code, ev));
      node.addEventListener('dragenter', onKeyDragEnter);
      node.addEventListener('dragover', onKeyDragOver);
      node.addEventListener('dragleave', onKeyDragLeave);
      node.addEventListener('drop', onKeyDrop);

      board.appendChild(node);
      keyNodes.set(key.code, node);
    }

    renderLegend();
  }

  function renderLegend() {
    const used = new Set(layout.SLOT_KEYS.map((k) => k.zone));
    const parts = [...used].map((z) => {
      const zone = layout.ZONES[z];
      return `<span class="legend-item"><i style="background:${zone.fill}"></i>${escapeHtml(zone.label)}</span>`;
    });
    parts.push(`<span class="legend-item muted-legend"><i></i>Muted key - no slot</span>`);
    els.legend.innerHTML = parts.join('');
  }

  /** Resize the board so one key unit fills the available width, on whole pixels. */
  function fitBoard() {
    const board = els.board;
    const wrap = board.parentElement;
    if (!wrap) return;
    const available = wrap.clientWidth - 24;
    const raw = Math.floor(available / layout.totalUnits);
    let unit = Math.max(24, Math.min(64, raw));
    // Key widths and offsets step in 0.25u, so the unit must be a multiple of 4
    // for every edge to land on a whole pixel.
    unit -= unit % 4;
    // Even gap so half of it (the per-key inset) is also a whole pixel.
    const gapPx = Math.max(2, Math.round((unit * 0.05) / 2) * 2);
    board.style.setProperty('--u', `${unit}px`);
    board.style.setProperty('--gappx', `${gapPx}px`);
    // Whole-pixel label sizes: fractional font sizes render soft at small caps.
    board.style.setProperty('--fs-cap', `${Math.max(9, Math.round(unit * 0.2))}px`);
    board.style.setProperty('--fs-title', `${Math.max(9, Math.round(unit * 0.19))}px`);
    board.style.height = `${unit * layout.LAYOUT.length}px`;
    if (wave) wave.invalidate();
    if (eq) eq.redraw();
  }

  function refreshKey(code) {
    const node = keyNodes.get(code);
    if (!node || isMuted(code)) return;
    const slot = state.slots[code];
    const title = node.querySelector('.key-title');
    const badges = node.querySelector('.key-badges');
    const empty = isEmpty(slot);

    node.classList.toggle('empty', empty);
    node.classList.toggle('loaded', !empty);
    node.classList.toggle('errored', !!(slot && slot.error));
    node.classList.toggle('looping', !!(slot && slot.loop && !empty));

    title.textContent = empty ? '' : slotTitle(slot);
    title.title = slot && slot.path ? slot.path : '';

    const marks = [];
    if (slot && slot.global) marks.push('<i class="badge global" title="Global hotkey registered">G</i>');
    if (slot && slot.loop && !empty) marks.push('<i class="badge loop" title="Loops">&#8635;</i>');
    if (slot && slot.error) marks.push(`<i class="badge err" title="${escapeHtml(slot.error)}">!</i>`);
    badges.innerHTML = marks.join('');
  }

  function refreshAll() {
    for (const code of layout.slotCodes()) refreshKey(code);
  }

  function flashKey(code) {
    const node = keyNodes.get(code);
    if (!node || isMuted(code)) return;
    node.classList.remove('hit');
    void node.offsetWidth; // restart the animation on rapid retriggers
    node.classList.add('hit');
    setTimeout(() => node.classList.remove('hit'), 180);
  }

  function setStatus(message, kind) {
    els['status-msg'].textContent = message;
    els['status-msg'].dataset.kind = kind || '';
  }

  function formatTime(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
  }

  /** Mirror the waveform panel's state into the readout above it. */
  function renderNowPlaying(st, progress) {
    if (!st) {
      els['np-key'].textContent = '-';
      els['np-sound'].textContent = 'no sound loaded';
      els['np-sub'].textContent = 'Click an empty key to add music';
      els['np-time'].textContent = '';
      return;
    }
    els['np-key'].textContent = st.label;
    els['np-sound'].textContent = st.name;
    els['np-sub'].textContent = st.playing ? 'playing' : 'preview';
    const d = st.duration || 0;
    els['np-time'].textContent = `${formatTime(d * (progress || 0))} / ${formatTime(d)}`;
  }

  /* ---------------------------------------------------------------- *
   * Playback
   * ---------------------------------------------------------------- */

  async function triggerSlot(code, { loop } = {}) {
    if (isMuted(code)) return false;
    const slot = slotFor(code);
    if (!slot || !slot.path) {
      flashKey(code);
      return false;
    }
    flashKey(code);
    try {
      await engine.trigger(slot, loop != null ? { loop } : {});
      if (slot.error) {
        slot.error = '';
        refreshKey(code);
      }
      const buffer = engine.cache.get(slot.path);
      if (buffer) {
        wave.show({
          code,
          label: layout.hotkeyLabel(code),
          name: slotTitle(slot),
          buffer,
          rate: slot.rate,
          loop: loop != null ? loop : slot.loop
        });
        wave.play();
      }
      return true;
    } catch (err) {
      slot.error = err.message || String(err);
      refreshKey(code);
      setStatus(`Failed on ${layout.hotkeyLabel(code)}: ${slot.error}`, 'error');
      console.error('[HotSound] trigger failed', code, err);
      return false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Assignment and removal
   * ---------------------------------------------------------------- */

  /**
   * Assign files starting at `code`, spilling onto the following slot keys in
   * reading order. Muted keys are skipped, never filled.
   */
  async function assignPaths(code, files) {
    if (isMuted(code) || !files || !files.length) return [];
    const codes = layout.slotCodes();
    const start = codes.indexOf(code);
    const touched = [];

    files.forEach((file, i) => {
      const targetCode = i === 0 ? code : codes[start + i];
      if (!targetCode) return;
      const target = slotFor(targetCode);
      if (!target) return;
      target.path = file.path;
      target.name = file.name;
      target.error = '';
      touched.push(targetCode);
    });

    if (!touched.length) return [];

    refreshAll();
    setStatus(
      touched.length > 1
        ? `Added ${touched.length} samples starting at ${layout.hotkeyLabel(code)}`
        : `Added ${layout.hotkeyLabel(code)} -> ${files[0].name}`
    );

    const firstLoaded = await preloadSlot(code);
    for (const c of touched.slice(1)) preloadSlot(c, { quiet: true });
    if (firstLoaded) previewSlot(code);
    return touched;
  }

  /** Show the waveform of a slot without playing it. */
  function previewSlot(code) {
    const slot = state.slots[code];
    if (!slot || !slot.path) return;
    const buffer = engine.cache.get(slot.path);
    if (!buffer) return;
    wave.show({
      code,
      label: layout.hotkeyLabel(code),
      name: slotTitle(slot),
      buffer,
      rate: slot.rate,
      loop: slot.loop
    });
  }

  async function preloadSlot(code, { quiet = false } = {}) {
    const slot = state.slots[code];
    if (!slot || isEmpty(slot) || engine.has(slot.path)) return !!slot && !isEmpty(slot);
    try {
      const res = await app.readAudio(slot.path);
      if (!res.ok) throw new Error(res.error);
      await engine.load(slot.path, new Uint8Array(res.data));
      if (!quiet) setStatus(`${layout.hotkeyLabel(code)} loaded: ${slot.name}`);
      return true;
    } catch (err) {
      slot.error = err.message || String(err);
      refreshKey(code);
      return false;
    }
  }

  async function assignFromPicker(code) {
    if (isMuted(code)) return;
    const files = await pickFiles({ accept: AUDIO_ACCEPT });
    if (!files.length) {
      setStatus('Canceled');
      return;
    }
    await assignPaths(code, files);
  }

  /** Right-click: take the music back off the key. */
  function removeFromSlot(code) {
    if (isMuted(code)) return false;
    const slot = state.slots[code];
    if (isEmpty(slot)) return false;
    const wasGlobal = slot.global;
    const name = slotTitle(slot);

    engine.stopSlot(code);
    slot.path = '';
    slot.name = '';
    slot.label = '';
    slot.error = '';
    slot.global = false;
    slot.loop = false;

    refreshKey(code);
    if (wasGlobal) syncGlobals();
    if (wave.isShowing(code)) wave.clear();
    setStatus(`Removed music from ${layout.hotkeyLabel(code)}${name ? ` (${name})` : ''}`);
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Hotkey capture
   * ---------------------------------------------------------------- */

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function onKeyDown(ev) {
    if (ev.repeat) return;

    if (isTypingTarget(ev.target)) return;

    // Combos belong to the app, never to a slot: every slot *is* a bare key.
    if (ev.ctrlKey || ev.altKey || ev.metaKey) {
      if (ev.ctrlKey && ev.code === 'Escape') {
        ev.preventDefault();
        engine.stopAll();
        setStatus('Panic: stopped all voices');
      }
      return;
    }

    // Muted keys are not slots, so the OS keeps them: Tab still moves focus,
    // Escape still closes things, and typing them elsewhere is unaffected.
    if (isMuted(ev.code)) return;

    if (!keyCaptureEnabled) return;
    if (!layout.BY_CODE.has(ev.code)) return;
    ev.preventDefault();

    const heldShift = ev.shiftKey && ev.code !== 'ShiftLeft' && ev.code !== 'ShiftRight';
    if (heldShift) {
      const slot = slotFor(ev.code);
      if (!slot) return;
      slot.loop = !slot.loop;
      refreshKey(ev.code);
      setStatus(`${layout.hotkeyLabel(ev.code)} loop ${slot.loop ? 'on' : 'off'}`);
      return;
    }

    triggerSlot(ev.code);
  }

  function onKeyUp(ev) {
    // A looping slot sustains while its key is held, like a hardware sampler pad.
    if (isMuted(ev.code)) return;
    const slot = state.slots[ev.code];
    if (slot && slot.loop) engine.stopSlot(ev.code);
  }

  /* ---------------------------------------------------------------- *
   * Pointer interaction
   * ---------------------------------------------------------------- */

  function onKeyClick(code, ev) {
    if (isMuted(code)) return;

    if (ev.shiftKey) {
      const slot = slotFor(code);
      slot.loop = !slot.loop;
      refreshKey(code);
      setStatus(`${layout.hotkeyLabel(code)} loop ${slot.loop ? 'on' : 'off'}`);
      return;
    }

    const slot = state.slots[code];
    if (isEmpty(slot)) {
      assignFromPicker(code);
      return;
    }

    // A looping slot toggles, so a loop started with the mouse stops with the mouse.
    if (slot.loop && engine.voiceCountFor(code)) {
      engine.stopSlot(code);
      setStatus(`Stopped ${layout.hotkeyLabel(code)}`);
      return;
    }
    triggerSlot(code);
  }

  function onKeyContextMenu(code, ev) {
    ev.preventDefault();
    if (isMuted(code)) return;
    const slot = state.slots[code];
    if (isEmpty(slot)) {
      setStatus(`${layout.hotkeyLabel(code)} has no music to remove`);
      return;
    }
    removeFromSlot(code);
  }

  /* ---------------------------------------------------------------- *
   * Drag and drop
   * ---------------------------------------------------------------- */

  let dragDepth = 0;

  function isFileDrag(ev) {
    const dt = ev.dataTransfer;
    if (!dt || !dt.types) return false;
    return Array.from(dt.types).includes('Files');
  }

  function showDropVeil(show) {
    const veil = els['drop-veil'];
    if (veil && veil.hidden === show) veil.hidden = !show;
  }

  function clearDropTargets() {
    for (const n of els.board.querySelectorAll('.drop-target')) n.classList.remove('drop-target');
  }

  function onKeyDragEnter(ev) {
    if (!isFileDrag(ev) || isMuted(ev.currentTarget.dataset.code)) return;
    ev.preventDefault();
    dragDepth++;
    ev.currentTarget.classList.add('drop-target');
    showDropVeil(true);
  }

  function onKeyDragOver(ev) {
    if (!isFileDrag(ev) || isMuted(ev.currentTarget.dataset.code)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  }

  function onKeyDragLeave(ev) {
    ev.currentTarget.classList.remove('drop-target');
    if (!isFileDrag(ev)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDropVeil(false);
  }

  async function onKeyDrop(ev) {
    const code = ev.currentTarget.dataset.code;
    if (isMuted(code)) return;
    ev.preventDefault();
    dragDepth = 0;
    showDropVeil(false);
    ev.currentTarget.classList.remove('drop-target');
    const files = [...(ev.dataTransfer.files || [])]
      .map((f) => ({ path: app.pathForFile(f), name: f.name }))
      .filter((f) => f.path);
    if (!files.length) {
      setStatus('Dropped files have no readable path', 'error');
      return;
    }
    await assignPaths(code, files);
  }

  /* ---------------------------------------------------------------- *
   * Global hotkeys
   * ---------------------------------------------------------------- */

  const PANIC_ACCELERATOR = 'CommandOrControl+Alt+X';

  async function syncGlobals() {
    const bindings = [];
    for (const slot of Object.values(state.slots)) {
      if (!slot.global || !slot.path || isMuted(slot.code)) continue;
      const accel = acceleratorFor(slot.code);
      if (accel) bindings.push({ accelerator: accel, slotId: slot.code });
    }
    bindings.push({ accelerator: PANIC_ACCELERATOR, slotId: '__panic__' });

    const res = await app.syncGlobals(bindings);
    const failed = new Set((res && res.failed) || []);
    if (failed.size) {
      for (const slot of Object.values(state.slots)) {
        const accel = acceleratorFor(slot.code);
        if (accel && failed.has(accel)) {
          slot.global = false;
          slot.error = 'Global hotkey unavailable (already taken by another app)';
          refreshKey(slot.code);
        }
      }
      setStatus(`Global hotkeys unavailable: ${[...failed].join(', ')}`, 'error');
    } else if (res && res.registered && res.registered.length) {
      setStatus(`Global hotkeys active: ${res.registered.length}`);
    }
  }

  /**
   * Electron accelerators name modifiers as strings, not physical codes, so only
   * single, nameable keys can serve as OS-wide hotkeys.
   */
  function acceleratorFor(code) {
    if (!code || isMuted(code)) return null;
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    const named = {
      Space: 'Space',
      Enter: 'Return',
      Minus: '-',
      Equal: '=',
      Comma: ',',
      Period: '.',
      Slash: '/',
      Semicolon: ';',
      Quote: "'",
      BracketLeft: '[',
      BracketRight: ']',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right'
    };
    return named[code] || null;
  }

  /** True when a slot's key can be an OS-wide hotkey at all. */
  function canBeGlobal(code) {
    return !!acceleratorFor(code);
  }

  /* ---------------------------------------------------------------- *
   * Persistence
   * ---------------------------------------------------------------- */

  function serializeProfile() {
    return {
      version: 2,
      app: 'HotSound',
      savedAt: new Date().toISOString(),
      masterVolume: state.masterVolume,
      slots: state.slots
    };
  }

  let activeProfilePath = '';

  function setActiveProfile(pathname) {
    activeProfilePath = pathname || '';
    renderProfileBadge();
  }

  function renderProfileBadge() {
    const badge = els['profile-badge'];
    if (!badge) return;
    const base = activeProfilePath ? activeProfilePath.split(/[\\/]/).pop() : '-';
    badge.textContent = `profile: ${base}`;
    badge.title = activeProfilePath
      ? `${activeProfilePath}\nClick to show it in Explorer`
      : 'Active profile';
  }

  function applyProfile(profile) {
    if (!profile || typeof profile !== 'object') return;
    // A profile is the whole board: replace rather than merge, or keys from the
    // previously open profile would linger.
    state.slots = {};
    if (profile.slots && typeof profile.slots === 'object') {
      for (const [code, slot] of Object.entries(profile.slots)) {
        // Profiles written before keys were muted must not resurrect those slots.
        if (isMuted(code) || !slot || !slot.path) continue;
        const target = slotFor(code);
        if (!target) continue;
        Object.assign(target, {
          path: slot.path || '',
          name: slot.name || '',
          label: slot.label || '',
          volume: slot.volume == null ? 1 : slot.volume,
          rate: slot.rate == null ? 1 : slot.rate,
          pan: slot.pan == null ? 0 : slot.pan,
          loop: !!slot.loop,
          global: !!slot.global,
          error: ''
        });
      }
    }
    if (profile.masterVolume != null) {
      state.masterVolume = profile.masterVolume;
      engine.setMasterVolume(state.masterVolume);
      els['master-volume'].value = String(state.masterVolume);
      els['master-volume-out'].textContent = `${Math.round(state.masterVolume * 100)}%`;
    }
  }

  /** Silent save to whichever profile is active (used on window close). */
  async function saveProfile({ silent } = {}) {
    try {
      const res = await app.saveProfile(serializeProfile());
      if (res && res.path) setActiveProfile(res.path);
      if (!silent) setStatus(`Profile saved to ${res.path}`);
      return true;
    } catch (err) {
      setStatus(`Save failed: ${err.message}`, 'error');
      return false;
    }
  }

  /** Save As: ask Windows where to put it, then make that the active profile. */
  async function saveProfileAs() {
    let res;
    try {
      res = await app.saveProfileAs(serializeProfile());
    } catch (err) {
      setStatus(`Save failed: ${err.message}`, 'error');
      return false;
    }
    if (!res || res.canceled) {
      setStatus('Save canceled');
      return false;
    }
    if (!res.ok) {
      setStatus(`Save failed: ${res.error}`, 'error');
      return false;
    }
    setActiveProfile(res.path);
    setStatus(`Profile saved to ${res.path}`);
    return true;
  }

  /** Open a profile from anywhere on disk and make it the active one. */
  async function openProfile() {
    const chosen = await pickFiles({ accept: '.json,application/json' });
    if (!chosen.length) {
      setStatus('Canceled');
      return false;
    }
    const filePath = chosen[0].path;

    let profile;
    try {
      const text = await chosen[0].file.text();
      profile = JSON.parse(text);
    } catch (err) {
      setStatus(`Not a readable profile: ${err.message}`, 'error');
      return false;
    }

    applyProfile(profile);
    try {
      await app.setActiveProfile(filePath);
    } catch (err) {
      setStatus(`Loaded, but could not remember the location: ${err.message}`, 'error');
    }
    setActiveProfile(filePath);
    refreshAll();
    await verifyFiles();
    const loaded = Object.values(state.slots).filter((s) => s && s.path).length;
    setStatus(`Opened ${filePath} - ${loaded} key${loaded === 1 ? '' : 's'} with music`);
    return true;
  }

  async function loadProfile() {
    try {
      const res = await app.loadProfile();
      if (res && res.profile) applyProfile(res.profile);
      if (res && res.path) setActiveProfile(res.path);
      if (res && res.fellBack) {
        setStatus(`Profile at ${res.missing} was unreadable - using the working copy`, 'error');
      }
      return res;
    } catch (err) {
      setStatus(`Load failed: ${err.message}`, 'error');
      return null;
    }
  }

  /** Flag assignments whose file has gone missing since the profile was saved. */
  async function verifyFiles() {
    for (const code of Object.keys(state.slots)) {
      const slot = state.slots[code];
      if (!slot.path) continue;
      const exists = await app.fileExists(slot.path);
      if (!exists) {
        slot.error = 'File not found';
        refreshKey(code);
      }
    }
  }

  async function preloadAll() {
    const codes = Object.keys(state.slots).filter((c) => state.slots[c].path && !isMuted(c));
    let loaded = 0;
    for (const code of codes) {
      if (await preloadSlot(code, { quiet: true })) loaded++;
      else refreshKey(code);
    }
    setStatus(`Preloaded ${loaded}/${codes.length} samples`);
  }

  /* ---------------------------------------------------------------- *
   * File picking
   *
   * Uses Chromium's own file chooser (a renderer-side <input type=file>) rather
   * than Electron's dialog.showOpenDialog. The shell open dialog segfaults this
   * process when it is dismissed - cancel the picker and the window vanishes with
   * no error - so it is not used anywhere in this app. The chosen File objects
   * carry real paths, which the preload resolves with webUtils.getPathForFile.
   * ---------------------------------------------------------------- */

  const AUDIO_ACCEPT = [
    '.wav', '.mp3', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus', '.webm', '.aif', '.aiff', 'audio/*'
  ].join(',');

  /** Build (but do not open) the picker input, split out so tests can inspect it. */
  function createFileInput({ directory = false, accept = '' } = {}) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    input.className = 'file-picker';
    if (directory) input.webkitdirectory = true;
    else if (accept) input.accept = accept;
    return input;
  }

  /**
   * Open the picker and resolve with the chosen files, or [] if it was cancelled.
   * Chromium fires `cancel` on the input when the chooser is dismissed, which is
   * what keeps a cancelled pick from hanging here.
   */
  function pickFiles(opts = {}) {
    return new Promise((resolve) => {
      const input = createFileInput(opts);

      let settled = false;
      const finish = (files) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(files);
      };

      input.addEventListener('change', () => {
        const chosen = [...(input.files || [])];
        const files = chosen
          .map((f) => ({ file: f, path: app.pathForFile(f), name: f.name, rel: f.webkitRelativePath || '' }))
          .filter((f) => f.path);
        if (chosen.length && !files.length) {
          // Never fail silently: a File whose path cannot be resolved would
          // otherwise look like the picker simply did nothing.
          setStatus(`Could not resolve the path of ${chosen.length} chosen file(s)`, 'error');
          console.error('[HotSound] no path for', chosen.map((f) => f.name).join(', '));
        }
        finish(files);
      });
      input.addEventListener('cancel', () => finish([]));

      document.body.appendChild(input);
      input.click();
    });
  }

  /**
   * Fill the board from a folder of samples. `picked` may be supplied directly
   * (folder contents already known) instead of opening the picker.
   */
  async function loadFolder(picked) {
    let res = picked;
    if (!res) {
      const chosen = await pickFiles({ directory: true, accept: AUDIO_ACCEPT });
      if (!chosen.length) {
        setStatus('Canceled');
        return;
      }
      // Keep to the chosen folder's direct children, not its subfolders.
      const hasRelative = chosen.some((f) => f.rel);
      const direct = hasRelative
        ? chosen.filter((f) => f.rel.split(/[\\/]/).length === 2)
        : chosen;
      const files = (direct.length ? direct : chosen)
        .map((f) => ({ path: f.path, name: f.name }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const dir = chosen[0].path.split(/[\\/]/).slice(0, -1).join('\\');
      res = { ok: true, dir, files };
    }
    if (!res.ok || !res.files.length) {
      if (res && res.error) setStatus(`Folder load failed: ${res.error}`, 'error');
      return;
    }
    const codes = layout.slotCodes();
    const emptyCodes = codes.filter((c) => isEmpty(state.slots[c]));
    const order = [...emptyCodes, ...codes.filter((c) => !emptyCodes.includes(c))];
    for (let i = 0; i < res.files.length && i < order.length; i++) {
      const slot = slotFor(order[i]);
      if (!slot) continue;
      slot.path = res.files[i].path;
      slot.name = res.files[i].name;
      slot.error = '';
    }
    refreshAll();
    await preloadAll();
    setStatus(`Loaded ${Math.min(res.files.length, order.length)} samples from ${res.dir}`);
  }

  /* ---------------------------------------------------------------- *
   * UI wiring
   * ---------------------------------------------------------------- */

  function wireUi() {
    els['master-volume'].addEventListener('input', (ev) => {
      state.masterVolume = Number(ev.target.value);
      engine.setMasterVolume(state.masterVolume);
      els['master-volume-out'].textContent = `${Math.round(state.masterVolume * 100)}%`;
    });

    els['btn-stop-all'].addEventListener('click', () => {
      const n = engine.stopAll();
      setStatus(`Stopped ${n} voice${n === 1 ? '' : 's'}`);
    });

    els['btn-save-profile'].addEventListener('click', () => saveProfileAs());
    els['btn-open-profile'].addEventListener('click', () => openProfile());
    els['btn-load-folder'].addEventListener('click', () => loadFolder());

    els['dev-github'].addEventListener('click', async () => {
      if (!developerUrl) return;
      const res = await app.openExternal(developerUrl);
      if (res && res.ok) setStatus(`Opening ${developerUrl}`);
      else setStatus(`Could not open the link: ${(res && res.error) || 'unknown error'}`, 'error');
    });

    els['profile-badge'].addEventListener('click', () => {
      if (activeProfilePath) app.revealProfile();
    });

    els['status-keys'].addEventListener('click', () => {
      keyCaptureEnabled = !keyCaptureEnabled;
      els['status-keys'].textContent = `keys: ${keyCaptureEnabled ? 'on' : 'off'}`;
      els['status-keys'].classList.toggle('off', !keyCaptureEnabled);
      els['status-keys'].title = keyCaptureEnabled
        ? 'Slot key capture is active - click to release the keyboard to other apps'
        : 'Slot key capture is off - muted keys are always released';
      setStatus(keyCaptureEnabled ? 'Slot key capture on' : 'Slot key capture off');
    });

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', fitBoard);
    document.addEventListener('dragend', () => {
      dragDepth = 0;
      showDropVeil(false);
      clearDropTargets();
    });
    // Dragging a file back out of the window fires dragleave with no target; a
    // depth counter alone would leave the overlay stuck on.
    document.addEventListener('dragleave', (ev) => {
      if (ev.relatedTarget === null) {
        dragDepth = 0;
        showDropVeil(false);
        clearDropTargets();
      }
    });
    // A drag that ends anywhere else must not leave the overlay up.
    window.addEventListener('blur', () => {
      dragDepth = 0;
      showDropVeil(false);
      clearDropTargets();
    });

    engine.onVoiceChange = (n, codes) => {
      els['status-voices'].textContent = `${n} voice${n === 1 ? '' : 's'}`;
      for (const code of keyNodes.keys()) {
        const node = keyNodes.get(code);
        if (node && !isMuted(code)) node.classList.toggle('sounding', codes.has(code));
      }
      if (playing) playing.sync();
    };

    if (app && app.onGlobalTrigger) {
      app.onGlobalTrigger(({ slotId }) => {
        if (slotId === '__panic__') {
          engine.stopAll();
          setStatus('Panic: stopped all voices');
        } else {
          triggerSlot(slotId);
        }
      });
    }

    window.addEventListener('beforeunload', () => {
      saveProfile({ silent: true });
    });
  }

  /* ---------------------------------------------------------------- *
   * Developer credit
   *
   * Read from package.json through the main process, so the name and the GitHub
   * link shown here are the same values the Windows build stamps into the exe.
   * ---------------------------------------------------------------- */

  let developerUrl = '';

  async function renderDeveloper() {
    let info = {};
    try {
      info = (await app.appInfo()) || {};
    } catch (err) {
      console.error('[HotSound] could not read app info:', err.message);
    }
    const name = info.developer || 'unknown';
    developerUrl = info.developerUrl || '';
    els['dev-name'].textContent = name;
    els['dev-github'].disabled = !developerUrl;
    els['dev-github'].title = developerUrl || 'No link configured';
    els['developer'].title = [
      `Developer: ${name}`,
      developerUrl,
      [info.name, info.version].filter(Boolean).join(' '),
      info.copyright
    ].filter(Boolean).join('\n');
    return info;
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  async function boot() {
    cacheEls();
    // Every font face must be resident before anything paints: the canvas preview
    // and the keycaps must never render in a fallback face.
    await waitForFonts();
    wave = new WaveformView(els['wave-canvas'], engine, {
      onChange: renderNowPlaying,
      fontFamily: UI_FONT
    });

    // Equalizer faders above the board, and the list of keys playing now.
    eq = createEqBank({ canvas: els['eq-canvas'], engine });
    playing = createPlayingList({
      list: els['playing-list'],
      count: els['playing-count'],
      engine,
      formatTime,
      describe: (code) => {
        const key = layout.BY_CODE.get(code);
        const slot = state.slots[code];
        const zone = layout.ZONES[(key && key.zone) || 'green'] || layout.ZONES.green;
        return {
          label: layout.hotkeyLabel(code),
          title: slotTitle(slot) || (slot && slot.name) || '',
          fill: zone.fill,
          loop: !!(slot && slot.loop)
        };
      }
    });

    // Paint the idle state now; sync() otherwise only runs on a voice change.
    playing.sync();
    buildBoard();
    fitBoard();
    wireUi();

    await renderDeveloper();
    await loadProfile();
    refreshAll();
    await verifyFiles();
    await syncGlobals();

    // Preview whatever is on the lowest-numbered key that has music.
    const firstWithMusic = layout.slotCodes().find((c) => !isEmpty(state.slots[c]));
    if (firstWithMusic) {
      await preloadSlot(firstWithMusic, { quiet: true });
      previewSlot(firstWithMusic);
    }

    const loaded = Object.values(state.slots).filter((s) => s && s.path).length;
    setStatus(
      loaded
        ? `Profile loaded - ${loaded} key${loaded === 1 ? '' : 's'} with music`
        : 'Ready - click an empty key to add music'
    );

    return { loaded };
  }

  /* ---------------------------------------------------------------- *
   * Self-test (npm run smoke)
   * ---------------------------------------------------------------- */

  async function smokeTest() {
    const report = {
      layout: {
        rows: layout.LAYOUT.length,
        keys: layout.KEYS.length,
        slotKeys: layout.SLOT_KEYS.length,
        mutedKeys: layout.KEYS.filter((k) => k.muted).length,
        totalUnits: layout.totalUnits,
        hasNumpad: layout.KEYS.some((k) => /^Numpad/.test(k.code)),
        removedStillPresent: [...layout.REMOVED_CODES].filter((c) => layout.BY_CODE.has(c))
      },
      dom: {},
      audio: {},
      errors: [...errors]
    };

    const board = els.board || q('board');
    const nodes = board ? board.querySelectorAll('.key') : [];
    report.dom.keyNodes = nodes.length;
    report.dom.missingNodes = layout.KEYS.filter((k) => !board.querySelector(`[data-code="${k.code}"]`)).length;
    report.dom.mutedNodes = board.querySelectorAll('.key.muted').length;
    report.dom.mutedAreNotButtons = [...board.querySelectorAll('.key.muted')].every((n) => n.tagName !== 'BUTTON');
    report.dom.mutedHaveNoTitle = [...board.querySelectorAll('.key.muted .key-title')].length;

    const spaceNode = board.querySelector('[data-code="Space"]');
    const tabNode = board.querySelector('[data-code="Tab"]');
    if (spaceNode && tabNode) {
      report.dom.spaceWiderThanTab = spaceNode.getBoundingClientRect().width > tabNode.getBoundingClientRect().width;
    }

    // Geometry: every keycap must land exactly where the layout model says, on
    // whole pixels, with no overlap.
    const boardRect = board.getBoundingClientRect();
    const unit = parseFloat(getComputedStyle(board).getPropertyValue('--u')) || 0;
    const gapPx = parseFloat(getComputedStyle(board).getPropertyValue('--gappx')) || 0;
    const rects = layout.KEYS.map((k) => {
      const r = keyNodes.get(k.code).getBoundingClientRect();
      return {
        code: k.code,
        row: k.y,
        muted: k.muted,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        w: r.width,
        h: r.height,
        expectLeft: boardRect.left + k.x * unit + gapPx / 2,
        expectTop: boardRect.top + k.y * unit + gapPx / 2,
        expectW: k.w * unit - gapPx,
        expectH: unit - gapPx
      };
    });

    const overlaps = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 0.5 && oy > 0.5) overlaps.push(`${a.code}/${b.code}`);
      }
    }

    const misplaced = rects
      .filter((r) => Math.abs(r.left - r.expectLeft) > 1 || Math.abs(r.top - r.expectTop) > 1
        || Math.abs(r.w - r.expectW) > 1 || Math.abs(r.h - r.expectH) > 1)
      .map((r) => `${r.code} @${Math.round(r.left)},${Math.round(r.top)}`);

    const mainEnds = layout.LAYOUT.map((row, i) => {
      const codes = row.keys.filter((k) => k.code && !k.nav).map((k) => k.code);
      const inRow = rects.filter((r) => r.row === i && codes.includes(r.code));
      return inRow.length ? Math.round(Math.max(...inRow.map((r) => r.right)) - boardRect.left) : null;
    }).filter((v) => v != null);

    // Up must sit directly over Down, and the two right-hand arrow columns must
    // line up with the board's right edge.
    const byCode = new Map(rects.map((r) => [r.code, r]));
    const up = byCode.get('ArrowUp');
    const down = byCode.get('ArrowDown');
    const right = byCode.get('ArrowRight');
    const arrowGeometry = {
      upOverDown: !!(up && down) && Math.abs(up.left - down.left) <= 1,
      rightIsLastColumn: !!(right) && Math.abs(right.right - Math.max(...rects.map((r) => r.right))) <= 1
    };

    report.geometry = {
      unitPx: unit,
      gapPx,
      overlaps: overlaps.slice(0, 8),
      overlapCount: overlaps.length,
      misplacedCount: misplaced.length,
      misplaced: misplaced.slice(0, 6),
      mainBlockEnds: mainEnds,
      arrowGeometry
    };

    // Overlay hygiene: nothing may cover the app at rest, and nothing may blur
    // what is behind it.
    const covered = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2;
    };
    const fullScreen = [...document.body.children]
      .filter((el) => covered(el) && getComputedStyle(el).position === 'fixed')
      .map((el) => el.id || el.className);
    const blurs = [...document.querySelectorAll('body *')]
      .filter((el) => {
        if (!covered(el)) return false;
        const bf = getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter;
        return bf && bf !== 'none';
      })
      .map((el) => el.id || el.className);
    const fontSizes = [...board.querySelectorAll('.key-cap, .key-title')].map((n) => parseFloat(getComputedStyle(n).fontSize));
    const fractionalRects = rects
      .filter((r) => [r.left, r.top, r.w, r.h].some((v) => Math.abs(v - Math.round(v)) > 0.01))
      .map((r) => r.code);

    report.overlays = {
      fullScreenCovering: fullScreen,
      blurring: blurs,
      fractionalFontSizes: [...new Set(fontSizes.filter((f) => f % 1 !== 0))],
      fractionalRectCount: fractionalRects.length,
      veilHidden: els['drop-veil'].hidden
    };

    // The two playback visualisations: an equalizer bank above the board and a list
    // of the keys currently sounding beside it.
    const eqCanvas = els['eq-canvas'];
    const playingPanel = document.querySelector('.playing-panel');
    report.visuals = {
      eqPresent: !!eqCanvas && !!eq,
      eqBands: eq ? eq.bands : 0,
      eqLevels: eq ? eq.levels().length : 0,
      eqCss: eqCanvas ? `${Math.round(eqCanvas.getBoundingClientRect().width)}x${Math.round(eqCanvas.getBoundingClientRect().height)}` : '0x0',
      eqBacking: eqCanvas ? `${eqCanvas.width}x${eqCanvas.height}` : '0x0',
      playingPanelPresent: !!playingPanel,
      playingRowsIdle: els['playing-list'].querySelectorAll('.playing-row').length,
      playingHintIdle: !!els['playing-list'].querySelector('.playing-empty'),
      playingCountIdle: els['playing-count'].textContent
    };

    // Placement is part of the requirement: the fader bank sits above the board and
    // the playing list is beside it, not below.
    const boardPanel = document.querySelector('.board-panel');
    const eqBankEl = document.querySelector('.eq-bank');
    const boardEl = document.querySelector('.board');
    const boardBox = boardPanel.getBoundingClientRect();
    const playingBox = playingPanel.getBoundingClientRect();
    report.placement = {
      eqInsideBoardPanel: !!(eqBankEl && boardPanel.contains(eqBankEl)),
      eqAboveBoard: !!(eqBankEl && boardEl) && eqBankEl.getBoundingClientRect().bottom <= boardEl.getBoundingClientRect().top + 1,
      playingBesideBoard: playingBox.left >= boardBox.right - 1,
      playingSameRow: Math.abs(playingBox.top - boardBox.top) <= 1,
      boardWidth: Math.round(boardBox.width),
      playingWidth: Math.round(playingBox.width)
    };

    // Removed divisions must be gone from the DOM entirely.
    report.removedUi = {
      hasSpinner: !!q('btn-spin') || !!q('spin-mode') || document.body.innerHTML.includes('Music Spinner'),
      hasInspector: !!q('insp-body') || document.body.innerHTML.includes('Slot inspector')
    };

    // Branding: the logo must be present and actually decoded, and the profile
    // buttons that drive saving must exist.
    const logo = document.querySelector('.brand-logo');
    report.branding = {
      logoPresent: !!logo,
      logoLoaded: !!(logo && logo.complete && logo.naturalWidth > 0),
      logoNatural: logo ? `${logo.naturalWidth}x${logo.naturalHeight}` : null,
      logoHeightPx: logo ? Math.round(logo.getBoundingClientRect().height) : 0,
      saveProfileButton: !!q('btn-save-profile'),
      openProfileButton: !!q('btn-open-profile'),
      profileBadge: !!q('profile-badge')
    };

    // Developer credit, as shown to the user and as stamped into the build.
    const devInfo = await renderDeveloper();
    const statusbar = document.querySelector('.statusbar');
    report.developer = {
      name: (devInfo && devInfo.developer) || '',
      url: (devInfo && devInfo.developerUrl) || '',
      version: (devInfo && devInfo.version) || '',
      nameShown: els['dev-name'].textContent === ((devInfo && devInfo.developer) || ''),
      linkEnabled: !els['dev-github'].disabled && els['dev-github'].title === ((devInfo && devInfo.developerUrl) || ''),
      creditVisible: els['developer'].getBoundingClientRect().width > 40,
      copyright: (devInfo && devInfo.copyright) || '',
      statusbarOverflowPx: statusbar ? Math.round(statusbar.scrollWidth - statusbar.clientWidth) : -1
    };

    // Chrome must fit: a bigger logo plus another button could overflow the bar.
    const topbar = document.querySelector('.topbar');
    report.chrome = {
      topbarOverflowPx: topbar ? Math.round(topbar.scrollWidth - topbar.clientWidth) : -1,
      statusbarOverflowPx: (() => {
        const sb = document.querySelector('.statusbar');
        return sb ? Math.round(sb.scrollWidth - sb.clientWidth) : -1;
      })(),
      pageOverflowPx: Math.round(document.documentElement.scrollWidth - window.innerWidth),
      viewport: `${window.innerWidth}x${window.innerHeight}`
    };

    // Typography: every declared face must load, and no other family may be
    // specified anywhere in the stylesheets or inline styles.
    const faceRules = [];
    const declaredFamilies = new Set();

    /**
     * Record the families a declaration really names. `var(--font)` is resolved
     * through the theme and `inherit`/`unset` resolve to the one family already in
     * play, so neither is a second font; anything else is.
     */
    const collectFamilies = (value) => {
      const raw = String(value || '').replace(/["']/g, '').trim();
      if (!raw) return;
      const varMatch = raw.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/);
      if (varMatch) {
        const resolved = getComputedStyle(document.documentElement).getPropertyValue(varMatch[1]).trim();
        collectFamilies(resolved || varMatch[2] || '');
        return;
      }
      for (const part of raw.split(',')) {
        const p = part.trim();
        if (!p || /^(inherit|unset|revert)$/i.test(p)) continue;
        declaredFamilies.add(p);
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // a cross-origin sheet would be unreadable; there are none
      }
      for (const rule of Array.from(rules || [])) {
        if (rule.constructor.name === 'CSSFontFaceRule' || rule.type === 5) {
          faceRules.push({
            family: (rule.style.getPropertyValue('font-family') || '').replace(/["']/g, '').trim(),
            weight: (rule.style.getPropertyValue('font-weight') || '').trim(),
            style: (rule.style.getPropertyValue('font-style') || '').trim()
          });
        }
        if (rule.style && rule.style.getPropertyValue) {
          collectFamilies(rule.style.getPropertyValue('font-family'));
        }
      }
    }
    for (const el of Array.from(document.querySelectorAll('[style]'))) {
      collectFamilies(el.style.getPropertyValue('font-family'));
    }

    const faceLoaded = {};
    for (const f of faceRules) {
      const key = `${f.weight} ${f.style}`;
      faceLoaded[key] = document.fonts ? document.fonts.check(`${f.weight} ${f.style} 16px "${f.family}"`) : false;
    }
    const bodyFamilies = getComputedStyle(document.body).fontFamily.replace(/["']/g, '');
    const keyCapFamilies = document.querySelector('.key-cap')
      ? getComputedStyle(document.querySelector('.key-cap')).fontFamily.replace(/["']/g, '')
      : '';

    report.typography = {
      uiFont: UI_FONT,
      faceRuleCount: faceRules.length,
      faces: faceRules.map((f) => `${f.weight} ${f.style}`),
      faceLoaded,
      allFacesLoaded: Object.values(faceLoaded).every(Boolean),
      declaredFamilies: [...declaredFamilies],
      bodyFontFamily: bodyFamilies,
      keyCapFontFamily: keyCapFamilies,
      fontsStatus: document.fonts ? document.fonts.status : 'unsupported'
    };

    // The only way to open a file must be the renderer picker: no bridge to the
    // shell open dialog, whose dismissal segfaults the process (see README).
    const plainInput = createFileInput({ accept: AUDIO_ACCEPT });
    const dirInput = createFileInput({ directory: true });
    report.picker = {
      shellDialogBridges: ['pickSounds', 'pickFolder', 'openProfile'].filter(
        (name) => window.hotsound && typeof window.hotsound[name] === 'function'
      ),
      fileInput: {
        type: plainInput.type,
        multiple: plainInput.multiple,
        hidden: plainInput.style.display === 'none',
        accept: plainInput.accept,
        directory: dirInput.webkitdirectory === true
      },
      leftoverInputs: document.querySelectorAll('input.file-picker').length
    };

    // Waveform preview is wired to a sized canvas.
    const canvas = els['wave-canvas'];
    const cRect = canvas.getBoundingClientRect();
    report.wave = {
      canvasWidth: Math.round(cRect.width),
      canvasHeight: Math.round(cRect.height),
      backingWidth: canvas.width,
      placeholderDrawn: canvas.width > 1 && canvas.height > 1
    };

    try {
      engine.ensureContext();
      report.audio.state = engine.ctx.state;
      report.audio.sampleRate = engine.ctx.sampleRate;
    } catch (err) {
      report.audio.error = err.message;
      report.errors.push('audio: ' + err.message);
    }

    // Muted keys must refuse to become slots.
    const beforeMuted = Object.keys(state.slots).length;
    await assignPaths('Escape', [{ path: 'C:/nope/none.wav', name: 'none.wav' }]);
    const mutedRefusals = {
      noSlotForEscape: !state.slots.Escape,
      noNewSlots: Object.keys(state.slots).length === beforeMuted,
      triggerRefused: (await triggerSlot('Escape')) === false,
      slotCodesExcludeMuted: layout.slotCodes().every((c) => !layout.isMuted(c))
    };
    report.muted = mutedRefusals;

    report.errors = [...errors];
    if (!report.dom.keyNodes) report.errors.push('no key nodes rendered');
    if (report.dom.missingNodes) report.errors.push(`${report.dom.missingNodes} keys missing from DOM`);
    if (report.layout.hasNumpad) report.errors.push('numpad keys present but must be excluded');
    if (report.layout.removedStillPresent.length) {
      report.errors.push(`removed keys still in layout: ${report.layout.removedStillPresent.join(', ')}`);
    }
    if (report.dom.mutedNodes !== report.layout.mutedKeys) {
      report.errors.push(`muted keys rendered ${report.dom.mutedNodes}, expected ${report.layout.mutedKeys}`);
    }
    if (!report.dom.mutedAreNotButtons) report.errors.push('muted keys are interactive buttons');
    if (report.dom.mutedHaveNoTitle) report.errors.push('muted keys expose a slot title');
    if (report.dom.spaceWiderThanTab !== true) report.errors.push('key widths not applied');
    if (report.geometry.overlapCount) report.errors.push(`keycaps overlap: ${report.geometry.overlaps.join(', ')}`);
    if (report.geometry.misplacedCount) report.errors.push(`keycaps off the layout grid: ${report.geometry.misplaced.join(' | ')}`);
    if (report.overlays.fullScreenCovering.length) {
      report.errors.push(`overlay covers the app at rest: ${report.overlays.fullScreenCovering.join(', ')}`);
    }
    if (report.overlays.blurring.length) report.errors.push(`element blurs the UI behind it: ${report.overlays.blurring.join(', ')}`);
    if (report.overlays.fractionalFontSizes.length) {
      report.errors.push(`fractional font sizes render soft: ${report.overlays.fractionalFontSizes.join(', ')}`);
    }
    if (report.overlays.fractionalRectCount) report.errors.push('keycaps off the pixel grid');
    if (!report.overlays.veilHidden) report.errors.push('drop overlay is not hidden at rest');
    if (report.removedUi.hasSpinner) report.errors.push('Music Spinner UI is still present');
    if (report.removedUi.hasInspector) report.errors.push('Slot inspector UI is still present');
    if (!report.branding.logoPresent) report.errors.push('brand logo missing from the UI');
    if (!report.branding.logoLoaded) report.errors.push('brand logo did not decode');
    if (report.branding.logoHeightPx < 20) report.errors.push('brand logo is not sized');
    if (!report.branding.saveProfileButton || !report.branding.openProfileButton) {
      report.errors.push('profile save/open buttons missing');
    }
    if (!report.branding.profileBadge) report.errors.push('profile badge missing');
    if (!report.developer.name) report.errors.push('developer credit is empty');
    if (!report.developer.url) report.errors.push('developer link is empty');
    if (!report.developer.nameShown) report.errors.push('developer credit is not visible in the status bar');
    if (!report.developer.linkEnabled) report.errors.push('developer link is not clickable');
    if (!report.placement.eqInsideBoardPanel) report.errors.push('fader bank is not inside the board panel');
    if (!report.placement.eqAboveBoard) report.errors.push('fader bank is not above the keyboard');
    if (!report.placement.playingBesideBoard) report.errors.push('playing list is not beside the keyboard');
    if (!report.placement.playingSameRow) report.errors.push('playing list is on a different row from the keyboard');
    if (!report.visuals.eqPresent) report.errors.push('equalizer bank missing');
    if (report.visuals.eqBands < 8) report.errors.push('equalizer has too few bands');
    if (!/^[1-9]/.test(report.visuals.eqCss)) report.errors.push('equalizer canvas has no size');
    if (!/^[1-9]/.test(report.visuals.eqBacking)) report.errors.push('equalizer canvas has no backing store');
    if (!report.visuals.playingPanelPresent) report.errors.push('playing-now panel missing');
    if (report.visuals.playingRowsIdle !== 0) report.errors.push('playing list is not empty at rest');
    if (!report.visuals.playingHintIdle) report.errors.push('playing list shows no idle hint');
    if (report.picker.shellDialogBridges.length) {
      report.errors.push(`bridge to a shell open dialog is exposed: ${report.picker.shellDialogBridges.join(', ')}`);
    }
    if (report.picker.fileInput.type !== 'file' || !report.picker.fileInput.multiple
      || !report.picker.fileInput.hidden || !report.picker.fileInput.accept.includes('.wav')
      || !report.picker.fileInput.directory) {
      report.errors.push('renderer file picker is not configured as expected');
    }
    if (report.picker.leftoverInputs) report.errors.push('file picker inputs left in the DOM');

    // Typography: one family, all faces live, nothing else named.
    if (report.typography.faceRuleCount === 0) report.errors.push('no @font-face rules loaded');
    if (!report.typography.allFacesLoaded) {
      const missing = Object.entries(report.typography.faceLoaded).filter(([, ok]) => !ok).map(([k]) => k);
      report.errors.push(`font faces did not load: ${missing.join(', ')}`);
    }
    const foreignFamilies = report.typography.declaredFamilies.filter((f) => f !== UI_FONT);
    if (foreignFamilies.length) {
      report.errors.push(`other font families are specified: ${foreignFamilies.join(', ')}`);
    }
    for (const [where, value] of [['body', report.typography.bodyFontFamily], ['keycap', report.typography.keyCapFontFamily]]) {
      if (value && !value.includes(UI_FONT)) {
        report.errors.push(`${where} does not use ${UI_FONT}: ${value}`);
      }
    }
    if (report.chrome.topbarOverflowPx > 2) {
      report.errors.push(`top bar overflows by ${report.chrome.topbarOverflowPx}px at ${report.chrome.viewport}`);
    }
    if (report.chrome.pageOverflowPx > 2) {
    if (report.chrome.statusbarOverflowPx > 2) {
      report.errors.push(`status bar overflows by ${report.chrome.statusbarOverflowPx}px at ${report.chrome.viewport}`);
    }
      report.errors.push(`page overflows horizontally by ${report.chrome.pageOverflowPx}px at ${report.chrome.viewport}`);
    }
    if (!report.wave.placeholderDrawn) report.errors.push('waveform canvas has no backing store');
    if (!report.wave.canvasWidth || !report.wave.canvasHeight) report.errors.push('waveform canvas has no size');
    if (!mutedRefusals.noSlotForEscape || !mutedRefusals.noNewSlots || !mutedRefusals.triggerRefused
      || !mutedRefusals.slotCodesExcludeMuted) {
      report.errors.push('muted keys accepted a slot assignment');
    }
    if (!report.geometry.arrowGeometry.upOverDown) report.errors.push('ArrowUp is not above ArrowDown');
    if (!report.geometry.arrowGeometry.rightIsLastColumn) report.errors.push('ArrowRight is not the last column');

    return report;
  }

  window.addEventListener('error', (ev) => {
    errors.push(`${ev.message} @ ${ev.filename}:${ev.lineno}`);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    errors.push(`unhandled rejection: ${ev.reason && ev.reason.message ? ev.reason.message : ev.reason}`);
  });

  window.addEventListener('DOMContentLoaded', async () => {
    try {
      await boot();
    } catch (err) {
      errors.push(`boot failed: ${err.message}`);
      console.error('[HotSound] boot failed', err);
    }

    if (app && app.isSmokeTest) {
      try {
        const report = await smokeTest();
        app.reportSmoke(report);
      } catch (err) {
        app.reportSmoke({ errors: [`smoke crashed: ${err.message}`] });
      }
    }
  });

  HS.app = {
    state,
    engine,
    layout,
    getWave: () => wave,
    getEq: () => eq,
    getPlaying: () => playing,
    triggerSlot,
    assignPaths,
    removeFromSlot,
    preloadSlot,
    preloadAll,
    loadFolder,
    previewSlot,
    saveProfileAs,
    openProfile,
    pickFiles,
    createFileInput,
    audioAccept: AUDIO_ACCEPT,
    saveProfile,
    activeProfile: () => activeProfilePath,
    canBeGlobal,
    refreshKey,
    refreshAll
  };
})(window.HS);
