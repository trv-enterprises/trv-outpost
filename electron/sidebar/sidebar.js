// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Sidebar renderer — mounts xterm.js, wires it to the PTY exposed by
 * sidebar-preload.js's `sidebarBridge`, and plumbs the drag handle
 * + window-resize → fit-addon → pty.resize loop.
 *
 * Loaded as a classic script from index.html (NOT a module). xterm
 * and its fit addon ship as UMD bundles only, so they're loaded via
 * earlier <script> tags in the HTML and surface as globals.
 */

// Loud early diagnostics. If something goes wrong before xterm
// mounts, this console output is the only signal we get.
console.log('[sidebar] script loaded, document.readyState =', document.readyState);
console.log('[sidebar] window.Terminal =', typeof window.Terminal);
console.log('[sidebar] window.FitAddon =', typeof window.FitAddon, window.FitAddon && Object.keys(window.FitAddon));
console.log('[sidebar] window.sidebarBridge =', typeof window.sidebarBridge);
console.log('[sidebar] #terminal element =', document.getElementById('terminal'));
console.log('[sidebar] body children:', Array.from(document.body.children).map(c => c.id || c.tagName));

// xterm.js (lib/xterm.js) is a UMD bundle whose "browser global" branch
// iterates each exported member and assigns it directly onto
// `globalThis` — so `window.Terminal` is the class itself.
//
// @xterm/addon-fit (lib/addon-fit.js) uses the simpler UMD branch
// `window.FitAddon = exports`, which makes `window.FitAddon` the
// *module namespace* whose `.FitAddon` property is the class.
const Terminal = window.Terminal;
const FitAddon = window.FitAddon && window.FitAddon.FitAddon;
const bridge = window.sidebarBridge;

if (!Terminal || !FitAddon) {
  document.body.innerHTML = '';
  const err = document.createElement('div');
  err.style.cssText = 'padding: 20px; font-family: monospace; color: #ff8389; background: #2d0709;';
  err.textContent =
    `Sidebar bootstrap failed:\n` +
    `  window.Terminal: ${typeof Terminal}\n` +
    `  window.FitAddon: ${typeof window.FitAddon} (looking for .FitAddon → ${typeof FitAddon})\n` +
    `Check that <script> tags in sidebar/index.html resolved correctly.`;
  err.style.whiteSpace = 'pre';
  document.body.appendChild(err);
  throw new Error('Sidebar deps not loaded');
}

// --------- Terminal setup ---------

// Carbon g100 palette mapped onto xterm's color slots. Background is
// transparent so the sidebar's #161616 shows through; foreground +
// cursor + selection all chosen for dark-bg readability.
const term = new Terminal({
  fontFamily: 'IBM Plex Mono, Menlo, Monaco, monospace',
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 5000,
  allowProposedApi: true,
  theme: {
    background: '#00000000',
    foreground: '#f4f4f4',
    cursor: '#0f62fe',
    cursorAccent: '#161616',
    selectionBackground: '#393939',
    black: '#161616',
    red: '#fa4d56',
    green: '#42be65',
    yellow: '#f1c21b',
    blue: '#4589ff',
    magenta: '#be95ff',
    cyan: '#33b1ff',
    white: '#c6c6c6',
    brightBlack: '#525252',
    brightRed: '#ff8389',
    brightGreen: '#6fdc8c',
    brightYellow: '#fddc69',
    brightBlue: '#78a9ff',
    brightMagenta: '#d4bbff',
    brightCyan: '#82cfff',
    brightWhite: '#f4f4f4',
  },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

// --------- Error banner ---------

// Inline non-fatal error display. The terminal stays mounted; the
// banner overlays the top so the user can read the error message and
// any remaining terminal state at the same time.
function showError(message) {
  let banner = document.getElementById('error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'error-banner';
    document.body.appendChild(banner);
  }
  banner.textContent = message;
  banner.classList.add('visible');
}

// --------- PTY wiring ---------

// Inbound: PTY → terminal.
bridge.pty.onData((chunk) => {
  term.write(chunk);
});

bridge.pty.onExit(({ exitCode, signal }) => {
  term.writeln('');
  term.writeln(`\x1b[2m[claude exited: code=${exitCode ?? '?'}${signal ? `, signal=${signal}` : ''}]\x1b[0m`);
  term.writeln('\x1b[2m  Re-open the sidebar to start a new session.\x1b[0m');
});

bridge.pty.onError((msg) => {
  showError(msg);
});

// Outbound: keystrokes → PTY.
term.onData((data) => {
  bridge.pty.input(data);
});

// --------- Resize plumbing ---------

// Debounced resize. fit-addon does the heavy lifting (measures the
// container, picks the right cols/rows for the real font metrics);
// we then forward the precise dimensions to the PTY so claude's
// output wraps cleanly. Without this, lines wrap mid-glyph after a
// drag-resize.
let resizeTimer = null;
function scheduleFit() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    try {
      fitAddon.fit();
      const { cols, rows } = term;
      bridge.pty.resize(cols, rows);
    } catch (err) {
      // fit() can throw if the terminal isn't laid out yet (e.g.
      // sidebar hidden). Safe to swallow — the next visible-resize
      // will retry.
    }
  }, 50);
}

window.addEventListener('resize', scheduleFit);

// ResizeObserver picks up sidebar-width changes during a drag, which
// don't always trigger window-level resize events depending on the
// browser/Electron version.
const ro = new ResizeObserver(scheduleFit);
ro.observe(document.getElementById('terminal'));

// --------- Drag handle ---------

const dragHandle = document.getElementById('drag-handle');
dragHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  // Hand off to main — it polls the cursor and updates the view
  // bounds. We only need to signal start/end.
  bridge.drag.start();
  const onMouseUp = () => {
    bridge.drag.end();
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('blur', onMouseUp);
  };
  window.addEventListener('mouseup', onMouseUp);
  // If focus leaves the window mid-drag (alt-tab), end the drag too.
  // Otherwise the cursor poll would keep resizing as the user moves
  // around in other apps.
  window.addEventListener('blur', onMouseUp);
});

// --------- Initial focus ---------

term.focus();
