---
sidebar_position: 2
---

# Logging In & User Selection

## Browser Mode

When accessing TRVE Dashboards through a web browser, identity is resolved on first load using one of these channels (in order):

1. **`?user_id=<guid>` in the URL.** A personal launch URL that bakes in the visitor's identity. After the page loads, the URL bar drops the parameter — the GUID is captured to local storage so subsequent visits to the bare URL keep the same identity.
2. **A previous session.** If you've visited before in this browser, your identity is remembered.
3. **A deployment-wide default.** Admins can configure a `default_browser_user_guid` in [System Settings](system-settings.md). Any visitor who hasn't been assigned an identity by 1 or 2 inherits this default.
4. **None of the above.** The app shows a "Sign-in not configured" stub. Contact your administrator for a launch URL or to set the deployment default.

Your capabilities (View, Design, Manage) determine which application modes are available to you, regardless of how identity was resolved.

### Important — this is not authentication

The browser-mode identity flow is **identity assertion**, not authentication. Anyone who knows a personal launch URL or visits the bare URL of a deployment with a default user becomes that user. Treat launch URLs like shared passwords. For real access control, place the dashboard behind a VPN, reverse proxy with auth, or single-user homelab boundary. A real login (cookies + password) is on the roadmap; this is the bootstrap layer it will replace.

### Switching identity in production

To act as a different user in browser mode, visit the dashboard with `?user_id=<their-guid>` in the URL. The new identity replaces the previous one and persists in this browser until explicitly changed (or until local storage is cleared).

### Dev mode

When the client is running under `npm run dev` (Vite dev server), the legacy user-switching dropdown is still visible in the header. Production bundles (built with `npm run build`) drop it entirely.

## Electron Desktop App

When using the desktop application:

1. Enter the server URL (e.g., `http://localhost:3001`)
2. Enter your API key
3. Click **Connect**

Credentials are stored securely and restored on next launch.

## User Capabilities

Each user has a set of capabilities that control access:

| Capability | Access |
|------------|--------|
| **View** | View dashboards and interact with controls (always available) |
| **Design** | Create and edit components, connections, and dashboards |
| **Manage** | Administer users, device types, and system settings |

The mode toggle in the header only shows modes you have access to.

## Header Pills at a Glance

Once you're logged in, the application header shows two contextual pills next to the mode toggle:

- **Mode pill** — the current mode (View / Design / Manage). Click to switch.
- **Namespace pill** — your active [namespace](namespaces.md). Determines the default namespace for any new connection, component, or dashboard you create. Click to switch.

Both pills persist across sessions, so each user keeps their own working context.
