// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script for the DASHBOARD webapp view (the main pane). Runs
 * with Node access and exposes a small, vetted API to the renderer
 * via contextBridge. The sidebar pane has its own preload at
 * sidebar-preload.js with a different API surface.
 */
contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
  version: process.env.npm_package_version || '1.0.0',
  platform: process.platform,

  // Secure credential storage (unchanged from pre-sidebar build).
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  clearConfig: () => ipcRenderer.invoke('clear-config'),

  // Claude Code sidebar — the dashboard React app calls these to
  // toggle the right-hand sidebar that hosts the `claude` CLI. The
  // sidebar lives in a separate WebContentsView; the dashboard never
  // touches the terminal directly, only opens/closes the pane.
  sidebar: {
    toggle: () => ipcRenderer.invoke('sidebar:toggle'),
    show: () => ipcRenderer.invoke('sidebar:show'),
    hide: () => ipcRenderer.invoke('sidebar:hide'),
    state: () => ipcRenderer.invoke('sidebar:state'),
  },
});
