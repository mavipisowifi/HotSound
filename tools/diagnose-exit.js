'use strict';

/**
 * Diagnostic: what can close the window while the app is in normal use?
 *
 * The app deliberately lets modifier combos through to the OS, on the assumption
 * that they are the user's. Electron's default application menu is still present
 * (autoHideMenuBar only hides it), and that menu owns accelerators such as
 * Ctrl+W and Ctrl+Q. This checks whether those actually reach the window.
 *
 * Run with: electron tools/diagnose-exit.js
 */

const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('node:path');

// Stand-ins so the renderer boots without the real main process.
for (const ch of ['hotsound:load-profile', 'hotsound:sync-globals', 'hotsound:save-profile', 'hotsound:file-exists']) {
  ipcMain.handle(ch, () => null);
}
// Keep the app alive when a probe window closes, or the first hit ends the run.
app.on('window-all-closed', () => {});

const results = [];

function makeWindow() {
  return new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    autoHideMenuBar: true, // same as the real app
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
}

function send(win, keyCode, modifiers, type = 'keyDown') {
  win.webContents.sendInputEvent({ type, keyCode, modifiers });
  if (type === 'keyDown') {
    win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }
}

async function probe(label, keyCode, modifiers) {
  const win = makeWindow();
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 400));

  let closed = false;
  let reloaded = false;
  win.once('closed', () => {
    closed = true;
  });
  win.webContents.on('did-start-navigation', () => {
    reloaded = true;
  });

  send(win, keyCode, modifiers);
  await new Promise((r) => setTimeout(r, 900));

  const stillOpen = !win.isDestroyed() && !closed;
  const row = {
    label,
    combo: (modifiers.length ? modifiers.join('+') + '+' : '') + keyCode,
    closedTheWindow: !stillOpen,
    reloaded
  };
  results.push(row);
  console.log(`PROBE  ${row.combo.padEnd(22)} closedWindow=${row.closedTheWindow}  reloaded=${row.reloaded}   [${label}]`);
  if (stillOpen) win.destroy();
  await new Promise((r) => setTimeout(r, 150));
}

app.whenReady().then(async () => {
  const menu = Menu.getApplicationMenu();
  console.log('Application menu present: ' + !!menu);
  if (menu) {
    const accels = [];
    const walk = (items) => {
      for (const it of items) {
        if (it.accelerator) accels.push(`${it.label || it.role || '?'} = ${it.accelerator}`);
        else if (it.role) accels.push(`${it.label || it.role} (role ${it.role}, no explicit accelerator)`);
        if (it.submenu) walk(it.submenu.items);
      }
    };
    walk(menu.items);
    console.log('Menu accelerators registered:');
    for (const a of accels) console.log('  ' + a);
  }

  await probe('close-window', 'W', ['control']);
  await probe('reload', 'R', ['control']);
  await probe('quit', 'Q', ['control']);
  await probe('devtools', 'I', ['control', 'shift']);
  await probe('plain-key-control (should not close)', 'A', []);

  console.log('\nResults');
  console.log('=======');
  for (const r of results) {
    console.log(`${r.combo.padEnd(24)} closedWindow=${String(r.closedTheWindow).padEnd(6)} reloaded=${r.reloaded}   [${r.label}]`);
  }
  const dangerous = results.filter((r) => r.closedTheWindow);
  console.log('\n' + (dangerous.length
    ? `FOUND ${dangerous.length} combo(s) that close the window: ${dangerous.map((d) => d.combo).join(', ')}`
    : 'No closing combo found.'));
  app.exit(0);
});
