---
sidebar_position: 19
---

# API Keys

API keys are personal authentication tokens for non-browser callers — the
[dashboard-agent](dashboard-agent.md) CLI, [MCP](mcp.md) clients, and
scripts. Browser users don't need a key (the SPA's identity flow covers
those); anything calling the API from outside a browser session does.

Manage your keys from **Manage Mode → API Keys**. Every authenticated
user can create their own keys; admins (Manage capability) can also see
the deployment-wide list.

## What a key looks like

Tokens are issued in the format `trve_<random-base32>`. Pass the token
in the standard HTTP `Authorization` header:

```
Authorization: Bearer trve_…
```

Each key inherits the **full capability set of its owning user** —
there's no per-key scoping today. Treat a key as equivalent to the
owner's full session credentials.

## Creating a key

1. Open **Manage Mode → API Keys**.
2. Click **New API key**.
3. Give it a memorable name ("homelab-agent", "claude-desktop", etc.).
4. The plaintext token appears in a confirmation modal. **Copy it
   now** — the server only stores the bcrypt hash and a short
   plaintext prefix, so once the modal closes the plaintext can't be
   recovered.
5. Paste the token into your tool's configuration:
   - dashboard-agent: `export DASHBOARD_API_KEY=trve_…` (or
     `--api-key trve_…`)
   - mcp-proxy / Claude Desktop: see [MCP](mcp.md#authentication) for
     the full launcher snippet.
   - curl: `curl -H "Authorization: Bearer trve_…" …`

If you lose a token, revoke the key (below) and create a new one.

## Revoking a key

In the API Keys list, click the trash icon on the row of the key you
want to revoke. The key is marked revoked in the database — the row
stays visible (so you can audit which keys you've issued) but the
token immediately stops authenticating. Revocation is irreversible;
use **New API key** to roll a replacement.

## Where keys live

Keys are stored in MongoDB's `api_keys` collection:

- The plaintext token is **never persisted** — only `bcrypt(token)`
  in the `hash` field.
- The first 8 chars of the token (after `trve_`) are stored
  plaintext in the `prefix` field, used by the auth middleware as
  an indexed candidate filter before the bcrypt comparison. This
  keeps validation O(1) instead of O(N).
- `last_used` is updated asynchronously on every successful
  authentication.

## Security notes

- API keys are real authentication; the legacy `X-User-ID` header is
  identity assertion (anyone who knows a GUID becomes that user).
  For any deployment that's not single-user-behind-VPN, use API keys.
- A request with both `Authorization: Bearer …` and `X-User-ID` is
  treated as Bearer-authenticated — the legacy header is ignored
  when a valid key is present.
- Keys do not expire automatically today (the model has an
  `ExpiresAt` field reserved for a future expiration UI). Revoke
  keys you no longer need.

## See also

- [MCP](mcp.md#authentication) — using a key with Claude Desktop
  via mcp-proxy.
- [Dashboard Agent](dashboard-agent.md) — using a key with the
  dashboard-agent CLI.
- [Logging In & User Selection](getting-started.md) — the browser
  identity model (separate from API keys).
