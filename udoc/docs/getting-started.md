---
sidebar_position: 2
---

# Logging In & User Selection

## Browser Mode

The dashboard supports two browser-mode auth backends, chosen at deploy time by env vars on the server:

- **Clerk sign-in (recommended)** — when admin sets `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the server's environment, the dashboard renders Clerk's hosted sign-in widget (email/password, Google, Apple, etc.). This is real authentication. See [Clerk Sign-In](clerk-sso.md) for setup, the JIT-link behavior, and admin overrides.
- **Bootstrap chain (default)** — without Clerk env vars, the dashboard uses the legacy identity-assertion flow described below. Suitable for single-user homelabs or deployments that already sit behind a VPN / authenticating reverse proxy.

### Bootstrap chain (when Clerk is disabled)

When accessing the dashboard through a web browser, identity is resolved on first load using one of these channels (in order):

1. **`?user_id=<guid>` in the URL.** A personal launch URL that bakes in the visitor's identity. After the page loads, the URL bar drops the parameter — the GUID is captured to local storage so subsequent visits to the bare URL keep the same identity.
2. **A previous session.** If you've visited before in this browser, your identity is remembered.
3. **A deployment-wide default.** Admins can configure a `default_browser_user_guid` in [System Settings](system-settings.md). Any visitor who hasn't been assigned an identity by 1 or 2 inherits this default.
4. **None of the above.** The app shows a "Sign-in not configured" stub. Contact your administrator for a launch URL or to set the deployment default.

Your capabilities (View, Design, Manage) determine which application modes are available to you, regardless of how identity was resolved.

### Important — bootstrap chain is not authentication

The bootstrap chain is **identity assertion**, not authentication. Anyone who knows a personal launch URL or visits the bare URL of a deployment with a default user becomes that user. Treat launch URLs like shared passwords. For real access control either enable [Clerk Sign-In](clerk-sso.md), put the dashboard behind a VPN / reverse proxy with auth, or stay within a single-user homelab boundary.

### Switching identity in production

To act as a different user in browser mode, visit the dashboard with `?user_id=<their-guid>` in the URL. The new identity replaces the previous one and persists in this browser until explicitly changed (or until local storage is cleared).

:::note Legacy GUID is off by default
The `?user_id=` / `X-User-ID` channel is the **legacy GUID
identity-assertion** path. Since v0.17.6 it is **off by default** on
new deployments and must be explicitly enabled via
`auth.allow_legacy_guid` in `config.yaml` (or
`DASHBOARD_AUTH_ALLOW_LEGACY_GUID=true`). The compose files used by
`docker-compose.prod.yml` / `docker-compose.deploy.yml` set
`ENV=production` and keep this off. Enable it only for development,
single-user homelabs, or kiosks where you understand the trade-off.
:::

### Under the hood: session tokens (v0.17.0+)

The bootstrap channels above describe how *identity* is asserted on
first load. Once identity is resolved, the SPA calls
`POST /api/auth/session` to mint a signed **access JWT**
(short-lived, default 15 min) plus an **httpOnly refresh cookie**
(default 7 days). Every subsequent API / SSE / WebSocket call rides
the access token; expiry triggers a silent refresh.

API keys (`trve_…`) take a different path — they are validated
directly on every request and don't go through the session-token
lifecycle, so kiosks running on an API key survive arbitrary network
outages. The server accepts API keys, session JWTs, and Clerk JWTs
all on the same `Authorization: Bearer` header; the middleware
shape-dispatches based on the prefix.

You don't normally interact with any of this — it's the transport
layer. The user-visible piece is sign-out (clears the session) and
the periodic silent refresh.

### Dev mode

Under `npm run dev` (Vite dev server) the client resolves a default identity automatically: it reuses a previously-cached user when one exists, otherwise the server's bootstrap chain picks one, so a fresh dev box lands on a working session without signing in. Production bundles skip this — a visitor with no API key, no cached GUID, and no admin default sees the sign-in stub instead. There is no in-header user-switching dropdown in either build; the header's avatar menu shows account actions (API keys, sign-out), not a user switcher.

#### Bookmarking identities for dev & test

With `auth.allow_legacy_guid` enabled (the norm for dev and test deployments — see the note under [Switching identity](#switching-identity-in-production) above), the `?user_id=<guid>` URL channel is the recommended way to drive identity locally. Bookmark a distinct launch URL per user — e.g. one for an admin, one for a view-only role, one for a kiosk user — and clicking a bookmark drops you straight into that identity. This is also the easiest hook for automation: a test runner just navigates to the right `?user_id=…` URL, no auth dance required.

API keys can't live in a bookmark and Clerk SSO is unnecessary for general dev/test, so this legacy GUID path remains the pragmatic choice for that workflow. Keep `allow_legacy_guid` **off** in production, where Clerk or API keys are the real auth.

## Electron Desktop App

When using the desktop application:

1. Enter the server URL (e.g., `http://localhost:3001`)
2. Enter your API key (a `trve_…` token generated from
   **Manage → API Keys** in the browser dashboard, signed in as
   the user the desktop app should authenticate as)
3. Click **Connect**

Credentials are stored encrypted via the operating system keychain
(macOS Keychain, Windows DPAPI, libsecret on Linux) and restored on
next launch. To revoke a desktop client's access, delete its API
key from **Manage → API Keys**.

## User Capabilities

Each user has a set of capabilities that control access:

| Capability | Access |
|------------|--------|
| **View** | View dashboards (always available) |
| **Control** | Execute control commands — button presses, toggles, sliders, "Mark Reviewed" on Frigate alerts, etc. Without it, controls render their current state but the interactive affordance is disabled. Existing humans are backfilled with Control; new users explicitly opt in. |
| **Design** | Create and edit components, connections, and dashboards |
| **Manage** | Administer users, device types, and system settings |
| **Webhook** | (System users only) Receive inbound webhooks at `/api/webhooks/*` |

The mode toggle in the header only shows modes you have access to.

## Header Pills at a Glance

Once you're logged in, the application header shows two contextual pills next to the mode toggle:

- **Mode pill** — the current mode (View / Design / Manage). Click to switch.
- **Namespace pill** — your active [namespace](namespaces.md). Determines the default namespace for any new connection, component, or dashboard you create. Click to switch.

Both pills persist across sessions, so each user keeps their own working context.
