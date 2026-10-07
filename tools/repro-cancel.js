'use strict';

/**
 * Reproduction: cancelling the Windows file dialog must not kill the program.
 *
 * Confirmed crash: with a parented modal dialog, dismissing it (Cancel) segfaults
 * the main process - no JS error, no crash dialog, the whole app just disappears.
 * The faulting module is explorerframe.dll, the shell DLL that hosts the dialog and
 * its navigation pane, and the fault is a read of already-unloaded code.
 *
 * This drives the real app, dismisses the real dialog with WM_CLOSE (exactly what
 * the Cancel button does) and reports whether the process survived. Run one variant
 * per process, because the crash takes the process with it.
 *
 * Run with: electron . --repro-cancel=parent|noparent|input
 */

const { app, dialog } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const VARIANT = (process.argv.find((a) => a.startsWith('--repro-cancel=')) || '').split('=')[1] || 'parent';

const log = (msg) => console.log(`[${VARIANT}] ${msg}`);

function instrument() {
  process.on('uncaughtException', (err) => log(`!!! uncaughtException: ${err && err.stack ? err.stack : err}`));
  process.on('unhandledRejection', (r) => log(`!!! unhandledRejection: ${r && r.stack ? r.stack : r}`));
  process.on('exit', (code) => log(`!!! process exit code=${code}`));
  app.on('window-all-closed', () => log('!!! window-all-closed'));
  app.on('before-quit', () => log('!!! before-quit'));
  app.on('child-process-gone', (_e, d) => log(`!!! child-process-gone ${JSON.stringify(d)}`));
}

/** Close the dialog window (class #32770), in any of this app's processes. */
function dismissDialog(pids) {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    Add-Type @"
      using System;
      using System.Text;
      using System.Runtime.InteropServices;
      public class W {
        public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
      }
"@
    $targets = @(${pids.join(',')})
    $found = @()
    $cb = [W+EnumProc]{
      param($h, $l)
      $wpid = 0
      [void][W]::GetWindowThreadProcessId($h, [ref]$wpid)
      if (($targets -contains [int]$wpid) -and [W]::IsWindowVisible($h)) {
        $cls = New-Object System.Text.StringBuilder 256
        [void][W]::GetClassName($h, $cls, 256)
        if ($cls.ToString() -eq '#32770') {
          $txt = New-Object System.Text.StringBuilder 256
          [void][W]::GetWindowText($h, $txt, 256)
          $script:found += [pscustomobject]@{ H = $h; Title = $txt.ToString(); Pid = [int]$wpid }
        }
      }
      return $true
    }
    [void][W]::EnumWindows($cb, [IntPtr]::Zero)
    if (-not $script:found) { Write-Output "NO_DIALOG_FOUND"; exit 2 }
    foreach ($d in $script:found) {
      Write-Output ("closing dialog '" + $d.Title + "' (pid " + $d.Pid + ")")
      [void][W]::PostMessage($d.H, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    }
    exit 0
  `;
  const file = path.join(os.tmpdir(), `hotsound-dismiss-${VARIANT}.ps1`);
  fs.writeFileSync(file, script, 'utf8');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], (err, stdout) => {
      for (const line of String(stdout || '').split(/\r?\n/)) if (line.trim()) log('  ' + line);
      resolve(!err);
    });
  });
}

function appPids() {
  const pids = [process.pid];
  for (const m of app.getAppMetrics()) pids.push(m.pid);
  return [...new Set(pids)];
}

async function run(win) {
  instrument();
  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) resolve();
    else win.webContents.once('did-finish-load', resolve);
  });
  await new Promise((r) => setTimeout(r, 1500));
  log('booted');

  if (VARIANT === 'input') {
    // Chromium's own picker, driven from the renderer: a replacement candidate.
    await win.webContents.executeJavaScript(
      `(() => {
         window.__cancelProbe = { events: [] };
         const input = document.createElement('input');
         input.type = 'file';
         input.multiple = true;
         document.body.appendChild(input);
         input.addEventListener('cancel', () => window.__cancelProbe.events.push('cancel'));
         input.addEventListener('change', () => window.__cancelProbe.events.push('change:' + input.files.length));
         input.click();
         return true;
       })()`,
      true
    );
    log('created <input type=file> and clicked it');
  } else if (VARIANT === 'app') {
    // The reported flow: click an empty key. The app now opens Chromium's picker
    // from the renderer, and cancelling it must leave the program running.
    const code = await win.webContents.executeJavaScript(
      `(() => { const k = document.querySelector('.key:not(.muted).empty'); if (!k) return 'no empty key'; k.click(); return k.dataset.code; })()`,
      true
    );
    log('clicked empty slot ' + code + ' (renderer picker)');
    await new Promise((r) => setTimeout(r, 1200));
    const inputs = await win.webContents.executeJavaScript(
      "document.querySelectorAll('input.file-picker').length", true);
    log('picker inputs in DOM while open: ' + inputs);
  } else if (VARIANT === 'esc') {
    // The user's other cancel gesture: press Escape while the picker is up.
    const code = await win.webContents.executeJavaScript(
      `(() => { const k = document.querySelector('.key:not(.muted).empty'); if (!k) return null; k.click(); return k.dataset.code; })()`,
      true
    );
    log('clicked empty slot ' + code + ' to open the picker');
    await new Promise((r) => setTimeout(r, 1500));
    const ps = path.join(os.tmpdir(), 'hotsound-esc.ps1');
    fs.writeFileSync(ps, `
      $ErrorActionPreference = 'SilentlyContinue'
      $sh = New-Object -ComObject WScript.Shell
      Start-Sleep -Milliseconds 500
      $act = $sh.AppActivate('Open')
      Write-Output ("appActivate=" + $act)
      Start-Sleep -Milliseconds 700
      $sh.SendKeys('{ESC}')
      Start-Sleep -Milliseconds 900
    `, 'utf8');
    await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-File', ps], (err, stdout) => {
      for (const line of String(stdout || '').split(/\r?\n/)) if (line.trim()) log('  ' + line);
      resolve();
    }));
    await new Promise((r) => setTimeout(r, 2000));
    // Is the dialog still up? (We are NOT closing it ourselves in this variant.)
    const stillOpen = await new Promise((resolve) => {
      const probe = path.join(os.tmpdir(), 'hotsound-esc-probe.ps1');
      fs.writeFileSync(probe, `
        $ErrorActionPreference = 'SilentlyContinue'
        Add-Type @"
          using System; using System.Text; using System.Runtime.InteropServices;
          public class P {
            public delegate bool EnumProc(IntPtr h, IntPtr l);
            [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
            [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
            [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
            [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
          }
"@
        $targets = @(${appPids().join(',')})
        $count = 0
        $cb = [P+EnumProc]{
          param($h, $l)
          $wpid = 0
          [void][P]::GetWindowThreadProcessId($h, [ref]$wpid)
          if (($targets -contains [int]$wpid) -and [P]::IsWindowVisible($h)) {
            $cls = New-Object System.Text.StringBuilder 256
            [void][P]::GetClassName($h, $cls, 256)
            if ($cls.ToString() -eq '#32770') { $script:count += 1 }
          }
          return $true
        }
        [void][P]::EnumWindows($cb, [IntPtr]::Zero)
        Write-Output $script:count
      `, 'utf8');
      execFile('powershell.exe', ['-NoProfile', '-File', probe], (err, stdout) => resolve(String(stdout || '').trim()));
    });
    log('dialog windows still open after Escape: ' + stillOpen);
    const st = await win.webContents.executeJavaScript(
      `JSON.stringify({ status: (document.getElementById('status-msg') || {}).textContent,
                        emptyKeys: document.querySelectorAll('.key:not(.muted).empty').length,
                        pickerInputs: document.querySelectorAll('input.file-picker').length })`,
      true
    );
    log('state: ' + st);
    log(stillOpen === '0' ? 'RESULT: Escape dismissed the picker' : 'RESULT: keystrokes did NOT reach the picker');
  } else if (VARIANT === 'select') {
    // The other half of the fix: a file chosen through the renderer picker must
    // resolve to a real path and actually land on the slot.
    const wav = path.join(os.tmpdir(), 'hotsound-picker-probe.wav');
    const rate = 8000, secs = 0.3, n = Math.floor(rate * secs);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    fs.writeFileSync(wav, buf);
    log('probe file: ' + wav);

    const code = await win.webContents.executeJavaScript(
      `(() => { const k = document.querySelector('.key:not(.muted).empty'); if (!k) return null; k.click(); return k.dataset.code; })()`,
      true
    );
    log('clicked empty slot ' + code + ' to open the picker');
    await new Promise((r) => setTimeout(r, 1500));

    // Type the path into the picker's filename box and confirm.
    const script = `
      $ErrorActionPreference = 'SilentlyContinue'
      $sh = New-Object -ComObject WScript.Shell
      Start-Sleep -Milliseconds 600
      $act = $sh.AppActivate('Open')
      Write-Output ("appActivate=" + $act)
      Start-Sleep -Milliseconds 600
      $sh.SendKeys('${wav}')
      Start-Sleep -Milliseconds 900
      $sh.SendKeys('{ENTER}')
      Start-Sleep -Milliseconds 500
    `;
    const ps = path.join(os.tmpdir(), 'hotsound-select.ps1');
    fs.writeFileSync(ps, script, 'utf8');
    await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-File', ps], (err, stdout) => {
      for (const line of String(stdout || '').split(/\r?\n/)) if (line.trim()) log('  ' + line);
      resolve();
    }));
    await new Promise((r) => setTimeout(r, 3500));

    const state = await win.webContents.executeJavaScript(
      `(() => {
         const slots = window.HS.app.state.slots;
         const code = ${JSON.stringify(code)};
         const slot = code ? slots[code] : null;
         return JSON.stringify({
           code,
           assignedPath: slot ? slot.path : null,
           name: slot ? slot.name : null,
           emptyKeys: document.querySelectorAll('.key:not(.muted).empty').length,
           status: (document.getElementById('status-msg') || {}).textContent
         });
       })()`,
      true
    );
    log('after selecting a file: ' + state);
    let parsed = {};
    try { parsed = JSON.parse(state); } catch { /* ignore */ }
    log(parsed.assignedPath && parsed.assignedPath.endsWith('hotsound-picker-probe.wav')
      ? 'RESULT: file chosen through the picker reached the slot'
      : 'RESULT: selection did NOT reach the slot');
    try { fs.rmSync(wav, { force: true }); } catch { /* ignore */ }
  } else if (VARIANT === 'save') {
    // Does the Save dialog share the defect? Same shell family, IFileSaveDialog.
    dialog.showSaveDialog(win, {
      title: 'Save HotSound profile',
      defaultPath: path.join(os.homedir(), 'hotsound-profile.json'),
      filters: [{ name: 'HotSound profile', extensions: ['json'] }]
    }).then(
      (res) => log(`save dialog resolved canceled=${res && res.canceled} filePath=${res && res.filePath}`),
      (err) => log(`!!! save dialog rejected: ${err && err.message}`)
    );
    log('opened SAVE dialog (parented)');
  } else if (VARIANT === 'savepicker') {
    // File System Access API: Chromium's own save picker rather than the shell's.
    const res = await win.webContents.executeJavaScript(
      `(async () => {
         if (typeof window.showSaveFilePicker !== 'function') return { available: false };
         try {
           const handle = await window.showSaveFilePicker({ suggestedName: 'hotsound-profile.json' });
           return { available: true, picked: true, name: handle.name };
         } catch (err) {
           return { available: true, picked: false, error: err.name + ': ' + err.message };
         }
       })()`,
      true
    );
    log('saveFilePicker result: ' + JSON.stringify(res));
  } else if (VARIANT === 'noparent') {
    // Same dialog options as the app, but with no parent window (so, not modal).
    const opts = {
      title: 'Assign sounds to slots',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a'] },
        { name: 'All files', extensions: ['*'] }
      ]
    };
    dialog.showOpenDialog(opts).then(
      (res) => log(`dialog resolved canceled=${res && res.canceled}`),
      (err) => log(`!!! dialog rejected: ${err && err.message}`)
    );
    log('opened dialog with NO parent window');
  } else {
    const real = dialog.showOpenDialog;
    dialog.showOpenDialog = function patched(...args) {
      const p = real.apply(this, args);
      p.then(
        (res) => log(`dialog resolved canceled=${res && res.canceled}`),
        (err) => log(`!!! dialog rejected: ${err && err.message}`)
      );
      return p;
    };
    // Drive the app's real click-to-add path (parented modal dialog).
    const code = await win.webContents.executeJavaScript(
      `(() => { const k = document.querySelector('.key:not(.muted).empty'); if (!k) return 'no empty key'; k.click(); return k.dataset.code; })()`,
      true
    );
    log(`clicked empty slot ${code} (parented modal dialog)`);
  }

  await new Promise((r) => setTimeout(r, 2200));
  log('dismissing dialog...');
  await dismissDialog(appPids());
  await new Promise((r) => setTimeout(r, 3000));

  let alive = false;
  try {
    alive = !win.isDestroyed();
  } catch {
    alive = false;
  }
  log('window alive after dismiss: ' + alive);

  if (alive) {
    try {
      const state = await win.webContents.executeJavaScript(
        `JSON.stringify({
           probe: window.__cancelProbe ? window.__cancelProbe.events : null,
           emptyKeys: document.querySelectorAll('.key:not(.muted).empty').length,
           status: (document.getElementById('status-msg') || {}).textContent
         })`,
        true
      );
      log('renderer state: ' + state);
    } catch (err) {
      log('renderer state: threw ' + err.message);
    }
  }

  log(alive ? 'RESULT: SURVIVED' : 'RESULT: DEAD');
  app.exit(alive ? 0 : 1);
}

module.exports = { run };
