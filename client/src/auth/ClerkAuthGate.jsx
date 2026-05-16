// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';
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
  // Note: pre-v0.17.0 this also mounted ClerkLegacyIDBridge, which
  // eagerly hit /api/auth/me with the Clerk JWT to JIT-link the
  // dashboard user record. That role is now App.jsx's bootstrap
  // effect via apiClient.createSession() — the bootstrap endpoint
  // walks the IdP registry which performs the same JIT link, and
  // App.jsx reads `apiClient.tokenProvider` to decide whether to
  // flip `clerkActive` for the Sign-Out menu item. Removing the
  // bridge avoids a redundant /api/auth/me call that fires BEFORE
  // the access token is set (which now 401s under the
  // session-token middleware).
  return (
    <>
      <SignedIn>
        <ClerkSessionBridge />
        {children}
      </SignedIn>
      <SignedOut>
        <SignInScreen />
      </SignedOut>
    </>
  );
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
