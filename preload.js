'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * The renderer runs with contextIsolation. Everything it may do lives here so
 * the surface stays explicit and auditable.
 */
const api = {
  loadProfile: () => ipcRenderer.invoke('hotsound:load-profile'),
  saveProfile: (profile) => ipcRenderer.invoke('hotsound:save-profile', profile),
  /** Save As: opens the Windows dialog unless a target path is supplied. */
  saveProfileAs: (profile, targetPath) => ipcRenderer.invoke('hotsound:save-profile-as', profile, targetPath),
  profilePath: () => ipcRenderer.invoke('hotsound:profile-path'),

  readAudio: (filePath) => ipcRenderer.invoke('hotsound:read-audio', filePath),
  fileExists: (filePath) => ipcRenderer.invoke('hotsound:file-exists', filePath),
  setActiveProfile: (filePath) => ipcRenderer.invoke('hotsound:set-active-profile', filePath),
  appInfo: () => ipcRenderer.invoke('hotsound:app-info'),
  openExternal: (url) => ipcRenderer.invoke('hotsound:open-external', url),
  revealProfile: () => ipcRenderer.invoke('hotsound:reveal-profile'),

  syncGlobals: (bindings) => ipcRenderer.invoke('hotsound:sync-globals', bindings),
  onGlobalTrigger: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('hotsound:global-trigger', listener);
    return () => ipcRenderer.removeListener('hotsound:global-trigger', listener);
  },

  /** Dropped-file -> absolute path. Electron >= 32 removed File.path. */
  pathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch {
      /* fall through to legacy property */
    }
    return file && typeof file.path === 'string' ? file.path : '';
  },

  reportSmoke: (report) => ipcRenderer.send('hotsound:smoke-report', report),
  isSmokeTest: process.argv.includes('--hotsound-smoke'),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
};

contextBridge.exposeInMainWorld('hotsound', api);
