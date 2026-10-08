'use strict';

/**
 * Latency measurements for the playing path.
 *
 * Reports two different things, which are easy to confuse:
 *
 *  - how long the app takes to *schedule* a hit, i.e. the synchronous work between
 *    the key press and the moment the source is started. This is what the app
 *    controls, and what makes a drum roll feel sluggish when it grows.
 *  - the audio device latency the browser reports, which is inherent to the output
 *    path and cannot be fixed from JavaScript.
 *
 * Run with: electron . --measure-latency
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function writeWav(filePath, seconds = 0.2, rate = 44100) {
  const samples = Math.floor(seconds * rate);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const env = Math.max(0, 1 - i / samples);
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 200 * i) / rate) * 12000 * env), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    min: +sorted[0].toFixed(2),
    median: +at(0.5).toFixed(2),
    p90: +at(0.9).toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2)
  };
}

async function run(win) {
  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) resolve();
    else win.webContents.once('did-finish-load', resolve);
  });
  await new Promise((r) => setTimeout(r, 1200));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hotsound-lat-'));
  const files = [];
  for (let i = 0; i < 6; i++) files.push(writeWav(path.join(tmp, `hit-${i}.wav`), 0.2));

  const result = await win.webContents.executeJavaScript(
    `(async () => {
       const HS = window.HS;
       const engine = HS.app.engine;
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const files = ${JSON.stringify(files)};
       const keys = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH'];

       keys.forEach((code, i) => {
         const slot = HS.app.state.slots[code] || { code };
         Object.assign(slot, { code, path: files[i], name: 'hit-' + i + '.wav', volume: 1, rate: 1, pan: 0, loop: false, global: false, error: '' });
         HS.app.state.slots[code] = slot;
       });

       const out = { context: {}, cold: null, warm: [], burst: [] };

       // Cold: the very first hit, before the device has been opened and the sample
       // has been decoded.
       let t0 = performance.now();
       await HS.app.triggerSlot('KeyA');
       out.cold = +(performance.now() - t0).toFixed(2);
       await sleep(300);

       const ctx = engine.ctx;
       out.context = {
         state: ctx.state,
         sampleRate: ctx.sampleRate,
         baseLatencyMs: ctx.baseLatency != null ? +(ctx.baseLatency * 1000).toFixed(2) : null,
         outputLatencyMs: ctx.outputLatency != null ? +(ctx.outputLatency * 1000).toFixed(2) : null,
         state01: Math.round(ctx.currentTime * 100) / 100
       };

       // Warm: every hit takes the same path as a drum roll would. The number that
       // matters is 'schedule' - the synchronous work before the source is started.
       for (let i = 0; i < 40; i++) {
         const code = keys[i % keys.length];
         const start = performance.now();
         const pending = HS.app.triggerSlot(code);
         const scheduled = performance.now() - start;   // audio was started inside here
         await pending;
         const total = performance.now() - start;
         out.warm.push({ schedule: +scheduled.toFixed(2), total: +total.toFixed(2) });
         await sleep(25);
       }

       // Burst: ten hits as fast as the main thread will take them, which is what a
       // fast roll does.
       const burstStart = performance.now();
       const pending = [];
       for (let i = 0; i < 10; i++) {
         const t = performance.now();
         pending.push(HS.app.triggerSlot(keys[i % keys.length]));
         out.burst.push(+(performance.now() - t).toFixed(2));
       }
       await Promise.all(pending);
       out.burstTotal = +(performance.now() - burstStart).toFixed(2);

       engine.stopAll(0.01);
       return out;
     })()`,
    true
  );

  // What the device actually gives us for different latency requests. This decides
  // whether the hint is worth changing at all.
  const hints = await win.webContents.executeJavaScript(
    `(async () => {
       const out = [];
       for (const hint of ['interactive', 'balanced', 'playback', 0.003, 0.01, 0.02, 0.05]) {
         try {
           const ctx = new AudioContext({ latencyHint: hint });
           await ctx.resume();
           await new Promise((r) => setTimeout(r, 250));
           out.push({
             hint: String(hint),
             base: ctx.baseLatency != null ? +(ctx.baseLatency * 1000).toFixed(1) : null,
             output: ctx.outputLatency != null ? +(ctx.outputLatency * 1000).toFixed(1) : null,
             rate: ctx.sampleRate
           });
           await ctx.close();
         } catch (err) {
           out.push({ hint: String(hint), error: err.message });
         }
       }
       return out;
     })()`,
    true
  );

  console.log('Latency measurements');
  console.log('====================');
  console.log('latencyHint -> device latency (ms):');
  for (const h of hints) {
    if (h.error) console.log(`  ${h.hint.padEnd(12)} error: ${h.error}`);
    else {
      const total = (h.base || 0) + (h.output || 0);
      console.log(`  ${h.hint.padEnd(12)} base ${String(h.base).padStart(5)}  output ${String(h.output).padStart(5)}  total ${total.toFixed(1)} ms  @${h.rate}Hz`);
    }
  }
  console.log('');
  console.log('context:', JSON.stringify(result.context));
  const sched = stats(result.warm.map((w) => w.schedule));
  const total = stats(result.warm.map((w) => w.total));
  console.log(`first hit, nothing warm  : ${result.cold} ms   (device open + decode)`);
  console.log(`schedule, 40 warm hits   : min ${sched.min}  median ${sched.median}  p90 ${sched.p90}  max ${sched.max} ms`);
  console.log(`whole call, 40 warm hits : min ${total.min}  median ${total.median}  p90 ${total.p90}  max ${total.max} ms`);
  const burst = stats(result.burst);
  console.log(`burst of 10, per hit     : min ${burst.min}  median ${burst.median}  p90 ${burst.p90}  max ${burst.max} ms`);
  console.log(`burst of 10, wall clock  : ${result.burstTotal} ms`);
  const device = (result.context.outputLatencyMs || 0) + (result.context.baseLatencyMs || 0);
  if (device > 0) {
    console.log(`audio device + graph     : ${device.toFixed(2)} ms  (not controllable from the app)`);
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  app.exit(0);
}

module.exports = { run };
