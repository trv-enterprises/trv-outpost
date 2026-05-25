// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script for the SIDEBAR view — the right-hand pane that
 * hosts the `claude` CLI in xterm.js. The renderer talks to the PTY
 * (which lives in the main process) through this bridge.
 *
 * Three channels:
 *   1. PTY I/O — bidirectional. main sends `pty:data` and `pty:exit`
 *      and `pty:error`; renderer sends `pty:input` and `pty:resize`.
 *   2. Drag handshake — the renderer's drag handle sends
 *      `sidebar:drag-start` on mousedown and `sidebar:drag-end` on
 *      mouseup. Main polls the cursor in between and updates the
 *      view bounds.
 *   3. (none) — no credential or config access; the sidebar pane
 *      doesn't need it.
 */
contextBridge.exposeInMainWorld('sidebarBridge', {
  // PTY I/O — the xterm.js instance pipes user input to `input()`
  // and renders bytes received via the `onData` callback.
  pty: {
    input: (data) => ipcRenderer.send('pty:input', data),
    resize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),

    onData: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('pty:data', handler);
      // Return an unsubscribe so a hot-reload doesn't pile listeners.
      return () => ipcRenderer.off('pty:data', handler);
    },
    onExit: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('pty:exit', handler);
      return () => ipcRenderer.off('pty:exit', handler);
    },
    onError: (cb) => {
      const handler = (_event, msg) => cb(msg);
      ipcRenderer.on('pty:error', handler);
      return () => ipcRenderer.off('pty:error', handler);
    },
  },

  // Drag handshake — fires while the user is resizing the sidebar
  // from its left-edge handle. Main polls the global cursor between
  // start and end; the renderer doesn't need to send move events.
  drag: {
    start: () => ipcRenderer.send('sidebar:drag-start'),
    end: () => ipcRenderer.send('sidebar:drag-end'),
  },
});
