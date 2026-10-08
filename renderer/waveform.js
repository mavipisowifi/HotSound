'use strict';

/**
 * Waveform preview.
 *
 * Draws the peaks of the sample that is loaded/playing, with a playhead driven by
 * the AudioContext clock rather than by frame deltas, so the sweep stays in step
 * with what you hear even if frames are late.
 *
 * The peak envelope is computed once per decoded buffer and rendered once per
 * canvas size into an offscreen bitmap; each frame then only blits that bitmap
 * (once dim, once clipped to the played region), which keeps the cost flat no
 * matter how long the file is.
 */
window.HS = window.HS || {};

(function (HS) {
  const BUCKETS = 1400;
  const BG = '#0a1710';
  const WAVE_OFF = 'rgba(143, 224, 182, 0.30)';
  const WAVE_ON = '#8fe0b6';
  const AXIS = 'rgba(187, 234, 204, 0.16)';
  const HEAD = '#f4ffe9';

  class WaveformView {
    constructor(canvas, engine, { onChange, fontFamily = 'Google Sans' } = {}) {
      this.canvas = canvas;
      this.g = canvas.getContext('2d');
      this.engine = engine;
      this.onChange = onChange || null;
      this.fontFamily = fontFamily;
      this.peakCache = new WeakMap();
      this.state = null;
      this.raf = null;
      this._sprite = null; // { buffer, w, h, canvas }
      this.placeholder = 'Click an empty key to add music';
    }

    /** Min/max envelope of the buffer, averaged across channels. */
    peaks(buffer) {
      let cached = this.peakCache.get(buffer);
      if (cached) return cached;

      const chA = buffer.getChannelData(0);
      const chB = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
      const total = chA.length;
      const n = Math.max(1, Math.min(BUCKETS, total));
      const mins = new Float32Array(n);
      const maxs = new Float32Array(n);
      const per = total / n;

      for (let i = 0; i < n; i++) {
        const start = Math.floor(i * per);
        const end = Math.min(total, Math.max(start + 1, Math.floor((i + 1) * per)));
        let mn = 1;
        let mx = -1;
        for (let j = start; j < end; j++) {
          const v = chB ? (chA[j] + chB[j]) * 0.5 : chA[j];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        mins[i] = mn === 1 ? 0 : mn;
        maxs[i] = mx === -1 ? 0 : mx;
      }

      cached = { mins, maxs, n };
      this.peakCache.set(buffer, cached);
      return cached;
    }

    /** Show a buffer without playing: the "what have I loaded" preview. */
    show({ code, label, name, buffer, rate = 1, loop = false }) {
      if (!buffer) {
        this.clear();
        return;
      }
      this.state = {
        code,
        label,
        name,
        buffer,
        peaks: this.peaks(buffer),
        duration: buffer.duration / (rate || 1),
        startedAt: null,
        loop,
        playing: false,
        progress: 0
      };
      this._sprite = null;
      this._frame();
    }

    /** Start (or restart) the sweep for the currently shown buffer. */
    play() {
      const st = this.state;
      if (!st || !this.engine.ctx) return;
      st.startedAt = this.engine.ctx.currentTime;
      st.playing = true;
      st.progress = 0;
      this._loop();
    }

    clear() {
      this.state = null;
      if (this.raf != null) {
        cancelAnimationFrame(this.raf);
        this.raf = null;
      }
      this._frame();
    }

    isShowing(code) {
      return !!(this.state && this.state.code === code);
    }
    /**
     * Stop the sweep, keeping the sample on screen as a preview again.
     *
     * Used when the sound is stopped rather than finishing: without this the playhead
     * carries on to the end of the sample, so a stopped sound still looks like it is
     * playing.
     */
    stop() {
      const st = this.state;
      if (this.raf != null) {
        cancelAnimationFrame(this.raf);
        this.raf = null;
      }
      if (!st) {
        this._frame();
        return;
      }
      st.playing = false;
      st.startedAt = null;
      st.progress = 0;
      this._frame();
    }

    /** True while the playhead is sweeping. */
    /** Follow a slot's loop setting, so the sweep wraps when the sound repeats. */
    setLoop(loop) {
      if (!this.state) return;
      this.state.loop = !!loop;
      this._frame();
    }

    isPlaying() {
      return !!(this.state && this.state.playing);
    }


    /** Current playback position as 0..1, or null when nothing is playing. */
    progress() {
      const st = this.state;
      if (!st || st.startedAt == null || !this.engine.ctx) return null;
      const elapsed = this.engine.ctx.currentTime - st.startedAt;
      const d = Math.max(0.0001, st.duration);
      if (st.loop) return (elapsed % d) / d;
      if (elapsed >= d) return 1;
      return elapsed / d;
    }

    _loop() {
      if (this.raf != null) cancelAnimationFrame(this.raf);
      const tick = () => {
        const st = this.state;
        if (!st || !st.playing) {
          this.raf = null;
          this._frame();
          return;
        }
        const p = this.progress();
        st.progress = p == null ? 0 : p;
        if (!st.loop && p != null && p >= 1) {
          st.playing = false;
          this.raf = null;
          this._frame();
          return;
        }
        this._frame();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }

    /** Size the backing store to the device pixel grid. */
    _resize() {
      const c = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(c.clientWidth * dpr));
      const h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
        this._sprite = null;
      }
      return { w, h, dpr };
    }

    /** The waveform bitmap, rendered once per (buffer, size). */
    _spriteFor(w, h) {
      const st = this.state;
      if (!st) return null;
      if (this._sprite && this._sprite.buffer === st.buffer && this._sprite.w === w && this._sprite.h === h) {
        return this._sprite.canvas;
      }
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const g = off.getContext('2d');
      const { mins, maxs, n } = st.peaks;
      const mid = h / 2;
      const amp = h * 0.44;
      const barW = w / n;
      g.fillStyle = WAVE_ON;
      for (let i = 0; i < n; i++) {
        const x = i * barW;
        const top = mid - maxs[i] * amp;
        const bot = mid - mins[i] * amp;
        g.fillRect(x, top, Math.max(barW * 0.74, 1), Math.max(bot - top, 1));
      }
      this._sprite = { buffer: st.buffer, w, h, canvas: off };
      return off;
    }

    _frame() {
      const { w, h, dpr } = this._resize();
      const g = this.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = BG;
      g.fillRect(0, 0, w, h);

      const mid = Math.round(h / 2) + 0.5;
      g.strokeStyle = AXIS;
      g.lineWidth = Math.max(1, Math.round(dpr * 0.5));
      g.beginPath();
      g.moveTo(0, mid);
      g.lineTo(w, mid);
      g.stroke();

      if (!this.state) {
        g.fillStyle = 'rgba(159, 179, 168, 0.75)';
        g.font = `${Math.round(13 * dpr)}px "${this.fontFamily}"`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(this.placeholder, w / 2, h / 2);
        if (this.onChange) this.onChange(null, null);
        return;
      }

      const sprite = this._spriteFor(w, h);
      if (!sprite) return;
      const p = this.state.playing ? this.progress() : this.state.progress;

      // Unplayed portion drawn dim, then the played portion drawn at full
      // strength clipped at the playhead.
      g.globalAlpha = 0.32;
      g.drawImage(sprite, 0, 0);
      g.globalAlpha = 1;

      if (p != null && p > 0) {
        const headX = Math.max(0, Math.min(w, p * w));
        g.save();
        g.beginPath();
        g.rect(0, 0, headX, h);
        g.clip();
        g.drawImage(sprite, 0, 0);
        g.restore();
        if (this.state.playing) {
          g.strokeStyle = HEAD;
          g.lineWidth = Math.max(1, Math.round(dpr));
          g.beginPath();
          g.moveTo(Math.round(headX) + 0.5, 0);
          g.lineTo(Math.round(headX) + 0.5, h);
          g.stroke();
        }
      }

      if (this.onChange) this.onChange(this.state, p);
    }

    /** Force a redraw on the next frame (used after a resize). */
    invalidate() {
      this._sprite = null;
      this._frame();
    }
  }

  HS.WaveformView = WaveformView;
})(window.HS);
