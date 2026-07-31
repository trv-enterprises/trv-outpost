// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useContext, useMemo } from 'react';
import PropTypes from 'prop-types';
import { MOBILE_VIEW_FLOW, MOBILE_VIEW_FIT } from '../hooks/useMobileViewMode';

/**
 * Shares the mobile view mode (#180) between the router and the viewers.
 *
 * Two consumers need the same value and must not disagree: App decides WHICH
 * viewer to mount for /view/dashboards/:id, and the mounted viewer renders the
 * toggle that changes it. Calling the hook in both places would give each its
 * own state — the toggle would flip one copy and the route would keep reading
 * the other, so the view would never switch.
 */

const MobileViewModeContext = createContext(null);

/**
 * The mode is OWNED by App (it routes on it) and passed in here, rather than
 * this provider calling useMobileViewMode itself. Two independent hook
 * instances would each hold their own state: the toggle would flip one and the
 * router would keep reading the other, so the view would never actually switch.
 */
export function MobileViewModeProvider({ mode, setMode, children }) {
  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);
  return (
    <MobileViewModeContext.Provider value={value}>
      {children}
    </MobileViewModeContext.Provider>
  );
}

MobileViewModeProvider.propTypes = {
  mode: PropTypes.string.isRequired,
  setMode: PropTypes.func.isRequired,
  children: PropTypes.node,
};

/**
 * Returns { mode, setMode }. Safe outside the provider — falls back to flow
 * with a no-op setter so a component rendered in isolation (a test, a story)
 * doesn't have to be wrapped.
 */
export function useMobileViewModeContext() {
  return useContext(MobileViewModeContext)
    || { mode: MOBILE_VIEW_FLOW, setMode: () => {} };
}

export { MOBILE_VIEW_FLOW, MOBILE_VIEW_FIT };
