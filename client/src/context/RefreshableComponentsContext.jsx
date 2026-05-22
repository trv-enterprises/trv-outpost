// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import PropTypes from 'prop-types';

/**
 * RefreshableComponentsContext
 *
 * Counts how many currently-mounted components benefit from a
 * manual data refresh. Polling consumers (useData with a non-
 * streaming connection, self-polling displays like
 * FrigateAlertsGrid and WeatherDisplay) call `register()` on
 * mount and `unregister()` on unmount; the toolbar reads the
 * derived `hasRefreshable` flag and shows the refresh button only
 * when the count is positive.
 *
 * Why a context rather than a connection-type allowlist on the
 * dashboard: useData ALREADY resolves the live stream-vs-poll
 * decision inside each component (it fetches the connection
 * record and inspects type + transport). Threading that decision
 * back out via a context is one new effect at the chokepoint
 * instead of N file edits + a maintained type table. The
 * registration is automatically correct as new connection types
 * appear.
 *
 * Provider scope: wrap the dashboard viewer (and only the viewer).
 * Other modes that render components (Design preview, AI builder)
 * don't have a refresh affordance, so they can skip the provider
 * and the registration becomes a no-op.
 */
const RefreshableComponentsContext = createContext({
  register: () => () => {},
  hasRefreshable: false,
  count: 0,
});

export function RefreshableComponentsProvider({ children }) {
  // Keep the actual registered-ids set in a ref so register/unregister
  // don't churn the context value (and thus consumers) on every
  // mount. We surface a derived count + boolean via state, updated
  // only when the membership actually changes.
  const idsRef = useRef(new Set());
  const [count, setCount] = useState(0);

  const register = useCallback((id) => {
    if (idsRef.current.has(id)) return () => {};
    idsRef.current.add(id);
    setCount(idsRef.current.size);
    return () => {
      if (idsRef.current.delete(id)) setCount(idsRef.current.size);
    };
  }, []);

  const value = useMemo(
    () => ({ register, hasRefreshable: count > 0, count }),
    [register, count],
  );

  return (
    <RefreshableComponentsContext.Provider value={value}>
      {children}
    </RefreshableComponentsContext.Provider>
  );
}

RefreshableComponentsProvider.propTypes = {
  children: PropTypes.node,
};

export function useRefreshableComponentsContext() {
  return useContext(RefreshableComponentsContext);
}

/**
 * Convenience wrapper: register-on-mount, unregister-on-unmount.
 * `active` lets the caller gate registration on runtime data that
 * isn't known synchronously (e.g. useData only knows poll-vs-stream
 * once the connection record has loaded).
 */
export function useRegisterRefreshable(active) {
  const { register } = useRefreshableComponentsContext();
  useEffect(() => {
    if (!active) return undefined;
    const id = Symbol('refreshable');
    return register(id);
  }, [active, register]);
}
