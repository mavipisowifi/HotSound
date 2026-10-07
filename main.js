'use strict';

const { app, BrowserWindow, ipcMain, dialog, globalShortcut, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const IS_SMOKE_TEST = process.argv.includes('--smoke-test');
const IS_E2E_TEST = process.argv.includes('--e2e-test');
const IS_MEMORY_DIAG = process.argv.includes('--diagnose-memory');
const IS_REPRO_CANCEL = process.argv.some((a) => a.startsWith('--repro-cancel'));

/** @type {BrowserWindow|null} */
let mainWindow = null;

/* ------------------------------------------------------------------ *
 * Profile storage
 *
 * The active profile may live anywhere the user chose. Its location is kept in a
 * small settings file next to the app's data, so a profile saved to the Desktop
 * is still the one that opens next launch.
 * ------------------------------------------------------------------ */

function defaultProfilePath() {
  return path.join(app.getPath('userData'), 'hotsound-profile.json');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'hotsound-settings.json');
}

let activeProfilePath = null;
let lastDialogDir = null;

async function readProfileFile(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[HotSound] profile read failed:', filePath, err.message);
    }
    return null;
  }
}

async function readSettings() {
  try {
    return JSON.parse(await fsp.readFile(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeSettings(next) {
  try {
    await fsp.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('[HotSound] settings write failed:', err.message);
  }
}

/** Where the active profile lives, remembering the user's choice across launches. */
async function getActiveProfilePath() {
  if (activeProfilePath) return activeProfilePath;
  const settings = await readSettings();
  const saved = settings.activeProfilePath;
  activeProfilePath = typeof saved === 'string' && path.isAbsolute(saved) ? saved : defaultProfilePath();
  return activeProfilePath;
}

async function setActiveProfilePath(filePath) {
  activeProfilePath = filePath;
  lastDialogDir = path.dirname(filePath);
  const settings = await readSettings();
  settings.activeProfilePath = filePath;
  await writeSettings(settings);
}

async function writeProfileTo(filePath, profile) {
  // The save dialog can hand back a folder the user just typed, so make sure the
  // destination exists before writing through a temp file next to it.
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(profile, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
  return true;
}

async function readProfile() {
  const active = await getActiveProfilePath();
  const profile = await readProfileFile(active);
  if (profile) return { profile, path: active, fellBack: false };

  // A profile saved to a drive that is gone must not lose the working copy.
  const fallback = defaultProfilePath();
  if (active !== fallback) {
    const fallbackProfile = await readProfileFile(fallback);
    activeProfilePath = fallback;
    return { profile: fallbackProfile, path: fallback, fellBack: true, missing: active };
  }
  return { profile: null, path: active, fellBack: false };
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#0e1a14',
    title: 'HotSound',
    icon: path.join(__dirname, 'assets', 'logo-square.png'),
    autoHideMenuBar: true,
    show: !IS_SMOKE_TEST,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      // The renderer cannot see the app's own argv, so the smoke flag travels here.
      additionalArguments: IS_SMOKE_TEST ? ['--hotsound-smoke'] : []
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // The diagnostic harnesses live in tools/ and test/, which are not shipped.
  const hasTools = fs.existsSync(path.join(__dirname, 'tools'));
  const hasTests = fs.existsSync(path.join(__dirname, 'test', 'e2e.js'));

  if (IS_SMOKE_TEST) {
    runSmokeTest(mainWindow);
  }

  if (IS_E2E_TEST && hasTests) {
    attachRendererLogger(mainWindow, (line) => console.log('  ' + line));
    const timer = setTimeout(() => {
      console.error('E2E FAIL: timed out');
      app.exit(6);
    }, 60000);
    require('./test/e2e')
      .run(mainWindow)
      .catch((err) => {
        console.error('E2E FAIL: ' + err.message);
        clearTimeout(timer);
        app.exit(7);
      })
      .finally(() => clearTimeout(timer));
  }

  if (IS_REPRO_CANCEL && hasTools) {
    require('./tools/repro-cancel')
      .run(mainWindow)
      .catch((err) => {
        console.error('REPRO FAIL: ' + err.message);
        app.exit(9);
      });
  }

  if (IS_MEMORY_DIAG && hasTools) {
    require('./tools/diagnose-memory')
      .run(mainWindow)
      .catch((err) => {
        console.error('MEMORY DIAG FAIL: ' + err.message);
        app.exit(8);
      });
  }
}

/** Forward renderer console output and load failures to the terminal. */
function attachRendererLogger(win, log) {
  win.webContents.on('console-message', (...args) => {
    // Electron changed this signature to (event, details); support both.
    const details = args[1];
    if (details && typeof details === 'object' && 'message' in details) {
      log(`[console:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    } else {
      log(`[console:${args[1]}] ${args[2]} (${args[4]}:${args[3]})`);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`render-process-gone ${JSON.stringify(details)}`);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    log(`preload-error ${preloadPath} ${error && error.message}`);
  });
}

function runSmokeTest(win) {
  const findings = [];
  const log = (line) => {
    findings.push(line);
    console.log('  ' + line);
  };

  attachRendererLogger(win, log);
  const finish = (code, message) => {
    clearTimeout(timer);
    if (message) console.log(message);
    if (findings.length) {
      console.log('--- renderer diagnostics ---');
      for (const line of findings) console.log('  ' + line);
    }
    app.exit(code);
  };

  const timer = setTimeout(async () => {
    // Last resort: ask the page what state it is in.
    try {
      const probe = await win.webContents.executeJavaScript(
        `JSON.stringify({
           hasHS: typeof window.HS,
           hasLayout: !!(window.HS && window.HS.layout),
           hasApi: typeof window.hotsound,
           hasApp: !!(window.HS && window.HS.app),
           readyState: document.readyState,
           keys: window.HS && window.HS.layout ? window.HS.layout.KEYS.length : -1,
           domKeys: document.querySelectorAll('.key').length,
           status: (document.getElementById('status-msg') || {}).textContent || null
         })`,
        true
      );
      log('PROBE ' + probe);
    } catch (err) {
      log('PROBE FAILED ' + err.message);
    }
    finish(3, 'SMOKE FAIL: renderer did not report ready within 25s');
  }, 25000);

  ipcMain.once('hotsound:smoke-report', (_e, report) => {
    console.log('SMOKE REPORT: ' + JSON.stringify(report, null, 2));
    if (report.errors && report.errors.length) {
      finish(4, 'SMOKE FAIL: renderer reported errors');
      return;
    }
    finish(0, 'SMOKE OK');
  });
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

/** Global accelerators are opt-in per slot: a bound standalone key would
 *  otherwise be swallowed system wide, which breaks typing everywhere else. */
const registeredGlobals = new Map();

function unregisterAllGlobals() {
  for (const [accel] of registeredGlobals) {
    try {
      globalShortcut.unregister(accel);
    } catch {
      /* ignore */
    }
  }
  registeredGlobals.clear();
}

function syncGlobalShortcuts(bindings) {
  unregisterAllGlobals();
  const failed = [];
  for (const { accelerator, slotId } of bindings || []) {
    if (!accelerator) continue;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('hotsound:global-trigger', { slotId, accelerator });
        }
      });
      if (ok) registeredGlobals.set(accelerator, slotId);
      else failed.push(accelerator);
    } catch {
      failed.push(accelerator);
    }
  }
  return { registered: [...registeredGlobals.keys()], failed };
}

ipcMain.handle('hotsound:load-profile', () => readProfile());

ipcMain.handle('hotsound:profile-path', async () => {
  const active = await getActiveProfilePath();
  return { path: active, isDefault: active === defaultProfilePath() };
});

/** Silent save: writes to whichever profile is active, no dialog. */
ipcMain.handle('hotsound:save-profile', async (_e, profile) => {
  const active = await getActiveProfilePath();
  await writeProfileTo(active, profile);
  return { ok: true, path: active };
});

/**
 * Save As. Opens the Windows file dialog so the profile can be written anywhere,
 * and that location becomes the active profile. `targetPath` bypasses the dialog
 * for callers that already know where to write (tests, programmatic saves).
 */
ipcMain.handle('hotsound:save-profile-as', async (_e, profile, targetPath) => {
  let target = typeof targetPath === 'string' && targetPath ? targetPath : null;

  if (!target) {
    const active = await getActiveProfilePath();
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save HotSound profile',
      defaultPath: path.join(lastDialogDir || path.dirname(active), path.basename(active)),
      filters: [
        { name: 'HotSound profile', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    target = res.filePath;
  }

  if (!path.isAbsolute(target)) return { ok: false, error: 'Path must be absolute' };
  try {
    await writeProfileTo(target, profile);
    await setActiveProfilePath(target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Remember where the active profile lives. The profile file itself is chosen and
 * read by the renderer: Electron's own open dialog segfaults this process when it
 * is dismissed (see README "Why there is no shell open dialog"), so no shell open
 * dialog is used anywhere in this app.
 */
ipcMain.handle('hotsound:set-active-profile', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return { ok: false, error: 'Path must be absolute' };
  }
  await setActiveProfilePath(filePath);
  return { ok: true, path: filePath };
});

ipcMain.handle('hotsound:app-info', () => {
  let pkg = {};
  try {
    pkg = require('./package.json');
  } catch {
    /* a packaged app always carries it; Electron's own metadata is the fallback */
  }
  const author = pkg.author && typeof pkg.author === 'object' ? pkg.author : { name: pkg.author };
  return {
    name: app.getName(),
    version: app.getVersion(),
    developer: author.name || '',
    developerUrl: author.url || pkg.homepage || '',
    copyright: pkg.copyright || ''
  };
});

/** Open a link in the user's browser. Only http(s) is accepted. */
ipcMain.handle('hotsound:open-external', async (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Only http and https links can be opened' };
  }
  try {
    await shell.openExternal(url);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('hotsound:read-audio', async (_e, filePath) => {
  try {
    const buf = await fsp.readFile(filePath);
    return { ok: true, data: buf, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('hotsound:file-exists', async (_e, filePath) => {
  try {
    await fsp.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('hotsound:sync-globals', (_e, bindings) => syncGlobalShortcuts(bindings));

ipcMain.handle('hotsound:reveal-profile', async () => {
  const active = await getActiveProfilePath();
  try {
    await fsp.access(active, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(active, '{}', 'utf8');
  }
  shell.showItemInFolder(active);
  return active;
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  // Under test, a held lock means the checks cannot run at all. Fail loudly:
  // a silent quit here would look like a pass to the caller.
  if (IS_SMOKE_TEST || IS_E2E_TEST) {
    console.error(
      'TEST FAIL: another HotSound instance is already running and holds the single-instance lock.\n' +
        '           Close it (or kill the stray electron.exe) and re-run.'
    );
    app.exit(9);
  } else {
    app.quit();
  }
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    unregisterAllGlobals();
  });
}
