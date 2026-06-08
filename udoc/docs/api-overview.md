---
sidebar_position: 18
---

# API Overview

TRV Outpost exposes a REST API for everything the dashboard does —
connections, components, dashboards, namespaces, settings, and more. The
same API powers the browser SPA, the desktop app, scripts, and external
agents. This page is the starting point for talking to it directly.

## Authentication

Every API call is authenticated with an `Authorization: Bearer <token>`
header. The token is either:

- An **[API key](api-keys.md)** (`trve_…`) — the right choice for
  scripts, kiosks, automation, and the interactive explorer below. Mint
  one from **Manage Mode → API Keys**.
- A **session JWT** — minted automatically for interactive browser
  sessions; you don't normally handle it yourself.

See [API Keys](api-keys.md) for how to create and use a key.

## Interactive explorer (Swagger UI)

The fastest way to explore the API is the built-in **Swagger UI**, served
by your own server at:

- [`/swagger/index.html`](http://localhost:3001/swagger/index.html)
  (substitute your server's host if you're not on `localhost`)

It lists every endpoint with request/response schemas and a **Try it
out** button that issues live calls against your server. To make
authenticated calls:

1. Mint an [API key](api-keys.md) (**Manage Mode → API Keys**).
2. Click **Authorize** in the Swagger UI.
3. Enter `Bearer trve_…` (your key) and confirm.
4. Every **Try it out** call is now sent as that user.

The explorer reads its base URL from however you reached the server, so
the calls target the right host automatically.

## Postman collection

A ready-to-import Postman collection lives in the repository at
`docs/postman/trv-outpost.postman_collection.json`, alongside an
environment file (`trv-outpost.postman_environment.json`) for the base
URL and token. Both are regenerated from the API annotations as part of
the release process, so they stay in sync with the running server.

## API surfaces

The REST API is the primary surface, but it isn't the only way in:

- **REST API** — the full endpoint set, documented in the Swagger UI
  above. Use it from any HTTP client.
- **[MCP](mcp.md)** — a Model Context Protocol endpoint (`POST /mcp`) for
  external AI agents (e.g. Claude Desktop via `mcp-proxy`). MCP is *one*
  surface over the same system, scoped to agent-friendly tools — not the
  whole REST API.

## Related

- [API Keys](api-keys.md) — creating and using `trve_…` tokens
- [MCP](mcp.md) — connecting an external AI agent
- [Clerk SSO](clerk-sso.md) — browser sign-in and identity
