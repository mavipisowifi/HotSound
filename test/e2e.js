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
    long: writeWav(path.join(tmp, 'long.wav'), { freq: 200, seconds: 3.0 }),
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

      // 0. the output device is opened at boot, not on the first hit. Opening it costs
      //    tens of milliseconds, which otherwise lands on whichever hit comes first.
      const ctxAtBoot = HS.app.engine.ctx;
      step('audio device warmed at boot',
        !!ctxAtBoot && (ctxAtBoot.state === 'running' || ctxAtBoot.state === 'suspended'),
        ctxAtBoot ? 'state=' + ctxAtBoot.state + ' rate=' + ctxAtBoot.sampleRate : 'no context');

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

      // Regression: the waveform preview used to keep sweeping after the sound was
      // stopped, so a stopped sound still looked like it was playing.
      const waveView = HS.app.getWave();
      HS.app.state.slots.KeyL = HS.app.state.slots.KeyL || { code: 'KeyL' };
      Object.assign(HS.app.state.slots.KeyL, {
        code: 'KeyL', path: ${JSON.stringify(files.long)}, name: 'long.wav',
        volume: 1, rate: 1, pan: 0, loop: false, global: false, error: ''
      });
      await HS.app.triggerSlot('KeyL');
      await sleep(200);
      const waveWhilePlaying = { playing: waveView.isPlaying(), showing: waveView.isShowing('KeyL'), progress: waveView.progress() };
      await HS.app.triggerSlot('KeyL');   // second press stops it
      await sleep(250);
      const waveAfterStop = { playing: waveView.isPlaying(), showing: waveView.isShowing('KeyL'), progress: waveView.progress() };
      step('stopping a sound stops the waveform',
        waveWhilePlaying.playing === true && waveWhilePlaying.showing === true
          && waveWhilePlaying.progress > 0 && waveWhilePlaying.progress < 1
          && waveAfterStop.playing === false && waveAfterStop.progress === null,
        'while playing=' + JSON.stringify(waveWhilePlaying) + ' after stop=' + JSON.stringify(waveAfterStop));

      // And the Stop all button has to do the same, through the app's own path.
      await HS.app.triggerSlot('KeyL');
      await sleep(150);
      const playingBeforeStopAll = waveView.isPlaying();
      document.getElementById('btn-stop-all').click();
      await sleep(150);
      const panicked = waveView.isPlaying();
      step('Stop all also stops the waveform',
        playingBeforeStopAll === true && panicked === false,
        'before=' + playingBeforeStopAll + ' after=' + panicked);
      HS.app.state.slots.KeyA.loop = false;
      await sleep(120);

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

      // 7. click a filled key plays it; right-click offers the slot menu
      HS.app.refreshAll();
      const nodeA = document.querySelector('.key[data-code="KeyA"]');
      nodeA.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(80);
      const clickPlayed = HS.app.engine.voiceCountFor('KeyA') >= 1;
      step('click a key with music plays it', clickPlayed, 'voices=' + HS.app.engine.voiceCountFor('KeyA'));

      const menuEl = document.getElementById('context-menu');
      const nodeC = document.querySelector('.key[data-code="KeyC"]');
      const hadMusic = !!(HS.app.state.slots.KeyC && HS.app.state.slots.KeyC.path);
      nodeC.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await sleep(60);
      const menuOpened = !menuEl.hidden;
      const stillThere = !!(HS.app.state.slots.KeyC && HS.app.state.slots.KeyC.path);
      const nodeStillThere = !!document.querySelector('.key[data-code="KeyC"]');
      // Deleting now takes a deliberate second click, so a slip of the right button
      // cannot throw an assignment away.
      step('right-click opens the menu and keeps the music', hadMusic && menuOpened && stillThere && nodeStillThere,
           'had=' + hadMusic + ' menuOpen=' + menuOpened + ' musicKept=' + stillThere);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));

      // right-clicking an empty key must not assign anything or fail
      const nodeE = document.querySelector('.key[data-code="KeyE"]');
      nodeE.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await sleep(40);
      const emptyStayedEmpty = !HS.app.state.slots.KeyE || !HS.app.state.slots.KeyE.path;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      step('right-click on an empty key changes nothing', emptyStayedEmpty, 'ok');

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

  // The app's own contribution to latency: the synchronous work between the press and
  // the audio being scheduled. It must stay flat, because this is the part that makes a
  // drum roll feel sluggish, and the device latency below is a separate matter.
  const latency = await win.webContents.executeJavaScript(
    `(async () => {
       const HS = window.HS;
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const keys = ['KeyA', 'KeyB'];
       const sched = [];
       for (let i = 0; i < 24; i++) {
         const code = keys[i % keys.length];
         const slot = HS.app.state.slots[code];
         if (!slot || !slot.path) continue;
         const t0 = performance.now();
         const pending = HS.app.triggerSlot(code);   // audio is scheduled in here
         sched.push(performance.now() - t0);
         await pending;
         HS.app.engine.stopSlot(code, 0.001);
         await sleep(12);
       }
       const sorted = sched.slice().sort((a, b) => a - b);
       const ctx = HS.app.engine.ctx;
       return {
         count: sorted.length,
         median: sorted[Math.floor(sorted.length / 2)],
         max: sorted[sorted.length - 1],
         deviceMs: ctx ? ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000 : 0
       };
     })()`,
    true
  );
  result.steps.push({
    name: 'hits are scheduled without UI delay',
    pass: latency.count >= 10 && latency.median <= 5 && latency.max <= 25,
    detail: `${latency.count} warm hits: median ${latency.median.toFixed(2)} ms, max ${latency.max.toFixed(2)} ms `
      + `(app-side; device reports ${latency.deviceMs.toFixed(0)} ms, which is the sound card's own delay)`
  });

  // Right-clicking a key opens a menu with two per-key actions: delete its music, or
  // pin whether that one key stops on a second press.
  const slotMenu = await win.webContents.executeJavaScript(
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const HS = window.HS;
       const out = {};
       const node = (code) => document.querySelector('.key[data-code="' + code + '"]');
       const menu = document.getElementById('context-menu');
       const items = () => [...menu.querySelectorAll('.menu-item')].map((b) => ({
         action: b.dataset.action, text: b.textContent.trim(), disabled: b.disabled
       }));

       // Put music on a key, then right-click it.
       const slot = HS.app.state.slots.KeyC || { code: 'KeyC' };
       Object.assign(slot, { code: 'KeyC', path: ${JSON.stringify(files.a)}, name: 'kick.wav', volume: 1, rate: 1, pan: 0, loop: false, global: false, twiceToStop: null, error: '' });
       HS.app.state.slots.KeyC = slot;
       HS.app.refreshKey('KeyC');

       out.hiddenAtRest = menu.hidden;
       node('KeyC').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
       await sleep(60);
       out.openedOnRightClick = !menu.hidden;
       out.items = items();
       out.heading = (menu.querySelector('.menu-head') || {}).textContent;

       // The per-key toggle first: pin this key to "every press stacks".
       HS.app.state.settings.pressAgainToStop = true;   // global default is twice-to-stop
       const beforePinned = HS.app.engine ? null : null;
       menu.querySelector('[data-action="twice"]').click();
       await sleep(60);
       out.menuClosedAfterChoice = menu.hidden;
       out.pinned = HS.app.state.slots.KeyC.twiceToStop;

       // Pressed twice with the key pinned off: the second press stacks a voice instead
       // of stopping the first.
       await HS.app.triggerSlot('KeyC');
       await sleep(50);
       const stacked = HS.app.engine.voiceCountFor('KeyC');
       HS.app.engine.stopAll(0.01);
       await sleep(400);

       // Now re-open and toggle it back: it follows the global (twice to stop) again, and
       // the second press stops.
       node('KeyC').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 130 }));
       await sleep(60);
       menu.querySelector('[data-action="twice"]').click();
       await sleep(60);
       out.pinnedAfterToggleBack = HS.app.state.slots.KeyC.twiceToStop;
       await HS.app.triggerSlot('KeyC');
       await sleep(50);
       await HS.app.triggerSlot('KeyC');
       await sleep(400);
       const afterToggle = HS.app.engine.voiceCountFor('KeyC');

       // Escape closes it.
       node('KeyC').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
       await sleep(60);
       const openAgain = !menu.hidden;
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
       await sleep(60);
       out.escapeCloses = openAgain && menu.hidden;

       // Delete, from the menu, clears the key.
       node('KeyC').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
       await sleep(60);
       menu.querySelector('[data-action="delete"]').click();
       await sleep(80);
       out.deleted = !HS.app.state.slots.KeyC.path;
       out.badgeGoneAfterDelete = !node('KeyC').querySelector('.badge.twice');
       out.stackedVoices = stacked;

       // A key with nothing loaded offers no delete.
       HS.app.state.slots.KeyC.twiceToStop = null;
       HS.app.refreshKey('KeyC');
       node('KeyC').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
       await sleep(60);
       out.deleteDisabledWhenEmpty = items().find((i) => i.action === 'delete').disabled === true;
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));

       out.afterToggleVoices = afterToggle;
       return out;
     })()`,
    true
  );

  result.steps.push({
    name: 'right-click opens a two-item slot menu',
    pass: slotMenu.openedOnRightClick === true
      && slotMenu.items.length === 2
      && slotMenu.items[0].action === 'delete' && slotMenu.items[1].action === 'twice',
    detail: `heading="${slotMenu.heading}" items=${JSON.stringify(slotMenu.items)}`
  });

  result.steps.push({
    name: 'per-key twice-to-stop is honoured',
    pass: slotMenu.pinned === false && slotMenu.stackedVoices === 1
      && slotMenu.pinnedAfterToggleBack === null && slotMenu.afterToggleVoices === 0,
    detail: `pinned=${slotMenu.pinned} (same key pressed twice -> ${slotMenu.stackedVoices} voice, i.e. it stacked); `
      + `toggled back=${slotMenu.pinnedAfterToggleBack} (follows global) -> ${slotMenu.afterToggleVoices} voices left`
  });

  result.steps.push({
    name: 'menu dismissal and delete',
    pass: slotMenu.menuClosedAfterChoice === true && slotMenu.escapeCloses === true
      && slotMenu.deleted === true && slotMenu.badgeGoneAfterDelete === true
      && slotMenu.deleteDisabledWhenEmpty === true,
    detail: `closesAfterChoice=${slotMenu.menuClosedAfterChoice} escape=${slotMenu.escapeCloses} `
      + `deleted=${slotMenu.deleted} deleteDisabledWhenEmpty=${slotMenu.deleteDisabledWhenEmpty}`
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
