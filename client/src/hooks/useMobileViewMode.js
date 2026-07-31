// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../api/client';

/**
 * Mobile view mode — "flow" (stacked column) or "fit" (whole dashboard scaled
 * down to the screen). Issue #180.
 *
 * Flow is the default and is right for most dashboards: it discards the grid
 * and stacks panels full-width so each is legible. But some boards are built to
 * be read as a whole — a wall display, a status board where the arrangement IS
 * the information — and for those the author would rather shrink everything and
 * keep the layout. This is that escape hatch.
 *
 * ONE GLOBAL PREFERENCE, not per-dashboard: whichever mode you last chose
 * applies everywhere until you change it. The mode is a statement about how you
 * like to read on a phone, not about a particular board.
 *
 * The choice STICKS. An earlier design auto-reverted to flow on a
 * landscape→portrait rotation, on the theory that fit is least readable in
 * portrait — but now that the mode persists per user, an automatic override
 * would silently undo a saved preference, and "why did my view change?" is a
 * worse problem than a cramped layout the user chose.
 *
 * Persistence follows the same shape as NamespaceContext's active_namespace:
 * read once on load, write optimistically on change, and treat every failure as
 * non-fatal — a preference is never worth blocking or breaking the UI over.
 *
 * localStorage mirrors the value purely so the FIRST paint after a reload uses
 * the right mode; the server remains the source of truth and overwrites the
 * mirror as soon as it answers. Without it, a fit-mode user gets a flash of the
 * stacked layout on every load while the config request is in flight.
 */

export const MOBILE_VIEW_FLOW = 'flow';
export const MOBILE_VIEW_FIT = 'fit';

const STORAGE_KEY = 'dashboard_mobile_view_mode';
const CONFIG_KEY = 'mobile_view_mode';

const isValid = (m) => m === MOBILE_VIEW_FLOW || m === MOBILE_VIEW_FIT;

function readMirror() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isValid(raw) ? raw : MOBILE_VIEW_FLOW;
  } catch {
    return MOBILE_VIEW_FLOW;
  }
}

function writeMirror(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private browsing / quota. The server copy still persists.
  }
}

export default function useMobileViewMode() {
  // Seed from the mirror so the first paint is already correct.
  const [mode, setModeState] = useState(readMirror);
  // Guard against a late server response clobbering a choice the user made
  // while it was in flight.
  const userChangedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const guid = apiClient.getCurrentUserGuid();
    if (!guid) return undefined;

    apiClient.getUserConfig(guid)
      .then((cfg) => {
        if (cancelled || userChangedRef.current) return;
        const stored = cfg?.settings?.[CONFIG_KEY];
        if (isValid(stored)) {
          setModeState(stored);
          writeMirror(stored);
        }
      })
      .catch(() => {
        // Best-effort: a config failure just leaves the mirrored/default mode.
      });

    return () => { cancelled = true; };
  }, []);

  const setMode = useCallback((next) => {
    if (!isValid(next)) return;
    userChangedRef.current = true;
    setModeState(next);
    writeMirror(next);
    const guid = apiClient.getCurrentUserGuid();
    if (!guid) return;
    apiClient.updateUserConfig(guid, { [CONFIG_KEY]: next }).catch((err) => {
      // Non-fatal: the mode still applies for this session and the mirror
      // carries it across a reload; only cross-device sync is lost.
      console.warn('Failed to persist mobile view mode:', err);
    });
  }, []);

  return { mode, setMode };
}
