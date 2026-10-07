'use strict';

/**
 * Diagnostic: how much memory does loading music actually take?
 *
 * The engine caches every decoded sample as an AudioBuffer keyed by path. Both
 * "Load folder" and the first trigger of a slot populate that cache, and nothing
 * ever evicts it. This measures the real cost in a running app: working set before
 * and after decoding N one-minute files, what the cache holds afterwards, and
 * whether taking the music back off the keys releases any of it.
 *
 * Run with: electron . --diagnose-memory
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/** One minute of 44.1kHz stereo 16-bit PCM: ~10.6 MB on disk, ~21 MB decoded. */
function writeWav(filePath, seconds = 60, rate = 44100) {
  const samples = Math.floor(seconds * rate);
  const channels = 2;
  const dataBytes = samples * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const env = Math.min(1, i / 2000) * Math.max(0, 1 - i / samples);
    const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 11000 * env);
    buf.writeInt16LE(v, 44 + i * channels * 2);
    buf.writeInt16LE(v, 44 + i * channels * 2 + 2);
  }
  fs.writeFileSync(filePath, buf);
  return buf.length;
}

function rssMb() {
  const metrics = app.getAppMetrics();
  let total = 0;
  const per = [];
  for (const m of metrics) {
    const mb = (m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) / 1024;
    total += mb;
    per.push(`${m.type}:${mb.toFixed(0)}MB`);
  }
  return { total: Math.round(total), per: per.join(' ') };
}

async function run(win) {
  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) resolve();
    else win.webContents.once('did-finish-load', resolve);
  });
  await new Promise((r) => setTimeout(r, 1500));

  const COUNT = 10;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hotsound-mem-'));
  let bytesOnDisk = 0;
  const files = [];
  for (let i = 0; i < COUNT; i++) {
    const p = path.join(tmp, `song-${i}.wav`);
    bytesOnDisk += writeWav(p, 60);
    files.push(p);
  }

  const keys = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'];
  const baseline = rssMb();

  console.log('Decoded-audio memory diagnostic');
  console.log('===============================');
  console.log(`files: ${COUNT} x 60s stereo (${(bytesOnDisk / 1048576).toFixed(1)} MB on disk)`);
  console.log(`baseline working set: ${baseline.total} MB   [${baseline.per}]`);

  await win.webContents.executeJavaScript(
    `(async () => {
       const HS = window.HS;
       const files = ${JSON.stringify(files)};
       const keys = ${JSON.stringify(keys)};
       keys.forEach((code, i) => {
         const s = HS.app.state.slots[code] || { code };
         Object.assign(s, { code, path: files[i], name: 'song-' + i + '.wav', volume: 1, rate: 1, pan: 0, loop: false, global: false, error: '' });
         HS.app.state.slots[code] = s;
       });
       HS.app.refreshAll();
     })()`,
    true
  );

  await win.webContents.executeJavaScript('window.HS.app.preloadAll()', true);
  await new Promise((r) => setTimeout(r, 2500));
  const afterLoad = rssMb();

  const cacheInfo = await win.webContents.executeJavaScript(
    `(() => {
       const cache = window.HS.app.engine.cache;
       let bytes = 0;
       const detail = [];
       for (const [p, buf] of cache) {
         const b = buf.length * buf.numberOfChannels * 4;
         bytes += b;
         detail.push((p.split(/[\\\\/]/).pop()) + '=' + (b / 1048576).toFixed(1) + 'MB');
       }
       return { entries: cache.size, bytes, detail: detail.slice(0, 3) };
     })()`,
    true
  );

  console.log(`after loading:   ${afterLoad.total} MB   (+${afterLoad.total - baseline.total} MB)   [${afterLoad.per}]`);
  console.log(`cache holds: ${cacheInfo.entries} buffers = ${(cacheInfo.bytes / 1048576).toFixed(1)} MB decoded`);
  console.log(`  e.g. ${cacheInfo.detail.join('  ')}`);

  // Take the music back off every key and see whether anything is released.
  await win.webContents.executeJavaScript(
    `(() => { for (const k of ${JSON.stringify(keys)}) window.HS.app.removeFromSlot(k); })()`,
    true
  );
  await new Promise((r) => setTimeout(r, 2500));
  const afterRemove = rssMb();
  const cacheAfter = await win.webContents.executeJavaScript(
    '(() => { const c = window.HS.app.engine.cache; let b = 0; for (const [, buf] of c) b += buf.length * buf.numberOfChannels * 4; return { entries: c.size, bytes: b }; })()',
    true
  );

  console.log(`after removing all music from the keys: ${afterRemove.total} MB   (${afterRemove.total - afterLoad.total} MB released)`);
  console.log(`cache still holds: ${cacheAfter.entries} buffers = ${(cacheAfter.bytes / 1048576).toFixed(1)} MB`);

  const perMinuteMb = cacheInfo.bytes / 1048576 / COUNT;
  console.log('');
  console.log('Extrapolation');
  console.log('-------------');
  console.log(`one minute of stereo audio decodes to ${perMinuteMb.toFixed(0)} MB and stays resident`);
  for (const mins of [3, 4]) {
    const perSong = perMinuteMb * mins;
    console.log(`a ${mins}-minute song: ${perSong.toFixed(0)} MB   x 63 keys = ${(perSong * 63 / 1024).toFixed(1)} GB`);
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  console.log('');
  console.log(rssMb().total > baseline.total ? 'RESULT: resident memory grows with loaded music and is not released' : 'RESULT: no growth observed');
  app.exit(0);
}

module.exports = { run };
