// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * copyTextToClipboard
 *
 * Reliable copy across secure and non-secure contexts.
 *
 * The modern `navigator.clipboard.writeText` API is only available
 * when the page is loaded over HTTPS, localhost, or file:// — i.e.
 * a "secure context". On plain HTTP (which the homelab dashboard
 * runs as at http://192.168.x.x), `navigator.clipboard` is undefined
 * and the modern path throws.
 *
 * Fallback: a one-shot hidden textarea + document.execCommand('copy').
 * It's deprecated but every browser still supports it, and unlike
 * the Async Clipboard API it doesn't gate on a secure context.
 *
 * Returns a promise that resolves on success; rejects when both
 * paths fail (e.g. the user denied a permission prompt on the
 * async path AND execCommand is blocked, which is vanishingly rare).
 */
export async function copyTextToClipboard(text) {
  if (typeof text !== 'string') {
    throw new TypeError('copyTextToClipboard expects a string');
  }
  // Modern path: only available on secure contexts.
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback path: works on plain HTTP. Has to run in a user-
  // gesture handler to satisfy execCommand permission rules; this
  // module is always called from an onClick, so that holds.
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      // Hide off-screen but keep it interactable. `display:none`
      // would block selection and the copy would fail silently.
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.width = '1px';
      ta.style.height = '1px';
      ta.style.opacity = '0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      // iOS Safari needs setSelectionRange to actually highlight.
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error('execCommand("copy") returned false'));
    } catch (err) {
      reject(err);
    }
  });
}
