---
sidebar_position: 2
---

# Logging In & User Selection

## Browser Mode

When accessing TRVE Dashboards through a web browser, you select your user from a dropdown in the application header.

1. Click the user icon in the top-right corner of the header
2. Select your user from the dropdown list
3. Your capabilities (View, Design, Manage) determine which application modes are available to you

Your user selection is remembered across sessions.

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
