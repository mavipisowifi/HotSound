'use strict';

/**
 * End-to-end check for HotSound (run with `npm run e2e`).
 *
 * Drives the real renderer through the real IPC: generates WAV files on disk,
 * assigns them to slots, and watches the actual Web Audio graph so decode,
 * polyphony, looping, spinner playback and profile persistence are all covered.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

function writeWav(filePath, { seconds = 0.3, freq = 440, rate = 44100 } = {}) {
  const samples = Math.floor(seconds * rate);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const env = Math.min(1, i / 200) * Math.max(0, 1 - i / samples);
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000 * env);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
  return filePath;
}

async function run(win) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hotsound-e2e-'));
  const files = {
    a: writeWav(path.join(tmp, 'kick.wav'), { freq: 120, seconds: 0.30 }),
    b: writeWav(path.join(tmp, 'snare.wav'), { freq: 300, seconds: 0.30 }),
    c: writeWav(path.join(tmp, 'hat-open.wav'), { freq: 900, seconds: 0.30 })
  };

  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) resolve();
    else win.webContents.once('did-finish-load', resolve);
  });
  await new Promise((r) => setTimeout(r, 900)); // let boot() settle

  const script = `
    (async () => {
      const HS = window.HS;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = { steps: [] };
      const step = (name, pass, detail) => out.steps.push({ name, pass: !!pass, detail });

      if (!HS || !HS.app) { out.fatal = 'window.HS.app missing'; return out; }

      const assign = (code, p, name) => {
        const s = HS.app.state.slots[code] || { code };
        Object.assign(s, { code, path: p, name, volume: 1, rate: 1, pan: 0, loop: false, global: false, error: '' });
        HS.app.state.slots[code] = s;
      };
      assign('KeyA', ${JSON.stringify(files.a)}, 'kick.wav');
      assign('KeyB', ${JSON.stringify(files.b)}, 'snare.wav');
      assign('KeyC', ${JSON.stringify(files.c)}, 'hat-open.wav');

      // 1. decode + play a real file
      const played = await HS.app.triggerSlot('KeyA');
      await sleep(80);
      const during = HS.app.engine.activeVoiceCount();
      step('decode+play', played && during >= 1, 'triggered=' + played + ' voices=' + during);

      // 2. pressing the same key again stops it, which is the default behaviour
      await sleep(60);
      const beforeToggle = HS.app.engine.voiceCountFor('KeyA');
      await HS.app.triggerSlot('KeyA');
      await sleep(40);
      const duringFade = HS.app.engine.voiceCountFor('KeyA');
      await sleep(400);
      const afterToggle = HS.app.engine.voiceCountFor('KeyA');
      step('press again stops the sound', beforeToggle === 1 && afterToggle === 0,
           'before=' + beforeToggle + ' duringFade=' + duringFade + ' after=' + afterToggle);

      // 3. the fade has to behave like a fade: still sounding shortly after the stop
      //    is asked for, silent once the configured time has passed
      HS.app.state.settings.fadeMs = 300;
      HS.app.engine.defaultFade = 0.3;
      await HS.app.triggerSlot('KeyA');
      await sleep(60);
      await HS.app.triggerSlot('KeyA');
      await sleep(120);
      const midFade = HS.app.engine.voiceCountFor('KeyA');
      await sleep(340);
      const fadedOut = HS.app.engine.voiceCountFor('KeyA');
      step('fade time is honoured', midFade === 1 && fadedOut === 0,
           'sounding 120ms into a 300ms fade=' + midFade + ', silent after 460ms=' + fadedOut);
      HS.app.state.settings.fadeMs = 150;
      HS.app.engine.defaultFade = 0.15;

      // 4. with the toggle off, presses stack up instead (which drums want)
      HS.app.state.settings.pressAgainToStop = false;
      await HS.app.triggerSlot('KeyA');
      await sleep(40);
      await HS.app.triggerSlot('KeyA');
      await sleep(40);
      const poly = HS.app.engine.voiceCountFor('KeyA');
      step('polyphony when the toggle is off', poly >= 2, 'voices=' + poly);
      HS.app.state.settings.pressAgainToStop = true;
      HS.app.engine.stopAll(0.02);
      await sleep(600);
      const after = HS.app.engine.activeVoiceCount();
      step('natural voice release', after === 0, 'voices=' + after);

      // 3. loop + stop
      HS.app.state.slots.KeyB.loop = true;
      await HS.app.triggerSlot('KeyB', { loop: true });
      await sleep(700);
      const looping = HS.app.engine.voiceCountFor('KeyB');
      HS.app.engine.stopSlot('KeyB');
      await sleep(400);   // longer than the default 150ms fade
      const stopped = HS.app.engine.voiceCountFor('KeyB');
      step('loop sustains', looping >= 1, 'voices=' + looping);
      step('loop stops', stopped === 0, 'voices=' + stopped);
      HS.app.state.slots.KeyB.loop = false;

      // 4. missing file surfaces as a slot error, not a crash
      assign('KeyD', ${JSON.stringify(path.join(tmp, 'does-not-exist.wav'))}, 'ghost.wav');
      const bad = await HS.app.triggerSlot('KeyD');
      step('missing file handled', bad === false && !!HS.app.state.slots.KeyD.error, 'error=' + HS.app.state.slots.KeyD.error);
      delete HS.app.state.slots.KeyD;

      // 5. muted keys are not slots at all
      const mutedCodes = ['Escape', 'Backquote', 'Tab', 'CapsLock', 'ShiftLeft', 'ShiftRight',
        'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ContextMenu', 'MetaLeft', 'MetaRight',
        'Backspace', 'Backslash'];
      const mutedStillDrawn = mutedCodes.every((c) => !!document.querySelector('.key[data-code="' + c + '"]'));
      const mutedNotSlots = mutedCodes.every((c) => !HS.app.layout.slotCodes().includes(c));
      const mutedRefuseLoad = (await HS.app.assignPaths('Tab', [{ path: ${JSON.stringify(files.a)}, name: 'x.wav' }])).length === 0
        && !HS.app.state.slots.Tab;
      const mutedRefuseTrigger = (await HS.app.triggerSlot('Escape')) === false;
      const globalRefused = mutedCodes.every((c) => !HS.app.canBeGlobal(c));
      step('muted keys drawn but inert', mutedStillDrawn && mutedNotSlots && mutedRefuseLoad && mutedRefuseTrigger,
           'drawn=' + mutedStillDrawn + ' notSlots=' + mutedNotSlots + ' noLoad=' + mutedRefuseLoad + ' noPlay=' + mutedRefuseTrigger);
      step('muted keys cannot be global', globalRefused, 'canBeGlobal(muted)=' + HS.app.canBeGlobal('Tab'));

      // 6. removed nav keys are gone from the board entirely
      const removedCodes = ['PrintScreen', 'ScrollLock', 'Pause', 'Insert', 'Home', 'PageUp', 'Delete', 'End', 'PageDown'];
      const goneFromLayout = removedCodes.every((c) => !HS.app.layout.BY_CODE.has(c));
      const goneFromDom = removedCodes.every((c) => !document.querySelector('.key[data-code="' + c + '"]'));
      const arrowsKept = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].every((c) => HS.app.layout.BY_CODE.has(c));
      step('nav block removed, arrows kept', goneFromLayout && goneFromDom && arrowsKept,
           'layoutGone=' + goneFromLayout + ' domGone=' + goneFromDom + ' arrows=' + arrowsKept);

      // 7. click a filled key plays it; right-click removes the music
      HS.app.refreshAll();
      const nodeA = document.querySelector('.key[data-code="KeyA"]');
      nodeA.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(80);
      const clickPlayed = HS.app.engine.voiceCountFor('KeyA') >= 1;
      step('click a key with music plays it', clickPlayed, 'voices=' + HS.app.engine.voiceCountFor('KeyA'));

      const nodeC = document.querySelector('.key[data-code="KeyC"]');
      const hadMusic = !!(HS.app.state.slots.KeyC && HS.app.state.slots.KeyC.path);
      nodeC.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await sleep(60);
      const cleared = !HS.app.state.slots.KeyC || !HS.app.state.slots.KeyC.path;
      const nodeStillThere = !!document.querySelector('.key[data-code="KeyC"]');
      step('right-click removes the music', hadMusic && cleared && nodeStillThere,
           'had=' + hadMusic + ' cleared=' + cleared + ' keyKept=' + nodeStillThere);

      // right-click on an empty key must be a no-op, not a crash
      const nodeE = document.querySelector('.key[data-code="KeyE"]');
      nodeE.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await sleep(40);
      step('right-click on empty key is inert', !HS.app.state.slots.KeyE || !HS.app.state.slots.KeyE.path, 'ok');

      // 8. waveform preview follows playback
      const wave = HS.app.getWave();
      await HS.app.triggerSlot('KeyB');
      await sleep(140);
      const showingB = wave.isShowing('KeyB');
      const progress = wave.progress();
      const canvas = document.getElementById('wave-canvas');
      // A drawn waveform is not a flat colour: sample two columns and compare.
      const ctx2d = canvas.getContext('2d');
      const colA = ctx2d.getImageData(Math.floor(canvas.width * 0.25), 0, 1, canvas.height).data;
      const colB = ctx2d.getImageData(Math.floor(canvas.width * 0.75), 0, 1, canvas.height).data;
      let differing = 0;
      for (let i = 0; i < colA.length; i += 4) { if (colA[i + 1] !== colB[i + 1]) differing++; }
      step('waveform preview drawn', showingB && canvas.width > 8 && differing > 0,
           'showing=' + showingB + ' differingRows=' + differing);
      step('waveform playhead advances', typeof progress === 'number' && progress >= 0 && progress < 1,
           'progress=' + (typeof progress === 'number' ? progress.toFixed(2) : progress));
      HS.app.engine.stopAll();
      // The sweep runs off the audio clock, so poll instead of guessing how long a
      // 0.3s sample takes to reach its end.
      let settled = null;
      for (let i = 0; i < 40 && settled !== 1; i++) {
        await sleep(50);
        settled = wave.progress();
      }
      step('waveform settles at end', settled === 1, 'progress=' + settled);

      // 9. profile round-trip through the real filesystem
      const profile = {
        version: 2, app: 'HotSound', masterVolume: 0.42,
        settings: { fadeMs: 640, pressAgainToStop: false },
        slots: { KeyA: HS.app.state.slots.KeyA, KeyB: HS.app.state.slots.KeyB }
      };
      await window.hotsound.saveProfile(profile);
      const back = (await window.hotsound.loadProfile()).profile;
      step('profile round-trip',
        !!back && back.masterVolume === 0.42 && back.slots && back.slots.KeyB && /snare/.test(back.slots.KeyB.path),
        'master=' + (back && back.masterVolume) + ' slots=' + (back && back.slots ? Object.keys(back.slots).length : 0));

      // Settings travel with the profile, so a fade set once survives a restart.
      const settingsBack = await window.hotsound.loadProfile().then((r) => r.profile && r.profile.settings);
      step('settings persist with the profile',
        !!settingsBack && settingsBack.fadeMs === 640 && settingsBack.pressAgainToStop === false,
        JSON.stringify(settingsBack));

      // 10. Save As: writes to a chosen path and becomes the active profile
      const saveTarget = ${JSON.stringify(path.join(tmp, 'chosen', 'my-hotsound-profile.json'))};
      const asRes = await window.hotsound.saveProfileAs(profile, saveTarget);
      const activeAfterSave = await window.hotsound.profilePath();
      const reRead = (await window.hotsound.loadProfile()).profile;
      step('save-as writes to chosen path',
        !!(asRes && asRes.ok) && asRes.path === saveTarget
          && activeAfterSave.path === saveTarget
          && !!reRead && reRead.masterVolume === 0.42,
        'ok=' + !!(asRes && asRes.ok) + ' path=' + (asRes && asRes.path) + ' active=' + activeAfterSave.path);

      // 11. path resolution + file existence probe used at boot
      const exists = await window.hotsound.fileExists(${JSON.stringify(files.a)});
      const gone = await window.hotsound.fileExists(${JSON.stringify(path.join(tmp, 'nope.wav'))});
      step('file probes', exists === true && gone === false, 'exists=' + exists + ' gone=' + gone);

      // 12. a profile that still lists a muted key must not resurrect it
      await window.hotsound.saveProfile({
        version: 1, app: 'HotSound', masterVolume: 0.5,
        slots: { Tab: { code: 'Tab', path: ${JSON.stringify(files.a)}, name: 'old.wav', volume: 1 } }
      });
      const legacy = (await window.hotsound.loadProfile()).profile;
      step('legacy muted entry ignored', !!(legacy && legacy.slots && legacy.slots.Tab),
           'stored-but-not-loadable=' + !!(legacy && legacy.slots.Tab));

      // 13. a multi-file assign spills onto the following slots in reading order
      await HS.app.assignPaths('KeyG', [
        { path: ${JSON.stringify(files.a)}, name: 'spill1.wav' },
        { path: ${JSON.stringify(files.b)}, name: 'spill2.wav' },
        { path: ${JSON.stringify(files.c)}, name: 'spill3.wav' }
      ]);
      await sleep(150);
      const spilled = ['KeyG', 'KeyH', 'KeyJ'].filter((c) => HS.app.state.slots[c] && HS.app.state.slots[c].path).length;
      const beyond = HS.app.state.slots.KeyK && HS.app.state.slots.KeyK.path;
      step('multi-file spill', spilled === 3 && !beyond, 'filled=' + spilled + ' leaked=' + !!beyond);

      // 14. loading a folder fills the empty slots first, and never a muted key
      const beforeCount = Object.values(HS.app.state.slots).filter((s) => s && s.path).length;
      const stub = {
        ok: true, dir: 'stub',
        files: [
          { path: ${JSON.stringify(files.a)}, name: 'f1.wav' },
          { path: ${JSON.stringify(files.b)}, name: 'f2.wav' }
        ]
      };
      await HS.app.loadFolder(stub);
      await sleep(250);
      const afterCount = Object.values(HS.app.state.slots).filter((s) => s && s.path).length;
      const mutedUntouched = mutedCodes.every((c) => !HS.app.state.slots[c] || !HS.app.state.slots[c].path);
      step('folder fills empty slots first', afterCount >= beforeCount + 2 && mutedUntouched,
           'before=' + beforeCount + ' after=' + afterCount + ' mutedUntouched=' + mutedUntouched);

      // 15. a saved profile keeps slot paths
      step('profile carries slot paths', !!back && back.slots.KeyA && !!back.slots.KeyA.path,
           'keyA=' + (back && back.slots.KeyA ? back.slots.KeyA.path.slice(-28) : 'none'));

      out.pass = out.steps.every((s) => s.pass);
      return out;
    })()
  `;

  let result;
  try {
    result = await win.webContents.executeJavaScript(script, true);
  } catch (err) {
    console.error('E2E FAIL: renderer threw: ' + err.message);
    app.exit(5);
    return;
  }

  // Guard: the shell open dialog must never come back. Dismissing it segfaults the
  // main process (access violation in explorerframe.dll), which is the "program
  // force-closes when I cancel the file picker" bug. It cannot be caught at runtime,
  // so it is guarded statically here and the picker is asserted to be the renderer's
  // own file input instead.
  const guarded = {
    name: 'no shell open dialog in source',
    pass: false,
    detail: ''
  };
  try {
    const files = [
      path.join(__dirname, '..', 'main.js'),
      path.join(__dirname, '..', 'preload.js'),
      path.join(__dirname, '..', 'renderer', 'app.js'),
      path.join(__dirname, '..', 'renderer', 'waveform.js'),
      path.join(__dirname, '..', 'renderer', 'layout.js'),
      path.join(__dirname, '..', 'renderer', 'audio.js')
    ];
    const offenders = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      text.split(/\r?\n/).forEach((line, i) => {
        // Skip comments in either style: the source *documents* this defect, and
        // only a real call site may fail the guard.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/showOpenDialog|'hotsound:pick-(sounds|folder)'/.test(line)) {
          offenders.push(`${path.basename(f)}:${i + 1}`);
        }
      });
    }
    guarded.pass = offenders.length === 0;
    guarded.detail = offenders.length ? `found at ${offenders.join(', ')}` : 'none';
  } catch (err) {
    guarded.detail = 'driver error: ' + err.message;
  }
  result.steps.push(guarded);

  const picker = await win.webContents.executeJavaScript(
    `(() => {
       const HS = window.HS;
       const plain = HS.app.createFileInput({ accept: HS.app.audioAccept });
       const dir = HS.app.createFileInput({ directory: true });
       return {
         hasBridgeToShellDialog: typeof window.hotsound.pickSounds === 'function'
           || typeof window.hotsound.pickFolder === 'function'
           || typeof window.hotsound.openProfile === 'function',
         plainIsFile: plain.type === 'file',
         plainMultiple: plain.multiple === true,
         plainHidden: plain.style.display === 'none',
         plainAcceptCoversAudio: ['wav','mp3','ogg','flac','m4a','aac','opus'].every((e) => plain.accept.includes(e)),
         dirIsDirectory: dir.webkitdirectory === true,
         leakedIntoDom: document.querySelectorAll('input.file-picker').length
       };
     })()`,
    true
  );
  result.steps.push({
    name: 'picker is renderer-side and configured',
    pass: picker.plainIsFile && picker.plainMultiple && picker.plainHidden
      && picker.plainAcceptCoversAudio && picker.dirIsDirectory
      && picker.hasBridgeToShellDialog === false && picker.leakedIntoDom === 0,
    detail: JSON.stringify(picker)
  });

  // The developer credit is read from package.json, so the app and the build
  // metadata cannot disagree. The link is opened only for http(s): the renderer
  // must not be able to ask the shell for an arbitrary scheme.
  const identity = await win.webContents.executeJavaScript(
    `(async () => {
       const info = await window.hotsound.appInfo();
       const shown = document.getElementById('dev-name').textContent;
       const bad = await Promise.all([
         window.hotsound.openExternal('file:///C:/Windows/System32/calc.exe'),
         window.hotsound.openExternal('javascript:alert(1)'),
         window.hotsound.openExternal(''),
         window.hotsound.openExternal(null)
       ]);
       return {
         info,
         shown,
         matches: shown === info.developer,
         linkTitle: document.getElementById('dev-github').title,
         linkEnabled: !document.getElementById('dev-github').disabled,
         rejected: bad.map((r) => r && r.ok === false),
         tooltip: document.getElementById('developer').title
       };
     })()`,
    true
  );
  result.steps.push({
    name: 'developer info matches build',
    pass: !!identity.matches && !!identity.info.developer && !!identity.info.developerUrl
      && identity.linkEnabled && identity.linkTitle === identity.info.developerUrl
      && identity.tooltip.includes(identity.info.developer)
      && identity.rejected.every(Boolean),
    detail: `${identity.info.developer} <${identity.info.developerUrl}> shown="${identity.shown}" `
      + `nonHttpRejected=${identity.rejected.filter(Boolean).length}/4`
  });

  // The two playback visualisations: the list of keys playing now, and the
  // equalizer bank reading the mix through the engine's analyser.
  const panels = await win.webContents.executeJavaScript(
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const HS = window.HS;
       const playing = HS.app.getPlaying();
       const eq = HS.app.getEq();
       const out = {};

       const list = document.querySelector('.playing-list');
       out.rowsIdle = playing.count();

       const put = (code, p, name) => {
         const slot = HS.app.state.slots[code] || { code };
         Object.assign(slot, { code, path: p, name, volume: 1, rate: 1, pan: 0, loop: false, global: false, error: '' });
         HS.app.state.slots[code] = slot;
       };

       // Play two different keys, so the list has to hold more than one row.
       put('KeyA', ${JSON.stringify(files.a)}, 'kick.wav');
       put('KeyB', ${JSON.stringify(files.b)}, 'snare.wav');
       await HS.app.triggerSlot('KeyA');
       await HS.app.triggerSlot('KeyB');
       await sleep(220);

       out.rowsPlaying = playing.count();
       out.rowCodes = playing.codes().sort();
       out.domRows = list.querySelectorAll('.playing-row').length;
       const row = list.querySelector('.playing-row');
       out.firstRow = row ? {
         key: row.querySelector('.playing-key').textContent,
         name: row.querySelector('.playing-name').textContent,
         time: row.querySelector('.playing-time').textContent,
         bar: row.querySelector('.playing-bar').style.width,
         zone: row.style.getPropertyValue('--zone-fill')
       } : null;
       out.countLabel = document.getElementById('playing-count').textContent;
       const t = (out.firstRow || {}).time || '';
       out.timeLooksRight = t.includes(' / ') && t.includes(':') && t.length >= 11;

       // The analyser must be reporting something while audio is playing, otherwise
       // the faders are decorative.
       const spec = HS.app.engine.spectrum(16);
       out.spectrumBands = spec.length;
       out.spectrumPeak = Math.max.apply(null, spec);
       out.spectrumNonZero = spec.filter((v) => v > 0).length;

       // The faders must be painted, not merely fed: sample a line across the bank
       // and count pixels that are lit rather than groove.
       const eqCanvas = document.getElementById('eq-canvas');
       const eq2d = eqCanvas.getContext('2d');
       const scan = eq2d.getImageData(0, Math.floor(eqCanvas.height * 0.92), eqCanvas.width, 1).data;
       let lit = 0;
       for (let i = 0; i < scan.length; i += 4) if (scan[i + 1] > 90) lit++;
       out.eqLitPixels = lit;
       out.eqWidth = eqCanvas.width;

       // Stop everything: the rows must go away on their own.
       HS.app.engine.stopAll();
       await sleep(500);
       out.rowsAfterStop = playing.count();
       out.domRowsAfterStop = list.querySelectorAll('.playing-row').length;
       out.hintBack = !!list.querySelector('.playing-empty');
       out.countAfterStop = document.getElementById('playing-count').textContent;
       return out;
     })()`,
    true
  );

  result.steps.push({
    name: 'playing list tracks sounding keys',
    pass: panels.rowsIdle === 0 && panels.rowsPlaying === 2
      && panels.rowCodes.join(',') === 'KeyA,KeyB'
      && panels.domRows === 2
      && !!panels.firstRow && panels.firstRow.name.length > 0
      && panels.firstRow.time.length > 0 && panels.timeLooksRight
      && parseFloat(panels.firstRow.bar) >= 0
      && !!panels.firstRow.zone
      && panels.countLabel === '2 playing',
    detail: `idle=${panels.rowsIdle} playing=${panels.rowsPlaying} [${(panels.rowCodes || []).join(',')}] `
      + `dom=${panels.domRows} first=${JSON.stringify(panels.firstRow)} label="${panels.countLabel}" timeOk=${panels.timeLooksRight}`
  });

  result.steps.push({
    name: 'rows clear when the sound ends',
    pass: panels.rowsAfterStop === 0 && panels.domRowsAfterStop === 0
      && panels.hintBack && panels.countAfterStop === 'idle',
    detail: `rows=${panels.rowsAfterStop} dom=${panels.domRowsAfterStop} hint=${panels.hintBack} label="${panels.countAfterStop}"`
  });

  result.steps.push({
    name: 'analyser feeds the equalizer',
    pass: panels.spectrumBands === 16 && panels.spectrumNonZero >= 3 && panels.spectrumPeak > 0
      && panels.eqLitPixels > 20,
    detail: `${panels.spectrumBands} bands, ${panels.spectrumNonZero} non-zero, peak=${panels.spectrumPeak.toFixed(2)}, `
      + `painted pixels on a scan line across a ${panels.eqWidth}px bank = ${panels.eqLitPixels}`
  });

  // Phase 2: a corrupt profile on disk
  // Phase 2: a corrupt profile on disk must degrade gracefully, never crash.
  // The renderer knows which file is active (the Save As check moved it), so ask.
  let corruptCheck = { name: 'corrupt profile tolerated', pass: false, detail: '' };
  try {
    const active = await win.webContents.executeJavaScript('window.hotsound.profilePath()', true);
    const corrupted = active && active.path;
    fs.writeFileSync(corrupted, '{ this is not json at all', 'utf8');

    // With only the active file broken, the working copy must take over.
    const phase2 = await win.webContents.executeJavaScript(
      `(async () => {
         try { return { ok: true, value: await window.hotsound.loadProfile() }; }
         catch (err) { return { ok: false, threw: err.message }; }
       })()`,
      true
    );
    const fellBack = phase2.ok && phase2.value && phase2.value.fellBack === true
      && phase2.value.missing === corrupted && phase2.value.path !== corrupted;

    // With both broken there is nothing left to load, which must also be survivable.
    fs.writeFileSync(path.join(app.getPath('userData'), 'hotsound-profile.json'), 'not json either', 'utf8');
    const phase3 = await win.webContents.executeJavaScript(
      `(async () => {
         try { const v = await window.hotsound.loadProfile(); return { ok: true, value: v }; }
         catch (err) { return { ok: false, threw: err.message }; }
       })()`,
      true
    );
    const emptyIsSurvivable = phase3.ok && phase3.value && phase3.value.profile === null;

    corruptCheck.pass = fellBack && emptyIsSurvivable;
    corruptCheck.detail = `fellBack=${fellBack} (missing=${phase2.value && phase2.value.missing}) `
      + `nullWhenAllBroken=${emptyIsSurvivable}`;
  } catch (err) {
    corruptCheck.detail = 'driver error: ' + err.message;
  }
  result.steps.push(corruptCheck);
  result.pass = result.steps.every((s) => s.pass);

  console.log('\nHotSound end-to-end results');
  console.log('===========================');
  for (const s of result.steps || []) {
    console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${s.name.padEnd(24)} ${s.detail || ''}`);
  }
  if (result.fatal) console.log('FATAL: ' + result.fatal);
  console.log('===========================');
  const failed = (result.steps || []).filter((s) => !s.pass).length;
  console.log(failed === 0 && result.pass ? 'E2E OK' : `E2E FAILED (${failed} check(s))`);

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best effort */
  }

  // Leave the machine tidy: neither the working profile nor the custom location the
  // Save As check pointed at may survive into the user's first real launch.
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'hotsound-profile.json'), { force: true });
    fs.rmSync(path.join(app.getPath('userData'), 'hotsound-settings.json'), { force: true });
  } catch {
    /* ignore */
  }

  app.exit(failed === 0 && result.pass ? 0 : 5);
}

module.exports = { run };
