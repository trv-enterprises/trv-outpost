// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Electron 28 ships BrowserView (the pre-WebContentsView API). 30+ has
// the new BaseWindow + WebContentsView primitives; we'd switch when
// the project bumps Electron. For now BrowserView is stable, well-
// tested, and works the same way: one BrowserWindow, two BrowserViews
// side-by-side, bounds set explicitly from the main process.
const { app, BrowserWindow, BrowserView, ipcMain, safeStorage, screen, globalShortcut } = require('electron');
const path = require('path');
const Store = require('electron-store');
const os = require('os');

// Initialize electron-store for persistent storage (existing credential-store flow)
const store = new Store({
  name: 'trve-dashboards-config',
  encryptionKey: 'trve-dashboards-v1',
});

const isDev = process.env.ELECTRON_DEV === 'true';

// --------- Layout constants ---------

// Width of the right-hand Claude Code sidebar in pixels. Persisted to
// electron-store so the user's preferred width survives restarts.
const SIDEBAR_DEFAULT_WIDTH = 480;
const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_FRACTION = 0.7; // Sidebar can't claim more than 70% of the window.

// Width of the drag-handle strip on the sidebar's left edge.
const DRAG_HANDLE_WIDTH = 6;

// --------- Window + view state ---------

let mainWindow = null;
let dashboardView = null;
let sidebarView = null;

// Sidebar shown/hidden state. Hiding does NOT destroy the view —
// keeps the PTY session alive underneath, so toggling is cheap and
// preserves scrollback / in-progress commands.
let sidebarVisible = false;
let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;

// Drag-resize state. The user grabs the sidebar's left-edge drag
// handle; the sidebar renderer fires `sidebar:drag-start` and we
// poll the global cursor position from main until `sidebar:drag-end`.
let dragPollInterval = null;

// --------- PTY session state ---------

// node-pty is loaded lazily so the app can still launch and surface
// a useful error in the sidebar pane when the native module fails to
// load (e.g. unrebuilt against the current Electron version, or the
// universal-arch lipo step was skipped in packaging).
let pty = null;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (err) {
  ptyLoadError = err;
  console.error('[sidebar] node-pty failed to load:', err);
}

let ptyProcess = null;

/**
 * Spawn the `claude` CLI as a PTY, stripping any API-key env so the
 * CLI uses the user's subscription credentials instead of billing the
 * Anthropic Console. Returns the spawned IPty or null on failure.
 */
function spawnClaudeCLI() {
  if (!pty) return null;

  // Subscription-billing guard: if either of these is set in the
  // parent env, the spawned `claude` would use the API key path and
  // charge the Console account instead of the user's subscription.
  // Stripping is the entire point of hosting Claude Code in the
  // sidebar; if we ever skip this, billing flips silently.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  // Claude Code discovers .mcp.json relative to cwd, so the sidebar's
  // working directory determines which MCP servers light up. Default
  // to the dashboard repo so this sidebar's whole point — talking to
  // the running dashboard via the MCP server we ship in this repo —
  // works out of the box. Override via the TRVE_SIDEBAR_CWD env var
  // if you want the sidebar to land somewhere else (e.g. a personal
  // scratch dir with a different .mcp.json).
  //
  // electron/main.js lives at <repo>/electron/main.js, so the repo
  // root is one directory up.
  const cwd = process.env.TRVE_SIDEBAR_CWD || path.dirname(__dirname);
  const shell = process.env.SHELL || '/bin/zsh';

  try {
    // Spawn through the user's shell so login PATH (Homebrew, asdf,
    // etc.) is set up the same way as a Terminal.app session. `-l`
    // (login) is what makes `claude` resolve on PATH for users who
    // installed it via brew without it being on the system PATH.
    return pty.spawn(shell, ['-l', '-c', 'claude'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env,
    });
  } catch (err) {
    console.error('[sidebar] Failed to spawn claude CLI:', err);
    return null;
  }
}

// --------- View layout ---------

/**
 * Compute and apply the bounds for the dashboard and sidebar views
 * based on the current window size and sidebar visibility/width.
 * Called on window resize, sidebar toggle, and drag.
 */
function layoutViews() {
  if (!mainWindow) return;
  const { width, height } = mainWindow.getContentBounds();
  const sbWidth = sidebarVisible ? sidebarWidth : 0;

  if (dashboardView) {
    dashboardView.setBounds({ x: 0, y: 0, width: width - sbWidth, height });
  }
  if (sidebarView) {
    sidebarView.setBounds({ x: width - sbWidth, y: 0, width: sbWidth, height });
  }

  // Pixel-based PTY resize approximation. The renderer's fit-addon
  // recomputes accurate cols/rows from real font metrics and sends
  // a `pty:resize` follow-up shortly after, which overrides this.
  if (ptyProcess && sidebarVisible && sbWidth > 0) {
    const cols = Math.max(20, Math.floor((sbWidth - DRAG_HANDLE_WIDTH) / 9));
    const rows = Math.max(10, Math.floor(height / 17));
    try { ptyProcess.resize(cols, rows); } catch {}
  }
}

// --------- Drag-resize ---------

function startSidebarDrag() {
  if (dragPollInterval) return;
  // Poll the global cursor at ~60fps. Cheaper than installing a
  // global mouse-move listener and gracefully degrades if the user
  // alt-tabs away mid-drag (the next click ends the drag because
  // sidebar's mouseup fires on focus return).
  dragPollInterval = setInterval(() => {
    if (!mainWindow) return endSidebarDrag();
    const winBounds = mainWindow.getContentBounds();
    const winPos = mainWindow.getPosition();
    const cursor = screen.getCursorScreenPoint();
    // Convert screen-space cursor to window-content-space.
    const localX = cursor.x - winPos[0];
    // Sidebar width = distance from cursor to right edge of window.
    let newWidth = winBounds.width - localX;
    const maxWidth = Math.floor(winBounds.width * SIDEBAR_MAX_FRACTION);
    newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, newWidth));
    if (newWidth !== sidebarWidth) {
      sidebarWidth = newWidth;
      layoutViews();
    }
  }, 16);
}

function endSidebarDrag() {
  if (dragPollInterval) {
    clearInterval(dragPollInterval);
    dragPollInterval = null;
    store.set('sidebar.width', sidebarWidth);
  }
}

// --------- Sidebar visibility ---------

function setSidebarVisible(visible) {
  sidebarVisible = visible;
  store.set('sidebar.visible', visible);
  layoutViews();
  if (visible) ensurePtyStarted();
}

function ensurePtyStarted() {
  if (ptyProcess) return;
  if (!pty) {
    sidebarView?.webContents.send('pty:error',
      `node-pty failed to load: ${ptyLoadError?.message || 'unknown error'}.\n\n` +
      `Reinstall the Electron module: \`cd electron && npm install\`.`);
    return;
  }

  ptyProcess = spawnClaudeCLI();
  if (!ptyProcess) {
    sidebarView?.webContents.send('pty:error',
      `Failed to spawn \`claude\` — make sure the CLI is installed and on PATH.\n` +
      `Try \`brew install claude\` (or the install command for your platform), then re-open the sidebar.`);
    return;
  }
  ptyProcess.onData((data) => {
    sidebarView?.webContents.send('pty:data', data);
  });
  ptyProcess.onExit(({ exitCode, signal }) => {
    sidebarView?.webContents.send('pty:exit', { exitCode, signal });
    ptyProcess = null;
  });
}

// --------- Window creation ---------

function createWindow() {
  // Restore last-known sidebar state.
  sidebarVisible = store.get('sidebar.visible', false);
  sidebarWidth = store.get('sidebar.width', SIDEBAR_DEFAULT_WIDTH);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    // Standard macOS title bar (no hiddenInset). The two BrowserViews
    // would otherwise paint over a chromeless inset's drag region,
    // leaving the window un-movable. In fullscreen the title bar
    // auto-hides anyway, so the kiosk / wall-display experience is
    // unchanged — only windowed mode gets the visible title strip.
    backgroundColor: '#161616',
    show: false,
  });

  // Dashboard view — the existing webapp. Loaded the same way the
  // pre-sidebar build did (dev = vite, prod = packaged HTML).
  dashboardView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.addBrowserView(dashboardView);

  if (isDev) {
    dashboardView.webContents.loadURL('http://localhost:5173');
    dashboardView.webContents.openDevTools({ mode: 'detach' });
  } else {
    dashboardView.webContents.loadFile(path.join(process.resourcesPath, 'app', 'index.html'));
  }

  // Sidebar view — local HTML hosting xterm.js. Always created (so
  // the PTY can be kept alive across show/hide); positioned off-canvas
  // when sidebarVisible is false.
  //
  // sandbox: false here is deliberate. The preload script uses
  // contextBridge to expose only a small, vetted API to the
  // renderer — sandboxing the renderer doesn't gain us anything
  // (we're loading our own bundled HTML, not arbitrary web content)
  // but DOES break some preload features. The dashboard renderer
  // stays sandboxed because it loads remote content.
  sidebarView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'sidebar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.addBrowserView(sidebarView);
  sidebarView.webContents.loadFile(path.join(__dirname, 'sidebar', 'index.html'));

  if (isDev) {
    sidebarView.webContents.openDevTools({ mode: 'detach' });
  }

  // Initial layout + resize handler.
  mainWindow.once('ready-to-show', () => {
    layoutViews();
    mainWindow.show();
    if (sidebarVisible) ensurePtyStarted();
  });
  mainWindow.on('resize', layoutViews);

  mainWindow.on('closed', () => {
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch {}
      ptyProcess = null;
    }
    if (dragPollInterval) {
      clearInterval(dragPollInterval);
      dragPollInterval = null;
    }
    mainWindow = null;
    dashboardView = null;
    sidebarView = null;
  });
}

// BrowserWindow's `ready-to-show` doesn't fire when content is loaded
// into a BrowserView (only when the window's own webContents finishes).
// Wire it from the dashboard view's webContents so the existing
// "no white flash" UX is preserved.
function bridgeReadyToShow() {
  if (!dashboardView || !mainWindow) return;
  dashboardView.webContents.once('did-finish-load', () => {
    mainWindow.emit('ready-to-show');
  });
}

// --------- IPC handlers ---------

// Existing credential-storage handlers (unchanged from the
// pre-sidebar build — preload.js exposes these on `window.electron`).
ipcMain.handle('get-config', async () => {
  try {
    const config = store.get('credentials');
    if (!config) return null;
    if (config.encryptedKey && safeStorage.isEncryptionAvailable()) {
      try {
        const decryptedKey = safeStorage.decryptString(Buffer.from(config.encryptedKey, 'base64'));
        return { serverUrl: config.serverUrl, key: decryptedKey, userName: config.userName };
      } catch (err) {
        console.error('Failed to decrypt key:', err);
        return null;
      }
    }
    return { serverUrl: config.serverUrl, key: config.key, userName: config.userName };
  } catch (err) {
    console.error('Failed to get config:', err);
    return null;
  }
});

ipcMain.handle('save-config', async (event, config) => {
  try {
    const { serverUrl, key, userName } = config;
    if (safeStorage.isEncryptionAvailable()) {
      const encryptedKey = safeStorage.encryptString(key).toString('base64');
      store.set('credentials', { serverUrl, encryptedKey, userName });
    } else {
      console.warn('safeStorage not available, storing key unencrypted');
      store.set('credentials', { serverUrl, key, userName });
    }
    return true;
  } catch (err) {
    console.error('Failed to save config:', err);
    return false;
  }
});

ipcMain.handle('clear-config', async () => {
  try {
    store.delete('credentials');
    return true;
  } catch (err) {
    console.error('Failed to clear config:', err);
    return false;
  }
});

// Sidebar visibility — exposed to the DASHBOARD renderer via
// preload.js so the dashboard's React UI can offer a toggle button.
ipcMain.handle('sidebar:toggle', () => {
  setSidebarVisible(!sidebarVisible);
  return sidebarVisible;
});
ipcMain.handle('sidebar:show', () => { setSidebarVisible(true); return true; });
ipcMain.handle('sidebar:hide', () => { setSidebarVisible(false); return false; });
ipcMain.handle('sidebar:state', () => ({ visible: sidebarVisible, width: sidebarWidth }));

// PTY I/O — exposed to the SIDEBAR renderer via sidebar-preload.js.
ipcMain.on('pty:input', (event, data) => {
  if (ptyProcess) {
    try { ptyProcess.write(data); } catch (err) { console.error('[pty] write failed:', err); }
  }
});
ipcMain.on('pty:resize', (event, { cols, rows }) => {
  // Renderer's fit-addon computes the true char-grid; honor it over
  // the pixel approximation in layoutViews().
  if (ptyProcess && cols > 0 && rows > 0) {
    try { ptyProcess.resize(cols, rows); } catch {}
  }
});

// Drag-resize handshake — sidebar mousedown on the left edge starts
// the global cursor poll; mouseup or window blur ends it.
ipcMain.on('sidebar:drag-start', startSidebarDrag);
ipcMain.on('sidebar:drag-end', endSidebarDrag);

// --------- App lifecycle ---------

app.whenReady().then(() => {
  createWindow();
  bridgeReadyToShow();

  // Cmd+Shift+/ toggles the Claude Code sidebar. Same affordance as
  // many IDEs ("show terminal pane"); convenient when you don't want
  // to dig through DevTools to call the IPC manually. The React
  // dashboard can also wire its own toggle button via
  // window.electron.sidebar.toggle().
  globalShortcut.register('CommandOrControl+Shift+/', () => {
    setSidebarVisible(!sidebarVisible);
  });

  // Cmd+Alt+I opens DevTools for the SIDEBAR pane. The default
  // Cmd+Alt+I targets whatever has focus; with BrowserViews stacked,
  // focus routing is unreliable, so we force the sidebar's tools
  // explicitly. Cmd+Alt+Shift+I opens the DASHBOARD's.
  globalShortcut.register('CommandOrControl+Alt+I', () => {
    if (sidebarView) sidebarView.webContents.openDevTools({ mode: 'detach' });
  });
  globalShortcut.register('CommandOrControl+Alt+Shift+I', () => {
    if (dashboardView) dashboardView.webContents.openDevTools({ mode: 'detach' });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      bridgeReadyToShow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
