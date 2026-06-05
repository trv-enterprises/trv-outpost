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
const fs = require('fs');
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

// --------- Sidebar workspace bootstrap ---------

/**
 * Path to the user-data sidebar workspace dir. Claude Code is spawned
 * with this as its cwd, so the `.mcp.json` and `CLAUDE.md` here are
 * what its session sees. The dir is created lazily on first launch by
 * copying from the packaged template at
 * electron/resources/sidebar-workspace-template/.
 *
 * Lives under app.getPath('userData') so it's writable in a packaged
 * macOS app (the .app bundle itself is read-only after signing).
 */
function sidebarWorkspaceDir() {
  // Allow override for dev / debugging.
  return process.env.TRVE_SIDEBAR_CWD ||
    path.join(app.getPath('userData'), 'sidebar-workspace');
}

/**
 * Path to the packaged template dir.
 *
 * In dev (`npm run dev`), __dirname is `<repo>/electron/`, so we
 * resolve normally to `electron/resources/sidebar-workspace-template/`.
 *
 * In a packaged production build, electron-builder packs the source
 * tree into `Contents/Resources/app.asar`, but our `asarUnpack`
 * setting in package.json extracts the template dir loose to
 * `Contents/Resources/app.asar.unpacked/resources/sidebar-workspace-template/`.
 * fs.cpSync's recursive copy doesn't read across the asar virtual
 * filesystem cleanly, so we explicitly redirect to the unpacked path
 * when running inside a packaged app.
 */
function sidebarWorkspaceTemplateDir() {
  const fromDirname = path.join(__dirname, 'resources', 'sidebar-workspace-template');
  // In a packaged build, __dirname includes "app.asar"; the unpacked
  // sibling is the dir we actually want for recursive fs.cpSync.
  if (fromDirname.includes(`${path.sep}app.asar${path.sep}`)) {
    return fromDirname.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`
    );
  }
  return fromDirname;
}

/**
 * Copy a directory recursively. Used to populate the workspace from
 * the template. Node 16+ has fs.cpSync; we're on a much newer runtime
 * via Electron's bundled Node, so it's fine to rely on it.
 */
function copyDirSync(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * Ensure the sidebar workspace dir exists. If it doesn't, copy the
 * packaged template into it. Subsequent launches skip this entirely —
 * the user may have customized .mcp.json or added their own files,
 * and we don't want to clobber that.
 *
 * Returns the resolved workspace path. Throws (caught upstream) if
 * something unrecoverable happens, e.g. permission errors.
 */
function ensureSidebarWorkspace() {
  const workspace = sidebarWorkspaceDir();
  if (!fs.existsSync(workspace)) {
    const template = sidebarWorkspaceTemplateDir();
    if (!fs.existsSync(template)) {
      console.warn('[sidebar] template dir missing — workspace created empty:', template);
      fs.mkdirSync(workspace, { recursive: true });
    } else {
      console.log('[sidebar] populating workspace from template:', template, '→', workspace);
      copyDirSync(template, workspace);
    }
  }
  return workspace;
}

// --------- Credential resolution ---------

/**
 * Resolve the credentials Claude Code should use to talk to the
 * dashboard MCP server. Two shapes the dashboard webapp may have
 * left in electron-store, plus a sidebar-only fallback:
 *
 *   case (a) — API-key-bootstrapped dashboard:
 *     credentials.key starts with "trve_". Sidebar reuses it.
 *   case (b) — Clerk-bootstrapped dashboard:
 *     credentials.key is a JWT (or absent). JWTs are short-lived and
 *     wrong-by-construction for a long-lived CLI session; fall back
 *     to a separately-stored API key under sidebar.apiKey, which the
 *     user mints in Manage → API Keys and saves once via a future
 *     prompt UI.
 *   case (c) — neither resolves:
 *     return null. Caller surfaces a friendly error in the sidebar.
 *
 * Returns { url, key } or null. The URL falls back to the dashboard
 * webapp's serverUrl, then to localhost:3001 for the dev case.
 */
async function resolveSidebarCredentials() {
  let url = null;
  let key = null;

  // Read the dashboard's stored credentials. The shape is set by
  // ipcMain.handle('save-config', ...) elsewhere in this file:
  //   { serverUrl, encryptedKey | key, userName }
  const dashboardCred = store.get('credentials');
  if (dashboardCred) {
    url = dashboardCred.serverUrl || null;
    if (dashboardCred.encryptedKey && safeStorage.isEncryptionAvailable()) {
      try {
        key = safeStorage.decryptString(Buffer.from(dashboardCred.encryptedKey, 'base64'));
      } catch (err) {
        console.warn('[sidebar] failed to decrypt dashboard key:', err.message);
      }
    } else if (dashboardCred.key) {
      key = dashboardCred.key;
    }
  }

  // case (b): the dashboard's stored "key" is actually a JWT — not
  // useful for a long-running CLI. Drop it and look for a sidebar
  // key. JWTs are base64-encoded triples separated by dots; API keys
  // start with the trve_ prefix.
  if (key && !key.startsWith('trve_')) {
    key = null;
  }

  if (!key) {
    const sidebarKey = store.get('sidebar.encryptedKey');
    if (sidebarKey && safeStorage.isEncryptionAvailable()) {
      try {
        key = safeStorage.decryptString(Buffer.from(sidebarKey, 'base64'));
      } catch (err) {
        console.warn('[sidebar] failed to decrypt sidebar key:', err.message);
      }
    } else {
      const plain = store.get('sidebar.key');
      if (plain) key = plain;
    }
  }

  // URL fallback chain: explicit sidebar URL → dashboard URL → localhost dev.
  if (!url) {
    url = store.get('sidebar.serverUrl') || 'http://127.0.0.1:3001';
  }

  if (!key) {
    console.log('[sidebar] resolveSidebarCredentials: no key found (case c — no creds)');
    return null;
  }
  // Log which path won. Truncate the key so it doesn't end up in
  // a screenshot during a demo.
  const source = dashboardCred?.key === key || (dashboardCred?.encryptedKey && key.startsWith('trve_'))
    ? 'dashboard-credential (case a)'
    : 'sidebar-only key (case b)';
  console.log(`[sidebar] resolveSidebarCredentials: ${source}, key=${key.slice(0, 10)}…, url=${url}`);
  return { url, key };
}

/**
 * Save a sidebar-only API key. Used by the case (b) prompt flow and
 * by the `sidebar:save-key` IPC handler. Encrypts via safeStorage
 * when available; falls back to plaintext (with a console warning)
 * when not.
 */
function saveSidebarKey(plaintextKey) {
  if (!plaintextKey || typeof plaintextKey !== 'string') {
    throw new Error('sidebar key must be a non-empty string');
  }
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(plaintextKey).toString('base64');
    store.set('sidebar.encryptedKey', encrypted);
    store.delete('sidebar.key');
  } else {
    console.warn('[sidebar] safeStorage unavailable; storing key in plaintext');
    store.set('sidebar.key', plaintextKey);
  }
}

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
 * Spawn the `claude` CLI as a PTY in the curated sidebar workspace,
 * carrying the resolved dashboard URL + API key in the spawn env.
 *
 * - cwd is the user-data sidebar workspace dir (populated from the
 *   packaged template on first launch). Claude Code discovers
 *   `.mcp.json` relative to cwd, so the workspace's curated config
 *   determines which MCP servers the session connects to.
 * - TRVE_DASHBOARD_URL + TRVE_DASHBOARD_KEY are injected so the
 *   workspace's .mcp.json `${VAR}` placeholders resolve. The user
 *   never has to set these in their shell.
 * - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are stripped — if
 *   either survives, `claude` bills the Anthropic Console instead
 *   of the user's subscription. Subscription-billed is the entire
 *   point of hosting Claude Code in the sidebar.
 *
 * Returns the spawned IPty, or null on any failure (caller surfaces
 * an error message in the sidebar pane).
 */
function spawnClaudeCLI(credentials, workspace) {
  if (!pty) return null;
  if (!credentials || !credentials.key) {
    console.error('[sidebar] spawn aborted: no resolved credentials');
    return null;
  }

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.TRVE_DASHBOARD_URL = credentials.url;
  env.TRVE_DASHBOARD_KEY = credentials.key;

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
      cwd: workspace,
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

async function ensurePtyStarted() {
  if (ptyProcess) return;
  if (!pty) {
    sidebarView?.webContents.send('pty:error',
      `node-pty failed to load: ${ptyLoadError?.message || 'unknown error'}.\n\n` +
      `Reinstall the Electron module: \`cd electron && npm install\`.`);
    return;
  }

  // Bootstrap the curated workspace if needed, then resolve which
  // API key the spawn should carry. Both can fail loudly — surface
  // an actionable message in the sidebar pane.
  let workspace;
  try {
    workspace = ensureSidebarWorkspace();
  } catch (err) {
    sidebarView?.webContents.send('pty:error',
      `Failed to set up sidebar workspace: ${err.message}.\n` +
      `Check filesystem permissions on ${app.getPath('userData')}.`);
    return;
  }

  const credentials = await resolveSidebarCredentials();
  if (!credentials) {
    sidebarView?.webContents.send('pty:error',
      `No dashboard credentials found.\n\n` +
      `The sidebar needs an API key to talk to the dashboard's MCP server.\n` +
      `Either sign into the dashboard with an API key (it will be reused), or\n` +
      `mint one in Manage → API Keys and save it via the sidebar's setup prompt\n` +
      `(coming in a follow-up build).`);
    return;
  }

  ptyProcess = spawnClaudeCLI(credentials, workspace);
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
    // Title carries the Cmd+Shift+/ hint so users discover the
    // sidebar toggle without us needing a separate UI button. The
    // dashboard renderer's <title> would override this once the page
    // loads, so we re-set after load below.
    title: 'TRV Outpost   —   ⌘⇧/  Claude Code sidebar',
  });

  // Dashboard view — the existing webapp. Loaded the same way the
  // pre-sidebar build did (dev = vite, prod = packaged HTML).
  //
  // sandbox: false here is deliberate. With sandbox=true, the
  // preload script's contextBridge calls would still work in dev
  // (loading from http://localhost:5173), but in a packaged build
  // the file://-loaded renderer ended up with `window.electron`
  // undefined — App.jsx then took the browser-mode branch, skipped
  // the LoginPage, and rendered blank because there were no
  // credentials. contextIsolation: true is still on, so the
  // renderer is isolated from the preload's full Node context; the
  // sandbox flag only removes the extra OS-process-sandbox layer
  // (which isn't load-bearing for our own first-party content).
  dashboardView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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

// Title we want on the window regardless of what the dashboard
// renderer sets via <title>. Carries the keyboard hint so the
// sidebar toggle is discoverable without a separate UI button.
const APP_WINDOW_TITLE = 'TRV Outpost   —   ⌘⇧/  Claude Code sidebar';

// BrowserWindow's `ready-to-show` doesn't fire when content is loaded
// into a BrowserView (only when the window's own webContents finishes).
// Wire it from the dashboard view's webContents so the existing
// "no white flash" UX is preserved. Also re-pins the window title
// since the dashboard's <title> overrides whatever we set at
// BrowserWindow construction.
function bridgeReadyToShow() {
  if (!dashboardView || !mainWindow) return;
  dashboardView.webContents.once('did-finish-load', () => {
    mainWindow.emit('ready-to-show');
    mainWindow.setTitle(APP_WINDOW_TITLE);
  });
  // The dashboard's renderer can re-set the document title at any
  // time (route changes, etc.); each new "page-title-updated" event
  // would normally update the BrowserWindow title. Re-pin after every
  // such event so the hotkey hint stays visible.
  dashboardView.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(APP_WINDOW_TITLE);
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

// Sidebar API key save (case b — Clerk-bootstrapped dashboard).
// Exposed to the dashboard renderer so a future "Set sidebar API key"
// dialog can call it; can also be invoked from DevTools as
// `await window.electron.sidebar.saveKey('trve_...')`. Triggers a PTY
// respawn so the new key takes effect immediately without restarting
// the app.
ipcMain.handle('sidebar:save-key', async (event, plaintextKey) => {
  try {
    saveSidebarKey(plaintextKey);
    // Kill the existing session (if any) so the next ensurePtyStarted
    // picks up the new credential. Sidebar visibility / position are
    // preserved.
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch {}
      ptyProcess = null;
    }
    if (sidebarVisible) await ensurePtyStarted();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
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
