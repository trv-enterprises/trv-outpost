// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useState } from 'react';
import apiClient from '../api/client';

const LOCAL_OPEN_KEY = 'assistant.sidecard_open';
const LOCAL_WIDTH_KEY = 'assistant.sidecard_width_px';

const SERVER_OPEN_KEY = 'assistant.sidecard_open';
const SERVER_WIDTH_KEY = 'assistant.sidecard_width_px';

const DEFAULT_WIDTH = 448;
const MIN_WIDTH = 360;
const MAX_WIDTH_VW_FRACTION = 0.5;

function clampWidth(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WIDTH;
  const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_WIDTH_VW_FRACTION));
  return Math.min(max, Math.max(MIN_WIDTH, Math.round(value)));
}

function readLocalOpen() {
  try {
    const v = window.localStorage.getItem(LOCAL_OPEN_KEY);
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch {
    // localStorage unavailable — fall through to default
  }
  return false;
}

function readLocalWidth() {
  try {
    const raw = window.localStorage.getItem(LOCAL_WIDTH_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return clampWidth(n);
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH;
}

/**
 * Two-tier persistence for the Dashboard Assistant sidecard's open
 * state and width: localStorage seeds the value instantly on first
 * render (no flicker), then a server-side user-prefs read overrides
 * once it returns (so the preference syncs across devices).
 *
 * Writes go both places. localStorage update is synchronous;
 * server-side write is best-effort fire-and-forget.
 */
export default function useAssistantSidecardState() {
  const [open, setOpenState] = useState(readLocalOpen);
  const [width, setWidthState] = useState(readLocalWidth);

  // Hydrate from server-side user prefs once on mount. We don't
  // overwrite if the user has already started interacting (open or
  // width changed locally) — but for v1 the bootstrap fires fast
  // enough that we just trust the server value when it returns.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const userGuid = apiClient.getCurrentUserGuid?.();
      if (!userGuid) return;
      try {
        const cfg = await apiClient.getUserConfig?.(userGuid);
        if (cancelled || !cfg?.settings) return;
        const serverOpen = cfg.settings[SERVER_OPEN_KEY];
        const serverWidth = cfg.settings[SERVER_WIDTH_KEY];
        if (typeof serverOpen === 'boolean') {
          setOpenState(serverOpen);
        }
        if (typeof serverWidth === 'number') {
          setWidthState(clampWidth(serverWidth));
        }
      } catch {
        // best-effort; keep local value
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const persist = useCallback((nextOpen, nextWidth) => {
    try {
      window.localStorage.setItem(LOCAL_OPEN_KEY, String(nextOpen));
      window.localStorage.setItem(LOCAL_WIDTH_KEY, String(nextWidth));
    } catch {
      // localStorage write failed — server-side path still tries
    }
    const userGuid = apiClient.getCurrentUserGuid?.();
    if (userGuid && apiClient.updateUserConfig) {
      apiClient.updateUserConfig(userGuid, {
        [SERVER_OPEN_KEY]: nextOpen,
        [SERVER_WIDTH_KEY]: nextWidth,
      }).catch(() => { /* best-effort */ });
    }
  }, []);

  const setOpen = useCallback((nextOpen) => {
    setOpenState((prev) => {
      const next = typeof nextOpen === 'function' ? nextOpen(prev) : nextOpen;
      if (next !== prev) {
        // Persist with the most recent known width.
        setWidthState((w) => {
          persist(next, w);
          return w;
        });
      }
      return next;
    });
  }, [persist]);

  const setWidth = useCallback((nextWidth) => {
    const clamped = clampWidth(typeof nextWidth === 'function' ? nextWidth(width) : nextWidth);
    setWidthState(clamped);
    setOpenState((o) => {
      persist(o, clamped);
      return o;
    });
  }, [persist, width]);

  const toggle = useCallback(() => setOpen((o) => !o), [setOpen]);

  return {
    open,
    width,
    setOpen,
    setWidth,
    toggle,
    minWidth: MIN_WIDTH,
    defaultWidth: DEFAULT_WIDTH,
  };
}
