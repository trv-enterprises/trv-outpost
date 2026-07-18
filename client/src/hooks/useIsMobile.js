// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState } from 'react';

// Mobile breakpoint. 950px so larger phones in landscape (e.g. iPhone Pro,
// ~852–932px wide) still get the mobile viewer rather than the shrunk desktop
// grid. Keep the SCSS media queries that gate mobile-only layout (the tile
// picker's Filters collapse, the notification panel re-anchor) in sync with
// this value.
const MOBILE_MAX_WIDTH = 950;
const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

/**
 * useIsMobile — true when the viewport is at or below the phone breakpoint.
 *
 * Backed by matchMedia so it re-evaluates on resize AND orientation change
 * without a manual resize listener. First (and only, until now) matchMedia
 * consumer in the app — keep it the single source of the mobile breakpoint so
 * the number lives in one place.
 *
 * @returns {boolean}
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => {
    // Guard for non-browser environments (SSR / tests without a DOM). In a
    // normal browser this reads the real viewport on first render so there's
    // no desktop→mobile flash.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(MOBILE_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    // Sync once in case the viewport changed between the initial render and
    // this effect running.
    setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}

export default useIsMobile;
