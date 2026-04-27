# Authentication architecture

The dashboard supports multiple authentication backends, selected at
deploy time via env vars. All modes funnel through a single
`IdentityVerifier` interface and a shared user-resolution function so
adding a new IdP is a new implementation, not a middleware rewrite.

This page is the developer-facing map of the auth surface. For
admin-facing setup, see [Clerk Sign-In](../../udoc/docs/clerk-sso.md)
and [API Keys](../../udoc/docs/api-keys.md).

## Modes shipped, planned, and rationale

| Mode | Status | Env switch | Use case |
|------|--------|------------|----------|
| API keys | shipped (v0.9.0) | always on | Non-browser callers — dashboard-agent CLI, MCP clients, scripts |
| Clerk | shipped (v0.10.0) | `CLERK_SECRET_KEY` | Browser sign-in for small teams, demos, single-deployment customers |
| `X-User-ID` legacy | shipped (≤v0.9.0) | always on (until removed) | Dev mode user switcher, migration grace path |
| Generic OIDC | planned (v0.11.0) | `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` | Enterprise customers with their own IdP (Okta, Entra, Keycloak) |
| Trusted reverse proxy | planned (v0.12.0) | `TRUSTED_PROXY_CIDR` + `PROXY_AUTH_HEADER` | Zero-trust deployments behind oauth2-proxy / Cloudflare Access / Pomerium |

## The IdentityVerifier interface

Lives in [`server-go/internal/auth/verifier.go`](../../server-go/internal/auth/verifier.go).

```go
type IdentityVerifier interface {
    VerifyToken(ctx context.Context, token string) (*VerifiedIdentity, error)
    ProviderName() string
}

type VerifiedIdentity struct {
    Subject string  // Provider-specific stable ID (Clerk `sub`, OIDC `sub`, etc.)
    Email   string  // Verified email when the provider supplies one
}
```

A verifier validates a bearer token from one external IdP and
returns the verified identity. Failures wrap `ErrInvalidToken`. The
middleware translates the result into a dashboard `User` via:

```go
func ResolveUserByVerifiedIdentity(
    ctx context.Context,
    repo UserResolver,
    identity *VerifiedIdentity,
) (*models.User, error)
```

Resolution policy (provider-agnostic):

1. **Subject lookup** — try `FindByClerkID(subject)` against the
   user repo. (Field name is `clerk_user_id` for historical reasons;
   when v0.11.0 OIDC lands we'll either share the field across
   providers or rename to a generic `external_subject`.)
2. **Email JIT link** — if subject misses, try `FindByEmail(email)`.
   If found, persist the subject onto the user record so subsequent
   requests take the fast path.
3. **Otherwise** — return `ErrUserNotAuthorized`. We never
   auto-create users; admins pre-provision deliberately.

## Auth pipeline (in middleware order)

```
1. Authorization: Bearer <token>
   ├─ token starts with "trve_"  → API key  (APIKeyService.Validate)
   └─ otherwise                  → IdentityVerifier.VerifyToken
                                    → ResolveUserByVerifiedIdentity
2. ?token=<jwt>                  → IdentityVerifier (SSE/EventSource fallback)
3. X-User-ID: <guid>             → legacy identity assertion
4. ?user_id=<guid>               → legacy, EventSource fallback
5. (none)                        → unauthenticated; route policy decides
```

A request with both `Authorization: Bearer …` and `X-User-ID` is
treated as Bearer-authenticated; the legacy header is ignored when
a Bearer is present.

## Adding a new mode (template)

When you add OIDC or proxy support, the diff is:

1. New file in `internal/auth/` implementing `IdentityVerifier`.
2. New env-var read in `cmd/server/main.go`. The env var is the
   soft-switch — its presence activates the mode.
3. Pass the new verifier to `middleware.NewAuthMiddleware`. (Today
   the middleware takes one verifier; if multiple modes need to be
   active simultaneously, change to a chain.)
4. Configure the SPA where applicable (Clerk needs the publishable
   key flowed via `/api/config/system`; OIDC needs the
   authorization endpoint URL; proxy mode is server-only).
5. Document the env vars in
   [`udoc/docs/`](../../udoc/docs/) (admin-facing) and update this
   page (developer-facing).

The `ResolveUserByVerifiedIdentity` function does not need to
change — all it cares about is `(Subject, Email)`.

## Enterprise self-host considerations

The product is shipped as container images and self-hosted by the
customer. Three deployment postures cover most of the market:

- **Small team / homelab** — Clerk works out of the box. Customer
  signs up at Clerk, sets two env vars, done.
- **Mid-market with IdP** — generic OIDC. Customer points the
  dashboard at their existing Okta / Entra / Keycloak tenant. No
  third-party domain in the credential path.
- **Zero-trust / regulated** — reverse-proxy mode. The customer's
  gateway (oauth2-proxy, Cloudflare Access, Pomerium, Tailscale TS
  Authentication) authenticates and stamps an `X-Auth-Request-Email`
  header. The dashboard trusts the header only when the request
  comes from a configured trusted CIDR.

Per-deployment licensing for Clerk / Okta / etc. is the customer's
bill. The dashboard doesn't proxy or share auth provider accounts.

## Files of interest

- `server-go/internal/auth/verifier.go` — interface + resolver.
- `server-go/internal/auth/clerk.go` — Clerk implementation (v0.10).
- `server-go/internal/middleware/auth.go` — pipeline.
- `server-go/internal/repository/user_repository.go` — `FindByClerkID`,
  `FindByEmail`, `SetClerkID`.
- `server-go/internal/service/config_service.go` — flows the
  publishable key to `/api/config/system`.
- `client/src/auth/ClerkBootstrap.jsx` — soft-switch at the top of
  the React tree.
- `client/src/auth/ClerkAuthGate.jsx` — `<SignedIn>` / `<SignedOut>`
  gating; first-sign-in JIT-link bridge.
- `client/src/auth/ClerkSessionBridge.jsx` — wires `getToken()` into
  `apiClient` so every outbound request carries a fresh JWT.
- `client/src/api/client.js` — `setTokenProvider` accepts a
  `() → Promise<string|null>` for any future verifier.
