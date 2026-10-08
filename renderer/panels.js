'use strict';

/**
 * UI panels that visualise playback.
 *
 * Two self-contained pieces, kept out of app.js because each owns its own render
 * loop and neither needs to know about slot state:
 *
 *   createEqBank       the equalizer faders above the board, driven by the audio
 *                      engine's analyser, so they follow what you actually hear
 *   createPlayingList  one row per sounding key, added when a key starts and
 *                      removed when its sound ends
 *
 * Both take what they need as arguments, so they can be driven in a test without
 * the rest of the app.
 */
window.HS = window.HS || {};

(function (HS) {
  const EQ_BANDS = 18;

  /**
   * A bank of vertical faders, one per frequency band.
   *
   * Levels use a fast attack and a slow release: that asymmetry is what makes them
   * read as faders settling rather than bars flickering with the waveform. A peak
   * line hangs above each one, as on a channel strip.
   */
  function createEqBank({ canvas, engine, bands = EQ_BANDS }) {
    const g = canvas.getContext('2d');
    const levels = new Array(bands).fill(0);
    const peaks = new Array(bands).fill(0);
    let size = { w: 0, h: 0, dpr: 1 };
    let idlePainted = false;
    let raf = null;

    function rounded(x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      g.beginPath();
      g.moveTo(x + rr, y);
      g.arcTo(x + w, y, x + w, y + h, rr);
      g.arcTo(x + w, y + h, x, y + h, rr);
      g.arcTo(x, y + h, x, y, rr);
      g.arcTo(x, y, x + w, y, rr);
      g.closePath();
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        idlePainted = false; // repaint at the new size even when silent
      }
      size = { w, h, dpr };
    }

    function draw() {
      const { w, h, dpr } = size;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, h);

      const gap = (w / bands) * 0.34;
      const barW = (w - gap * (bands - 1)) / bands;
      const knobH = Math.max(3, Math.round(3.2 * dpr));
      const radius = Math.max(1.5, barW * 0.18);
      const top = Math.round(h * 0.06);
      const bottom = h - Math.round(h * 0.04);
      const track = bottom - top;

      for (let b = 0; b < bands; b++) {
        const x = b * (barW + gap);

        // groove
        g.fillStyle = 'rgba(0, 0, 0, 0.45)';
        rounded(x, top, barW, track, radius);
        g.fill();
        g.strokeStyle = 'rgba(187, 234, 204, 0.08)';
        g.lineWidth = Math.max(1, dpr * 0.5);
        rounded(x + 0.5, top + 0.5, barW - 1, track - 1, radius);
        g.stroke();

        // filled part, brighter at the head
        const level = Math.max(0, Math.min(1, levels[b]));
        const fillH = Math.round(track * level);
        if (fillH > 1) {
          const y = bottom - fillH;
          const grad = g.createLinearGradient(0, y, 0, bottom);
          grad.addColorStop(0, '#bbeacc');
          grad.addColorStop(1, '#3f7f66');
          g.fillStyle = grad;
          rounded(x, y, barW, fillH, radius);
          g.fill();
        }

        // the fader knob, and a peak line above it
        const knobY = Math.max(top, bottom - fillH - knobH / 2);
        g.fillStyle = level > 0.02 ? '#eafff2' : 'rgba(187, 234, 204, 0.32)';
        rounded(x - barW * 0.08, knobY, barW * 1.16, knobH, knobH / 2);
        g.fill();
        g.fillStyle = 'rgba(12, 30, 22, 0.8)';
        g.fillRect(x - barW * 0.08, Math.round(knobY + knobH / 2), barW * 1.16, Math.max(1, dpr * 0.5));

        if (peaks[b] > 0.02) {
          const peakY = bottom - Math.round(track * Math.min(1, peaks[b]));
          g.fillStyle = 'rgba(244, 255, 233, 0.55)';
          g.fillRect(x, Math.max(top, peakY - 1), barW, Math.max(1, dpr));
        }
      }
    }

    function frame() {
      resize();
      const raw = engine.spectrum ? engine.spectrum(bands) : null;
      let busy = false;
      for (let b = 0; b < bands; b++) {
        const target = raw ? raw[b] : 0;
        const current = levels[b];
        levels[b] = current + (target - current) * (target > current ? 0.45 : 0.07);
        peaks[b] = Math.max(peaks[b] - 0.012, levels[b]);
        if (levels[b] > 0.004 || peaks[b] > 0.01) busy = true;
      }
      // Silent and settled: paint once, then stop repainting until something moves.
      if (busy || !idlePainted) draw();
      idlePainted = !busy;
      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);

    return {
      bands,
      /** Levels currently drawn, for tests and diagnostics. */
      levels: () => levels.slice(),
      redraw() {
        resize();
        draw();
      },
      stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
      }
    };
  }

  /**
   * The "playing now" list: one row per sounding key.
   *
   * `describe(code)` supplies the row's content (label, title, zone colour, loop
   * flag), so this module never has to know how slots are stored.
   */
  function createPlayingList({ list, count, engine, describe, formatTime, max = 14 }) {
    const rows = new Map(); // code -> { el, timeEl, barEl }
    let timer = null;

    function emptyState(show) {
      let hint = list.querySelector('.playing-empty');
      if (show && !hint) {
        hint = document.createElement('div');
        hint.className = 'playing-empty';
        hint.textContent = 'Press a key, or click one, and its sound shows up here.';
        list.appendChild(hint);
      } else if (!show && hint) {
        hint.remove();
      }
    }

    function buildRow(code) {
      const info = describe(code) || {};
      const el = document.createElement('div');
      el.className = 'playing-row';
      el.dataset.code = code;
      if (info.fill) el.style.setProperty('--zone-fill', info.fill);

      const top = document.createElement('div');
      top.className = 'playing-top';

      const keyEl = document.createElement('span');
      keyEl.className = 'playing-key';
      keyEl.textContent = info.label || code;

      const nameEl = document.createElement('span');
      nameEl.className = 'playing-name';
      nameEl.textContent = info.title || 'sound';
      nameEl.title = info.title || '';

      top.append(keyEl, nameEl);

      if (info.loop) {
        const loopEl = document.createElement('span');
        loopEl.className = 'playing-loop';
        loopEl.textContent = '\u21bb';
        top.appendChild(loopEl);
      }

      const timeEl = document.createElement('div');
      timeEl.className = 'playing-time';

      const barEl = document.createElement('div');
      barEl.className = 'playing-bar';
      barEl.style.width = '0%';

      el.append(top, timeEl, barEl);
      return { el, timeEl, barEl };
    }

    /** Advance the readouts of the rows already on screen. */
    function tick() {
      const now = engine.ctx ? engine.ctx.currentTime : 0;
      for (const code of [...rows.keys()]) {
        const row = rows.get(code);
        const voices = engine.activeVoices().filter((v) => v.code === code);
        if (!voices.length) continue;
        // The most recent trigger drives the readout, so a retrigger restarts it.
        const v = voices.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
        const dur = Math.max(0.0001, v.duration);
        let elapsed = now - v.startedAt;
        if (v.loop) elapsed %= dur;
        elapsed = Math.min(elapsed, dur);
        row.timeEl.textContent = `${formatTime(elapsed)} / ${formatTime(dur)}`;
        row.barEl.style.width = `${((elapsed / dur) * 100).toFixed(1)}%`;
      }
    }

    function startTimer() {
      if (timer) return;
      timer = setInterval(tick, 120);
      tick();
    }

    function stopTimer() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }

    /** Reconcile the list with the keys the engine reports as sounding. */
    function sync() {
      const active = new Set();
      for (const v of engine.activeVoices()) active.add(v.code);

      for (const [code, row] of [...rows]) {
        if (active.has(code)) continue;
        rows.delete(code);
        row.el.classList.add('leaving');
        const el = row.el;
        setTimeout(() => el.remove(), 220);
      }

      // Newest first, so a fresh press is at the top where you look.
      for (const code of active) {
        if (rows.has(code)) continue;
        const row = buildRow(code);
        rows.set(code, row);
        list.insertBefore(row.el, list.firstChild);
      }

      // Bounded: a long session with many keys cannot grow the list forever.
      while (rows.size > max) {
        const oldest = [...rows.keys()][rows.size - 1];
        rows.get(oldest).el.remove();
        rows.delete(oldest);
      }

      const n = rows.size;
      count.textContent = n === 0 ? 'idle' : `${n} playing`;
      emptyState(n === 0);
      if (n) startTimer();
      else stopTimer();
    }

    return {
      sync,
      tick,
      count: () => rows.size,
      codes: () => [...rows.keys()],
      stop() {
        stopTimer();
      }
    };
  }

  HS.Panels = { createEqBank, createPlayingList, EQ_BANDS };
})(window.HS);
