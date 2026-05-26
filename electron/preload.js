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
  // sidebar lives in a separate BrowserView; the dashboard never
  // touches the terminal directly, only opens/closes the pane and
  // persists its credential.
  sidebar: {
    toggle: () => ipcRenderer.invoke('sidebar:toggle'),
    show: () => ipcRenderer.invoke('sidebar:show'),
    hide: () => ipcRenderer.invoke('sidebar:hide'),
    state: () => ipcRenderer.invoke('sidebar:state'),

    // Save a sidebar-only API key. Used when the dashboard was
    // bootstrapped via Clerk (no shared trve_... key); the user mints
    // an API key in Manage → API Keys and pastes it here. Triggers a
    // PTY respawn so the new key takes effect immediately.
    //
    // Today the only caller is the user typing in DevTools — a
    // proper dialog UI is a follow-up.
    saveKey: (plaintextKey) => ipcRenderer.invoke('sidebar:save-key', plaintextKey),
  },
});
