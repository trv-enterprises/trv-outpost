// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Deployment-wide default for the streaming in-memory buffer depth: how
// many recent data points a live chart keeps (and the no-window backfill
// paint depth). Lives in its own tiny module so BOTH consumers —
// useData (the React hook / spec-driven + custom-code charts) and
// streamConnectionManager (the shared per-connection buffer) — read the
// same value without a circular import (useData imports the manager).
//
// The app sets this once at bootstrap from the `stream_buffer_size`
// admin setting (default 1000; admins may raise it, e.g. 10000, for
// power users with high-resolution streams). Applies on next page load.

let streamBufferSize = 1000;

/**
 * Set the deployment-wide streaming buffer/backfill depth. Called once
 * at app bootstrap from the stream_buffer_size admin setting. Ignores
 * non-positive / non-finite values (keeps the current value).
 * @param {number} n
 */
export function setStreamBufferSize(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v > 0) streamBufferSize = Math.floor(v);
}

/** Current deployment-wide streaming buffer depth (default 1000). */
export function getStreamBufferSize() {
  return streamBufferSize;
}
