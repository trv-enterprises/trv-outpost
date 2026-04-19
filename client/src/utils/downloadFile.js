// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * triggerDownload
 *
 * Take a Blob (or anything Blob-compatible) and trigger a browser-side
 * download under the given filename. Centralized so the export flow
 * doesn't duplicate the anchor-click-revoke dance that was already
 * living in ChartPanelWithActions.
 */
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * filenameSlug
 *
 * Normalize any string into a filename-safe slug: lowercase,
 * non-alphanumerics become underscores, leading/trailing underscores
 * stripped. Empty input returns a stable fallback.
 */
export function filenameSlug(name, fallback = 'export') {
  return (
    String(name || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || fallback
  );
}
