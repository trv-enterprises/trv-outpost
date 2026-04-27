// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect } from 'react';
import { useAuth, useClerk } from '@clerk/clerk-react';
import apiClient from '../api/client';

/**
 * ClerkSessionBridge
 *
 * Wires the Clerk session into the dashboard's apiClient. Renders
 * nothing — its only job is to register a token-getter so every
 * outbound API call carries a fresh Clerk JWT in the Authorization
 * header. When the Clerk session signs out, the registration is torn
 * down and apiClient falls back to its legacy auth path.
 *
 * Place this anywhere inside <ClerkProvider>; the most natural spot
 * is the top of App's authenticated tree so the bridge mounts before
 * the first API request fires.
 *
 * Why a separate component: the apiClient is a singleton imported
 * directly by every page, but Clerk's hooks only work inside React
 * components. This is the smallest bridge between the two — register
 * on mount, unregister on unmount. No prop drilling, no provider.
 */
export default function ClerkSessionBridge() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  // useClerk gives us the long-lived client; useAuth returns
  // request-scoped hooks that may rebuild between renders. Both are
  // safe inside an effect.
  const clerk = useClerk();

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      apiClient.setTokenProvider(null);
      return;
    }

    // Clerk's getToken() returns a cached token when fresh and
    // mints a new one (using the session cookie) when not. Default
    // template is fine — server validates `sub`, `iss`, `exp`, and
    // fetches email separately on first sign-in via JIT-link.
    apiClient.setTokenProvider(() => getToken());

    // No cleanup needed beyond resetting on next sign-out — but
    // resetting on unmount is correct hygiene if this component
    // ever re-mounts.
    return () => {
      apiClient.setTokenProvider(null);
    };
  }, [isLoaded, isSignedIn, getToken, clerk]);

  return null;
}
