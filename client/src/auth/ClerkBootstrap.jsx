// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState } from 'react';
import { ClerkProvider } from '@clerk/clerk-react';
import apiClient from '../api/client';
import ClerkAuthGate from './ClerkAuthGate';

/**
 * ClerkBootstrap
 *
 * Fetches `/api/config/system` once at app startup, then either
 * mounts the app inside a `<ClerkProvider>` (when the deployment
 * has Clerk auth enabled) or renders children unwrapped (when it
 * doesn't, falling back to v0.9.x behaviour).
 *
 * Why this lives at the very top of the tree: ClerkProvider must
 * be ancestor to anything that calls Clerk hooks
 * (`useAuth`, `useSession`, `useClerk`, etc.). Mounting it
 * conditionally inside App.jsx would force every page to handle
 * "ClerkProvider may or may not be present" — easier to decide once
 * here and let downstream code assume the context exists when the
 * deployment is configured for it.
 *
 * Initial render shows nothing (small flash) while system config
 * loads. The fetch is fast and cached by the browser; this is not
 * the right place for a full splash screen.
 *
 * Failure mode: if the system-config fetch errors, we render the
 * children unwrapped — same as Clerk-disabled mode. The legacy
 * bootstrap chain (URL `?user_id=…`, localStorage, default browser
 * user) still works. Better to fall through to a working app than
 * block on a transient network error.
 */
export default function ClerkBootstrap({ children }) {
  const [state, setState] = useState({
    loading: true,
    publishableKey: '',
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await apiClient.getSystemConfig();
        if (cancelled) return;
        setState({
          loading: false,
          publishableKey: config?.clerk_publishable_key || '',
        });
      } catch (err) {
        // Silently fall through to legacy auth on transient errors.
        // Console-only — Clerk is best-effort at the bootstrap layer.
        console.warn('ClerkBootstrap: system config fetch failed; using legacy auth path', err);
        if (!cancelled) {
          setState({ loading: false, publishableKey: '' });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (state.loading) {
    // Tiny placeholder — the fetch is fast. A real splash screen
    // would belong inside App, not above it.
    return null;
  }

  if (state.publishableKey) {
    return (
      <ClerkProvider
        publishableKey={state.publishableKey}
        // Sign-in / sign-up paths default to Clerk-hosted pages.
        // We keep them in-app via the embedded <SignIn /> component
        // rendered by ClerkAuthGate, so don't redirect.
        signInUrl="/sign-in"
        signUpUrl="/sign-in"
      >
        <ClerkAuthGate>{children}</ClerkAuthGate>
      </ClerkProvider>
    );
  }

  // Clerk disabled at this deployment — render the v0.9.x app
  // (X-User-ID legacy + API keys) unchanged.
  return children;
}
