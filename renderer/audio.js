'use strict';

/**
 * HotSound playback engine.
 *
 * Decoded samples are cached as AudioBuffers and played through a small graph:
 *
 *   source -> slotGain -> bus(master) -> destination
 *
 * A source is created per trigger so the same slot can overlap with itself,
 * which is what a soundboard needs (retriggering a snare must not cut the tail).
 */
window.HS = window.HS || {};

(function () {
  const HS = window.HS;

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.analyser = null;
      this._freq = null;
      this.cache = new Map(); // filePath -> AudioBuffer
      this.loading = new Map(); // filePath -> Promise<AudioBuffer>
      this.voices = new Set();
      this.masterVolume = 0.9;
      this.onVoiceChange = null;
    }

    ensureContext() {
      if (this.ctx) return this.ctx;
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVolume;
      // The visualiser reads the finished mix, so the faders follow what you hear,
      // master volume included. Pass-through: no audible effect on the output.
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.6;
      this._freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.master.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      return this.ctx;
    }

    async resume() {
      this.ensureContext();
      if (this.ctx.state === 'suspended') {
        try {
          await this.ctx.resume();
        } catch {
          /* device may be unavailable; trigger() reports the real failure */
        }
      }
      return this.ctx.state;
    }

    setMasterVolume(value) {
      this.masterVolume = Math.max(0, Math.min(1.5, Number(value) || 0));
      if (this.master) {
        this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.01);
      }
    }

    /** Bytes -> AudioBuffer, cached by source path. */
    async load(filePath, bytes) {
      if (this.cache.has(filePath)) return this.cache.get(filePath);
      if (this.loading.has(filePath)) return this.loading.get(filePath);

      const ctx = this.ensureContext();
      const job = (async () => {
        // decodeAudioData detaches the buffer it is given, so hand it a copy and
        // keep the original intact for a retry after a failed decode.
        const copy = bytes.slice(0).buffer;
        const buffer = await ctx.decodeAudioData(copy);
        this.cache.set(filePath, buffer);
        return buffer;
      })().finally(() => this.loading.delete(filePath));

      this.loading.set(filePath, job);
      return job;
    }

    has(filePath) {
      return this.cache.has(filePath);
    }

    unload(filePath) {
      this.cache.delete(filePath);
    }

    /**
     * Trigger a slot.
     * @param {object} slot  slot state ({path, volume, loop, rate, pan})
     * @param {object} opts  { loop?: boolean }
     * @returns {Promise<boolean>} whether audio actually started
     */
    async trigger(slot, opts = {}) {
      if (!slot || !slot.path) return false;
      let buffer = this.cache.get(slot.path);
      if (!buffer) {
        const res = await window.hotsound.readAudio(slot.path);
        if (!res || !res.ok) {
          throw new Error(`Cannot read ${slot.path}: ${(res && res.error) || 'unknown error'}`);
        }
        buffer = await this.load(slot.path, new Uint8Array(res.data));
      }

      await this.resume();
      const ctx = this.ctx;
      const now = ctx.currentTime;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = opts.loop != null ? !!opts.loop : !!slot.loop;
      if (slot.rate) src.playbackRate.value = slot.rate;

      const gain = ctx.createGain();
      const attack = Math.max(0.001, slot.attack || 0.002);
      const target = Math.max(0, Math.min(1.5, slot.volume == null ? 1 : slot.volume));
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, target), now + attack);

      let tail = gain;
      if (slot.pan != null && ctx.createStereoPanner) {
        const panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, slot.pan));
        gain.connect(panner);
        tail = panner;
      }
      tail.connect(this.master);
      src.connect(gain);

      const voice = {
        id: Symbol('voice'),
        source: src,
        gain,
        slot,
        startedAt: now,
        duration: buffer.duration / (slot.rate || 1),
        stop: null
      };
      voice.stop = (fadeSeconds = 0.02) => {
        const t = ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + fadeSeconds);
        try {
          src.stop(t + fadeSeconds + 0.01);
        } catch {
          /* already stopped */
        }
      };

      src.onended = () => {
        this.voices.delete(voice);
        try {
          src.disconnect();
          gain.disconnect();
        } catch {
          /* ignore */
        }
        this._notifyVoices();
      };

      src.start(now);
      this.voices.add(voice);
      this._notifyVoices();
      return true;
    }

    /** Report the voice count plus which slots are currently sounding. */
    _notifyVoices() {
      if (!this.onVoiceChange) return;
      const codes = new Set();
      for (const v of this.voices) if (v.slot && v.slot.code) codes.add(v.slot.code);
      this.onVoiceChange(this.voices.size, codes);
    }

    /** Fade out every voice (Stop all / panic). */
    stopAll(fadeSeconds = 0.03) {
      for (const voice of [...this.voices]) {
        try {
          voice.stop(fadeSeconds);
        } catch {
          /* ignore */
        }
      }
      return this.voices.size;
    }

    /** Voices for one slot code, used by the "stop slot" affordance. */
    stopSlot(code) {
      let n = 0;
      for (const voice of [...this.voices]) {
        if (voice.slot && voice.slot.code === code) {
          try {
            voice.stop(0.02);
            n++;
          } catch {
            /* ignore */
          }
        }
      }
      return n;
    }

    voiceCountFor(code) {
      let n = 0;
      for (const voice of this.voices) if (voice.slot && voice.slot.code === code) n++;
      return n;
    }

    activeVoiceCount() {
      return this.voices.size;
    }
    /** One entry per sounding voice, for the "playing keys" list. */
    activeVoices() {
      const out = [];
      for (const v of this.voices) {
        if (!v.slot || !v.slot.code) continue;
        out.push({
          code: v.slot.code,
          startedAt: v.startedAt,
          duration: v.duration,
          loop: !!v.source.loop
        });
      }
      return out;
    }
    /**
     * Frequency levels, 0..1 per band, log-spaced so the low end is not squashed into
     * one fader. Returns `bands` numbers; all zero before the context exists.
     */
    spectrum(bands = 16) {
      const levels = new Array(bands).fill(0);
      if (!this.analyser || !this._freq) return levels;
      this.analyser.getByteFrequencyData(this._freq);
      const bins = this._freq.length;
      const nyquist = (this.ctx ? this.ctx.sampleRate : 48000) / 2;
      const lowHz = 45;
      const highHz = Math.min(16000, nyquist);
      for (let b = 0; b < bands; b++) {
        const f0 = lowHz * Math.pow(highHz / lowHz, b / bands);
        const f1 = lowHz * Math.pow(highHz / lowHz, (b + 1) / bands);
        const from = Math.floor((f0 / nyquist) * bins);
        if (from >= bins) continue;
        const to = Math.min(bins, Math.max(from + 1, Math.ceil((f1 / nyquist) * bins)));
        let peak = 0;
        for (let i = from; i < to; i++) if (this._freq[i] > peak) peak = this._freq[i];
        levels[b] = peak / 255;
      }
      return levels;
    }
  }

  HS.AudioEngine = AudioEngine;
})();
