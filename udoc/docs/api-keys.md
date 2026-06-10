---
sidebar_position: 19
---

# API Keys

API keys are personal authentication tokens. Use one for:

- **Programmatic / non-browser callers** — [MCP](mcp.md) clients, scripts,
  the Swagger UI, anything calling the REST API directly.
- **Browser-based kiosks / always-on displays** — a browser tab that should
  stay logged in indefinitely until you revoke it, with no sign-in screen
  and no session timeout. See [Browser kiosks](#browser-kiosks-stay-logged-in-until-revoked)
  below.

Regular interactive browser users (signing in at their desk) don't need a
key — the normal [sign-in flow](getting-started.md) covers them. A key is
specifically for unattended or non-browser access.

A key is also how you authenticate the interactive
[Swagger UI](http://localhost:3001/swagger/index.html) (`/swagger/index.html`
on your server): click **Authorize**, enter `Bearer trve_…`, and every
"Try it out" call is sent as that user.

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
   - mcp-proxy / Claude Desktop: see [MCP](mcp.md#authentication) for
     the full launcher snippet.
   - curl: `curl -H "Authorization: Bearer trve_…" …`

If you lose a token, revoke the key (below) and create a new one.

## Browser kiosks (stay logged in until revoked)

For an always-on display — a wall-mounted dashboard, a status board, a
kiosk tablet — you usually want it to **come up already logged in and stay
that way until you decide otherwise**, with no sign-in screen and no
session that expires overnight. An API key does exactly this in a plain
browser.

**Set it up by putting the key on the URL once:**

```
https://your-dashboard.example.com/?key=trve_…
```

What happens on that first load:

1. The browser reads the `?key=trve_…` parameter and adopts it as the
   active credential.
2. It **stores the key in the browser's `localStorage`** and **removes the
   key from the address bar** (so the URL no longer shows the secret).
3. Every request from then on is authenticated as that key's owner.

After that, the kiosk is logged in **permanently** — it survives page
reloads and device restarts (the key is re-read from `localStorage` on
each launch), and there is **no expiry or refresh**. It keeps working until
you [revoke the key](#revoking-a-key), at which point the kiosk stops
authenticating on its next request.

**Tips for kiosks:**

- **Use a dedicated key (and ideally a dedicated user)** per kiosk, named
  for the device (e.g. "kitchen-wall-display"). Then revoking one device
  doesn't affect the others, and `last_used` tells you if a display went
  dark.
- **Scope the kiosk user's capabilities** to what it needs — typically
  just `view`. The key inherits the owning user's full capability set
  (there's no per-key scoping), so a view-only kiosk user keeps an
  unattended screen from being able to change anything.
- **The key is the password.** Anyone who can read that kiosk's
  `localStorage` (or saw the original URL) has the key. Treat the device as
  trusted, and revoke + reissue if it's ever lost or repurposed.
- **To log a kiosk out**, revoke its key (the screen stops working on the
  next call) — or clear the browser's site data to drop the stored key.
- **Desktop app:** the TRV Outpost desktop (Electron) app does the same
  thing with a one-time setup screen instead of a URL, and stores the key
  *encrypted* in the OS keychain. Same model — the key persists until
  revoked — just a nicer setup step and at-rest encryption.

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

- [API Overview](api-overview.md) — the REST API, the Swagger UI
  explorer, and the Postman collection.
- [MCP](mcp.md#authentication) — using a key with Claude Desktop
  via mcp-proxy.
- [Logging In & User Selection](getting-started.md) — the browser
  identity model (separate from API keys).
