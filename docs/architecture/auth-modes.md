# Authentication & Authorization architecture

This page is the developer-facing map of the auth surface. For
admin-facing setup, see [Clerk Sign-In](../../udoc/docs/clerk-sso.md)
and [API Keys](../../udoc/docs/api-keys.md).

## Two authentication models (read this first)

**Both models give you a persistent logged-in session** — the difference is
*what carries the session* and *how long it lives*, not whether one exists.
Most confusion comes from the word "session" meaning two things, so to be
exact: below, **"JWT exchange"** means the specific Clerk→JWT bootstrap, and
**"session"** means the plain-English persistent-login state (which *both*
models provide).

| | **JWT-session model** | **API-key model** |
|---|---|---|
| **Who uses it** | Interactive **browser** sign-in (Clerk, or dev-mode GUID) | Long-lived device/service logins: **kiosks**, ts-store webhooks, MCP clients, cron scripts. **A browser uses this too** when given a key (the kiosk pattern). |
| **How the session starts** | Inbound credential (Clerk JWT / GUID) is traded **once** at `POST /api/auth/session` for the app's own JWT pair | The **API key itself is the session** — supply it once (via `?key=trve_…` in the browser, or the Electron setup screen) and it's stored + reused. No JWT exchange. |
| **What's resent on each call** | The app's short-lived **access JWT** (`Authorization: Bearer <jwt>`). The original Clerk credential is **not** resent. | The **raw API key** (`Authorization: Bearer trve_…`) — resent verbatim on **every** request. |
| **How long the session lasts** | The access JWT expires (default 15 min) and is silently refreshed via an httpOnly cookie; sign-out revokes the refresh family. | **Persists indefinitely — until an admin deletes the key** (immediate revocation). No expiry, no refresh. This is exactly the "stay logged in until the key is revoked" behavior kiosks want. |
| **Where the credential persists** | Access token in memory; refresh token in an httpOnly cookie | Browser: the key in `localStorage`. Electron: the key encrypted in `electron-store` (OS keychain via `safeStorage`). |
| **Server validation per call** | Verify JWT signature + exp (no DB hit) | Validate the key against the `api_keys` collection (one indexed lookup) |

### Answering the common questions

- **Does an API key give you a persistent session?**
  **Yes.** This is the kiosk story: supply a key once and you stay logged
  in **until the key is revoked** — no expiry, no re-login. The browser
  stores the key in `localStorage` and re-applies it on the next launch
  (`client.js`: `setApiKey` writes it, the constructor reads it back); the
  Electron app stores it encrypted and re-applies it on each start. The key
  doesn't create a *JWT* session, but it absolutely is a session in the
  ordinary sense — a durable, persisted logged-in state.

- **Can the API-key method be used from a browser?**
  **Yes.** The per-call middleware accepts `Authorization: Bearer trve_…`
  from *any* caller, browser or not (`middleware/auth.go::Authenticate`,
  the `trve_` branch). Today the only way to *get* a key into a browser
  session is the `?key=trve_…` URL param (or the Electron setup screen) —
  there's no "paste your key" login form in the browser. Once set, it
  persists and behaves identically to a service principal.

- **How is it resent on each call?**
  The frontend stamps the raw key into the `Authorization: Bearer trve_…`
  header (or the `?st=trve_…` query param for EventSource/WebSocket) on
  **every** request, and the server re-validates it against the `api_keys`
  collection each time. See `client.js` `request()` (`if (this.apiKey)
  headers['Authorization'] = 'Bearer ' + this.apiKey`). Contrast the
  JWT-session model, where the **access JWT** — not the original Clerk
  credential — is what gets resent.

- **How does this relate to `POST /api/auth/session` and Clerk?**
  An API key does **not** go through the JWT exchange — it is not traded
  for an access/refresh JWT. The middleware checks the API-key shape
  (`trve_…`) **first**, before Clerk, so a key authenticates as its owner
  regardless of whether Clerk is configured. Calling `/api/auth/session`
  with a key *will* return a claims payload (the `apikey` IdP resolves it),
  but the frontend doesn't swap to a JWT afterward — it keeps sending the
  key. So you don't "log in" separately with a key; **the key is the login.**

> **One word, two meanings.** "Session" can mean (a) the specific
> **JWT exchange** at `/api/auth/session`, or (b) a persistent logged-in
> **state**. API keys skip (a) but fully provide (b). Earlier phrasing in
> this doc that said API keys "aren't a session" meant only sense (a) — an
> API key *is* a session in sense (b), and a longer-lived one than the JWT.
> Likewise, "the API key is resent on every call" is **correct** — that's
> the whole model — it just isn't how Clerk/browser login behaves.

Authorization (what a principal is *allowed* to do) is identical for both
models: a synchronous capability check on the resolved claims, no DB
round-trip on the hot path. See [Authorization](#authorization-how-claims-become-decisions).

## Three deployment modes (which credentials a deployment accepts)

The two models above are *how* a credential authenticates. **A deployment
also chooses which credential channels it accepts** — and that's a separate
axis, controlled by two settings. The combinations give three practical
postures. API-key auth is **always on** (it can't be disabled); the two
human-login channels each have an on/off switch:

| | **Clerk SSO** | **Legacy GUID (dev)** | **API-key only (headless)** |
|---|---|---|---|
| **`CLERK_SECRET_KEY` env** | **set** | unset | unset |
| **`auth.allow_legacy_guid`** | `false` (recommended) | **`true`** | `false` |
| **Human signs in via** | Clerk's hosted sign-in screen (real auth: email/SSO/MFA) | A user-picker dropdown — anyone who knows a GUID becomes that user (**no password**) | **Nothing** — there is no human login. Entry is by API key only. |
| **Browser kiosk** | Add a `?key=trve_…` API key (kiosk has no human to sign in) | `?key=trve_…`, **or** `?user_id=<guid>`, **or** the `default_browser_user_guid` setting for zero-touch | `?key=trve_…` only |
| **Zero-touch default user** (`default_browser_user_guid`) | ✗ (needs the legacy GUID channel) | ✓ | ✗ (needs the legacy GUID channel) |
| **Intended for** | Real multi-user deployments, small teams, demos | **Local dev only** (`npm run dev` user switcher) — never production | Pure kiosk / headless / appliance deployments where every client is a service principal |
| **This is the default in** | — | `config.development.yaml` (`allow_legacy_guid: true`) | **`config.yaml` (production)** — Clerk unset + `allow_legacy_guid: false` |

**Reading the table:**

- **Clerk SSO** — the only mode with real, password/SSO-backed human
  authentication. Set the two `CLERK_*` env vars; leave legacy GUID off so a
  header-asserted identity can't bypass Clerk. This is the recommended
  posture for any deployment with human users.
- **Legacy GUID (dev)** — `X-User-ID` / `?user_id=` are honored. This is an
  *identity assertion*, not authentication: **anyone who knows a GUID
  becomes that user.** It exists for the dev user-switcher and migration.
  **Do not enable in production.** The server prints a `⚠️` warning at
  startup when it's on.
- **API-key only (headless)** — the production default. With Clerk unset and
  legacy GUID off, the **only** credential that authenticates is a `trve_…`
  API key. There is no human sign-in screen at all. Right for an appliance /
  kiosk fleet where every client is a service principal.

**Two things to know about API-key-only mode:**

1. **No human login means you need a way to mint the first/admin API key.**
   You can't reach *Manage → API Keys* to create a key without already being
   authenticated. The simplest bootstrap is to **lean on the dev login
   channel once**:

   1. Start the server with `auth.allow_legacy_guid: true` (or
      `DASHBOARD_AUTH_ALLOW_LEGACY_GUID=true`).
   2. Sign in as an admin user via the GUID picker and mint an admin API key
      in *Manage → API Keys*. Copy the `trve_…` token.
   3. Set `auth.allow_legacy_guid: false` and restart.

   Now legacy GUID is closed, Clerk is off, and you hold a working admin key —
   the deployment is API-key-only and you're still able to administer it.
   (Alternatively, seed an `api_keys` row directly if you're provisioning the
   database out-of-band.)
2. **A few routes stay public regardless of mode** — auth is bypassed for
   `/api/health`, `/api/config/system` (GET), `/api/settings/:key` (GET),
   `/api/ai/availability` (GET), and `/api/frigate/` GETs (camera media for
   `<img>`/`<video>` tags). These are read-only/non-sensitive by design, but
   if "API key for everything" is a hard requirement, these are the
   documented exceptions. See [the route-rules table](#the-route-rules-table).

## The JWT-session model (browser sign-in)

This is the flow for the **JWT-session model** — Clerk or GUID sign-in
in a browser. The **API-key model skips this entire diagram**: an API key
is validated directly by the middleware on each call (the dashed path at
the bottom) and never visits the bootstrap endpoint or the session
service.

```
                       ┌─────────────────────────────────────┐
   Inbound credential  │                                     │
   ─────────────────►  │  IdP registry  (apikey, clerk,      │
   (Clerk JWT,         │                  legacy-guid, …)    │
    trve_… key,        │                                     │
    X-User-ID, etc.)   └────────────────┬────────────────────┘
                                        │
                          POST /api/auth/session  (one time per browser session)
                                        ▼
                       ┌─────────────────────────────────────┐
                       │ Session service                     │
                       │  - issues access JWT  (15 min)      │
                       │  - issues refresh JWT (7 days,      │
                       │      httpOnly cookie)               │
                       │  - revocable per refresh-family     │
                       └────────────────┬────────────────────┘
                                        │
                          access JWT on every subsequent request
                                        ▼
                       ┌─────────────────────────────────────┐
                       │ Authentication middleware           │
                       │   verify(jwt) → *Claims             │
                       │     OR                              │
                       │   validate(trve_… key) → *Claims    │
                       │                                     │
                       │ attach claims to request context    │
                       └────────────────┬────────────────────┘
                                        │
                          DoesUserHavePriv(claims, needed)
                                        ▼
                       ┌─────────────────────────────────────┐
                       │ Authorization                       │
                       │   route-rules table: required cap   │
                       │   per route. View is the floor.     │
                       └─────────────────────────────────────┘
```

## Authentication: how credentials become claims

### The bootstrap endpoint (`POST /api/auth/session`)

The **single funnel** for any external credential. Walks the IdP
registry in order; the first provider that recognizes its credential
shape and successfully validates wins. Trades the result for a
JWT pair:

```
{ access_token, expires_at, user: { user_id, guid, name, capabilities, kind } }
```

The refresh token rides an httpOnly cookie (`trve_refresh`) scoped to
`/api/auth` so the browser sends it automatically on `/api/auth/refresh`
and `/api/auth/logout` but **not** on regular API calls.

### Identity providers (`internal/auth/idp/`)

Pluggable interface. Adding a new IdP is one file, registered in
`main.go`. The middleware doesn't change; the route-rules table
doesn't change; the client doesn't change.

```go
type IdentityProvider interface {
    Name() string
    Resolve(ctx context.Context, c *gin.Context) (*models.User, error)
}
```

Shipped providers:

| Provider | File | Recognizes | Use case |
|---|---|---|---|
| `apikey` | `idp/apikey.go` | `Authorization: Bearer trve_…` or `?key=trve_…` | Service principals + kiosks. **Note:** the `apikey` IdP resolves a key *at* `/auth/session`, but API-key clients don't trade it for a JWT — they keep sending the key per-call (see [Two authentication models](#two-authentication-models-read-this-first)). This IdP entry mainly lets `/auth/session` echo the identity; the key remains the session. |
| `clerk` | `idp/clerk.go` | Clerk session JWT | Browser sign-in for small teams, demos |
| `legacy-guid` | `idp/legacy.go` | `X-User-ID` header or `?user_id=` query | Dev mode user switcher, kiosk URL bookmarks |

Order matters — providers earlier in the list win when a request
carries multiple credentials. The current order is `apikey, clerk,
legacy-guid` because the `trve_` prefix is unambiguous and we never
want to fall through to the weaker GUID assertion when a stronger
credential was presented.

### Future providers

| Provider | Status | Use case |
|---|---|---|
| Generic OIDC | planned | Enterprise customers with their own IdP (Okta, Entra, Keycloak) — drop in next to clerk.go, no other changes |
| Trusted reverse proxy | planned | Zero-trust deployments behind oauth2-proxy / Cloudflare Access / Pomerium / Tailscale TS Auth |
| SAML | planned (longer term) | SAML 2.0 IdPs that don't speak OIDC |

### The session service (`internal/auth/session_service.go`)

Holds the JWT signer + the revoked-family allowlist. Three operations:

- **`IssueTokenPair(user, source)`** — fresh access + refresh, new family_id
- **`RefreshTokenPair(refreshToken, users)`** — rotates the pair, re-fetches the user record (capability changes propagate on every refresh)
- **`RevokeFamily(familyID, reason, userGUID)`** — poisons a family; subsequent refresh attempts fail

Token TTLs are admin-configurable via the settings UI:

| Setting key | Default | Range |
|---|---|---|
| `auth.access_token_ttl_seconds` | 900 (15 min) | 60–3600 |
| `auth.refresh_token_ttl_seconds` | 604800 (7 days) | 3600–2592000 |

Changes apply to *new* tokens; already-issued tokens keep their original exp.

### The middleware (`internal/middleware/auth.go::Authenticate`)

On every authenticated request:

```
1. Extract token from one of:
     Authorization: Bearer <token>
     ?st=<token>                  (EventSource / WebSocket — can't set headers)

2. Dispatch by shape:
     starts with "trve_"  → validate against api_keys collection;
                            synthesize *Claims from the resolved user.
     anything else        → verify as our access JWT;
                            *Claims comes from the verified claims.

3. Attach claims + a User shim to the request context.
```

API keys are validated on every request — that's the long-lived
service-principal contract. Revocation is admin-deletes-the-key,
immediate. Access JWTs are verified by signature + exp; no DB hit.

### Refresh + rotation

`POST /api/auth/refresh` accepts the refresh cookie, mints a new pair,
**rotates** the refresh (new `jti`, same `family_id`). Standard
OAuth2 refresh-rotation. Replay-detection: presenting an old refresh
token after rotation poisons the whole family.

On refresh, the user record is re-fetched. Capability changes
propagate to the next access token within one refresh window.
Deactivated users fail refresh entirely.

The browser-side `apiClient` auto-refreshes on `401 hint:"refresh"`,
coalesced so concurrent 401s don't stampede the endpoint. Refresh
failure fires `onSessionExpired`, which App.jsx wires to a full
re-bootstrap.

## Authorization: how claims become decisions

### The primitive

```go
func DoesUserHavePriv(claims *Claims, needed models.Capability) bool {
    if claims == nil { return false }
    return claims.HasCapability(needed)
}
```

Every authz check in the codebase routes through this one function.
No DB hit, no service call — the JWT carries the capability set
directly. The signed claims ARE the source of truth at request time.

The trade-off: capability changes don't propagate until the next
refresh (default 15 min). Acceptable today; if we ever need
revocation-on-the-instant we can add a per-user `min_iat` check
in the middleware that compares against `claims.iat`.

### Capabilities

A short list of strings on each user record. The JWT carries the
list verbatim.

| Capability | Granted to | Allows |
|---|---|---|
| `view` | All human users; kiosk-style system users | Read all non-admin routes |
| `design` | Designers, admins | Create/edit dashboards, components, connections |
| `manage` | Admins | Manage users, settings, namespaces, system users, API keys |
| `webhook` | System users (typically) | Receive inbound webhook posts at `/api/webhooks/*` |

`view` is the **structural floor** since v0.17.0: routes without an
explicit capability rule require `view`. This is what lets a
webhook-only system user (capabilities = `[webhook]`) hit
`/api/webhooks/*` but *not* `/api/dashboards`. Kiosk system users
carry `[view]` (or `[view, webhook]`) and work everywhere a read is
expected.

### The route-rules table

`buildRouteRules()` in `auth.go` declares which routes need which
capabilities. The rules are matched longest-prefix-first.

```go
{PathPrefix: "/api/components",  Method: "POST", Required: CapabilityDesign},
{PathPrefix: "/api/users",       Method: "POST", Required: CapabilityManage},
{PathPrefix: "/api/webhooks",                    Required: CapabilityWebhook},
{PathPrefix: "/api/auth/me",     Method: "GET",  Public: true, Exact: true},
{PathPrefix: "/api/frigate/",    Method: "GET",  Public: true},
// (no rule)                                                              → view
```

- **`Public: true`** rules pass through without any auth — only the
  handful of routes the SPA bootstrap or browser-loaded media tags
  must reach pre-auth (`/api/auth/me`, `/api/auth/session`,
  `/api/auth/refresh`, `/api/auth/logout`, `/api/health`,
  `/api/settings/:key` for runtime-discovery values, `/api/frigate/`
  GETs for `<img src>`/`<video src>`).
- **`Required: <cap>`** rules require that specific capability.
- **No rule** → defaults to `CapabilityView`.

### Path-param authz

Some routes need access checks that depend on URL shape, not just
"does the caller have this capability." The current example is
`/api/config/user/:user_id` — the caller must be the user whose
preferences they're reading or writing.

That check lives in the **handler**, not in the rules table, because
the route-rules matcher doesn't know about path parameters:

```go
func (h *ConfigHandler) GetUserConfig(c *gin.Context) {
    if !requireSelf(c) { return }
    // ...
}
```

`requireSelf` reads `middleware.GetUser(c).GUID` and compares
against `c.Param("user_id")`. Same pattern works for any future
"self-only" or "owns-resource" check.

## Client side

### Bootstrap (App.jsx)

Single bootstrap call:

```js
const session = await apiClient.createSession();
```

`createSession` forwards whatever inbound credential is available
(Clerk JWT via `tokenProvider`, API key via `setApiKey`, GUID via
`setCurrentUser`) to `POST /api/auth/session`. The server's IdP
registry decides which channel wins.

**The response differs by model** (see [Two authentication models](#two-authentication-models-read-this-first)):

- **Session-token model** (Clerk / GUID): the response carries an
  **access token** + a `User` record, and sets the httpOnly refresh
  cookie. From here on, `request()` resends the **access JWT**.
- **API-key model**: the frontend keeps the key set via `setApiKey`.
  `createSession` still returns claims, but the client does **not** adopt
  a JWT — it goes on resending the **raw key**. (For a pure API-key
  client like a kiosk, `createSession` is effectively just an identity
  echo; the auth that matters is the per-call key.)

After bootstrap, `apiClient.request()` attaches **one** credential on
every call, using this precedence:

1. **API key** if one is set (`this.apiKey`) → `Authorization: Bearer
   trve_…`. Long-lived, no refresh dance, dies only when an admin
   revokes. Skips JWT refresh entirely.
2. **Access JWT** otherwise → `Authorization: Bearer <jwt>`, auto-
   refreshed on a `401 hint:"refresh"`.

API keys win precedence because their lifecycle (admin-revokes-by-
delete) is the right semantic for always-on displays. JWT refresh
cycles would silently kill a kiosk after 7 idle days. **Note this is the
per-call credential the frontend resends — for an API key that is the
key itself, not a JWT.**

### EventSource / WebSocket

Both APIs refuse to set custom headers. Credentials ride the URL:

```
GET /api/connections/:id/stream?st=<credential>
WS  /api/ai/sessions/:id/ws?st=<credential>
```

`<credential>` is whichever credential `apiClient` would attach on a
regular fetch (API key wins; JWT otherwise). `apiClient.streamAuthQuery()`
formats the fragment.

### Identity-resolution events

When `apiClient.setAccessToken()` or `setApiKey()` transitions from
"no credential" to "has credential," it dispatches the
`apiclient-authenticated` event on `window`. Context providers
mounted above the route tree (`EnabledTypesProvider`, etc.) that
need to fetch data after bootstrap listen for this event and
re-trigger their initial load. Without it, those providers would
fire their first call during mount — before `createSession()` has
returned — and 401.

The route tree itself is gated on `identityResolved` in App.jsx, so
page-level data fetches don't fire until bootstrap completes. The
event is only needed for context/provider components that mount
above the router.

## Enterprise self-host considerations

The product is shipped as container images and self-hosted by the
customer. Three deployment postures cover most of the market:

- **Small team / homelab** — Clerk works out of the box. Customer
  signs up at Clerk, sets two env vars, done.
- **Mid-market with IdP** — generic OIDC (planned). Customer points
  the dashboard at their existing Okta / Entra / Keycloak tenant. No
  third-party domain in the credential path.
- **Zero-trust / regulated** — reverse-proxy mode (planned). The
  customer's gateway (oauth2-proxy, Cloudflare Access, Pomerium,
  Tailscale TS Authentication) authenticates and stamps a verified
  email or subject header. The dashboard trusts the header only
  when the request comes from a configured trusted CIDR.

Per-deployment licensing for Clerk / Okta / etc. is the customer's
bill. The dashboard doesn't proxy or share auth provider accounts.

## Adding a new IdP (template)

1. Implement `IdentityProvider` in a new file under
   `server-go/internal/auth/idp/`. The `Resolve` method inspects the
   request for the new credential shape, validates it, and returns
   a `*models.User` (or `nil` to defer, or an error wrapping
   `ErrCredentialInvalid` to abort).
2. Register the new provider in `main.go`'s IdP registry composition,
   choosing the right order relative to the existing providers.
3. (If applicable) configure the SPA side — Clerk needs a
   publishable key flowed via `/api/config/system`; OIDC needs the
   authorization endpoint URL; proxy mode is server-only.
4. Document the env vars in [`udoc/docs/`](../../udoc/docs/) (admin-
   facing) and update this page (developer-facing).

Nothing else changes. The middleware, route rules, session service,
client `request()` path, and authz primitive are all
provider-agnostic.

## Files of interest

### Server

- `internal/auth/jwt.go` — token signing + verification + claims + `DoesUserHavePriv`
- `internal/auth/session_service.go` — Issue/Refresh/Revoke + admin-TTL reads
- `internal/auth/idp/` — pluggable identity providers
- `internal/auth/verifier.go` — legacy interface for external IdPs (Clerk, future OIDC); used inside the `clerk` IdP
- `internal/auth/clerk.go` — Clerk verifier implementation
- `internal/middleware/auth.go` — `Authenticate()` + `Authorize()` + route rules table
- `internal/handlers/auth_session_handler.go` — `/api/auth/session`, `/auth/refresh`, `/auth/logout`
- `internal/repository/revoked_families_repository.go` — Mongo-backed revocation list (TTL'd)
- `internal/repository/user_repository.go` — `FindByClerkID`, `FindByEmail`, `SetClerkID`
- `internal/service/config_service.go` — flows the Clerk publishable key to `/api/config/system`

### Client

- `client/src/api/client.js` — single funnel: `createSession`, `request` with credential precedence, `_refreshSession`, `streamAuthQuery`, `setAccessToken` / `setApiKey` (dispatch `apiclient-authenticated`)
- `client/src/App.jsx` — bootstrap effect; gates route tree on `identityResolved`
- `client/src/auth/ClerkBootstrap.jsx` — soft-switch at the top of the React tree (mounts `ClerkProvider` only when Clerk is configured)
- `client/src/auth/ClerkAuthGate.jsx` — `<SignedIn>` / `<SignedOut>` gating
- `client/src/auth/ClerkSessionBridge.jsx` — wires Clerk's `getToken()` into `apiClient.setTokenProvider()`
- `client/src/context/EnabledTypesContext.jsx` — pattern for "provider above the router that needs auth"; listens for `apiclient-authenticated`
- `client/src/components/AccountMenu.jsx` — Sign Out item rendered when `clerkActive` is true

## Notable historical decisions

- **Why two layers (external creds + our JWT)?** Pre-v0.17 every request walked through the IdP chain on each call — expensive for Clerk (JWKS lookups) and made adding a new IdP a middleware rewrite. The session token funnel collapsed the four pre-existing credential channels (API key, Clerk JWT, X-User-ID, ?user_id=) into a single point of bootstrap.
- **Why are API keys not bootstrap-only?** Service principals (kiosks, agents, webhook receivers) don't have a "session" to expire. The credential IS the session; revocation is the lifecycle event. Forcing API keys through refresh-rotation would silently kill a kiosk after the refresh TTL.
- **Why is `view` the structural floor?** Webhook-only system users (e.g. ts-store webhook receiver) should not be able to read the dashboard. Making `view` explicit gives admins a way to scope a system user to just inbound webhooks without ambient read access.
- **Why claims-based authz, not DB-lookup-per-request?** Speed. A JWT verification is a few microseconds; a Mongo lookup is milliseconds. The trade-off — capability changes lag by ~15 min — is acceptable given the rate at which admins actually change capabilities.
- **Why httpOnly cookie for refresh, JS-readable for access?** XSS exposure window is bounded by the access TTL (15 min); the refresh stays out of JS reach. Standard industry practice.
