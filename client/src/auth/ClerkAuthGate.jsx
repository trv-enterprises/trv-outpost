// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { SignedIn, SignedOut, SignIn, useUser } from '@clerk/clerk-react';
import { useEffect, useState } from 'react';
import apiClient from '../api/client';
import ClerkSessionBridge from './ClerkSessionBridge';

/**
 * ClerkAuthGate
 *
 * Mounts inside <ClerkProvider> and chooses between:
 *   - signed in  → render children (the dashboard) plus the session
 *     bridge that wires Clerk JWTs into apiClient.
 *   - signed out → render Clerk's hosted <SignIn /> component.
 *
 * Also performs a one-time `/api/auth/me` round-trip the first time
 * we see a signed-in Clerk session. The server's middleware does the
 * JIT-link (Clerk subject → existing user record by email) on the
 * first authenticated request — once that succeeds, App.jsx's
 * existing identity flow can pick up `currentUser` via the GUID it
 * already manages. We do the round-trip eagerly so the legacy parts
 * of the app that read `localStorage.currentUserGuid` see something
 * sensible without waiting for the user to navigate.
 *
 * Render layout for signed-out users mirrors the rest of the app:
 * Carbon g100 dark background, centered Clerk widget. Clerk's own
 * theme comes through; we don't try to re-skin it.
 */
export default function ClerkAuthGate({ children }) {
  return (
    <>
      <SignedIn>
        <ClerkSessionBridge />
        <ClerkLegacyIDBridge />
        {children}
      </SignedIn>
      <SignedOut>
        <SignInScreen />
      </SignedOut>
    </>
  );
}

/**
 * ClerkLegacyIDBridge
 *
 * On first sign-in, hit `/api/auth/me` with the Clerk JWT. The
 * server's middleware will JIT-link the Clerk identity to the
 * matching User record (by email) and return the resolved user.
 * We stash the user's GUID into apiClient.setCurrentUser so the
 * existing pages that read `currentUserGuid` from localStorage
 * keep working without rewrites. A side-effect-only component.
 */
function ClerkLegacyIDBridge() {
  const { isLoaded, isSignedIn, user } = useUser();
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || synced) return;
    let cancelled = false;
    (async () => {
      try {
        // /api/auth/me validates the bearer (set by ClerkSessionBridge)
        // and returns the resolved dashboard user. The very first
        // call on a deployment also creates the JIT-link in MongoDB.
        const me = await apiClient.request('/api/auth/me');
        if (cancelled) return;
        const guid = me?.user_id || me?.guid;
        if (guid) {
          apiClient.setCurrentUser(guid);
        }
        setSynced(true);
      } catch (err) {
        // 401 here means the server couldn't match the Clerk
        // identity to any user record. The /api/auth/me response
        // includes a hint; surface it to the user.
        console.warn('Clerk auth bridge: /api/auth/me failed', err);
        setSynced(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, user, synced]);

  return null;
}

/**
 * SignInScreen
 *
 * Full-page Clerk sign-in. Carbon g100 dark page background; Clerk
 * widget self-styled. Center the widget vertically and horizontally
 * so it reads as the only thing on the page.
 */
function SignInScreen() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--cds-background, #161616)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
    >
      <SignIn routing="hash" />
    </div>
  );
}
