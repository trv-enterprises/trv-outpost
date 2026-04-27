---
sidebar_position: 20
---

# Clerk Sign-In (Optional)

The dashboard supports browser sign-in via [Clerk](https://clerk.com)
as an optional auth backend. When enabled, users sign in through
Clerk's hosted UI (email + password, "Sign in with Google", "Sign in
with Apple", magic links, etc.) and the dashboard validates Clerk's
session JWTs on every request. When disabled, the v0.9.x bootstrap
chain (URL `?user_id=…`, browser local storage, deployment-default
user) is in effect — no behavior change for existing deployments.

This page covers admin setup, the user experience, and how Clerk
identities map to dashboard users.

## When to enable Clerk

Enable Clerk when:

- You want real password-based or social sign-in for browser users.
- You want to require sign-in (not "anyone with the URL is the
  default user").
- You want session management, MFA, or magic-link UX without
  building any of it.

Skip Clerk when:

- You're running a single-user homelab and the
  `default_browser_user_guid` setting is enough.
- Your deployment is behind a VPN / zero-trust gateway that already
  authenticates users (in v0.12+ this becomes a first-class auth
  mode; for now use `X-User-ID`).
- Your environment requires that credentials never flow through a
  third-party domain — use the planned generic OIDC mode (v0.11) or
  reverse-proxy mode (v0.12) when those land.

API keys are unaffected by Clerk. Whether Clerk is enabled or not,
the [dashboard-agent](dashboard-agent.md) CLI, [MCP](mcp.md) clients,
and any script using `Authorization: Bearer trve_…` continue to work
the same way.

## Admin setup

### 1. Create a Clerk application

Sign up at [clerk.com](https://clerk.com) and create a new application.
Enable the sign-in methods you want under **User & Authentication →
Email, Phone, Username** and **Social Connections**. Email + Google +
Apple is a sensible default; the dashboard doesn't care which
methods you enable, the validation surface is identical.

Under **Domains**, add the dashboard's URL(s) — `localhost:5173` for
local dev, plus your production hostname.

### 2. Get the keys

From the Clerk dashboard's **API Keys** page, copy:

- **Publishable key** (starts with `pk_test_` or `pk_live_`) — safe
  to expose in browser code.
- **Secret key** (starts with `sk_test_` or `sk_live_`) — server-only;
  treat like a password.

### 3. Set the env vars on the dashboard server

```sh
export CLERK_SECRET_KEY="sk_test_…"
export CLERK_PUBLISHABLE_KEY="pk_test_…"
```

Add these to whatever your deployment uses for environment
configuration — `~/.zshrc` for local dev, the homelab Ansible
playbook's secrets file for production, the orchestrator's secret
manager for k8s, etc.

Both must be set for Clerk to be useful end-to-end. The server
checks `CLERK_SECRET_KEY` at startup; presence flips the soft
switch. `CLERK_PUBLISHABLE_KEY` flows through `/api/config/system`
to the SPA so the React Clerk SDK can initialize without its own
env var.

### 4. Restart the server

On startup the server prints one of:

```
✓ Clerk identity verifier enabled (CLERK_SECRET_KEY detected)
```

…or:

```
· Clerk identity verifier disabled (CLERK_SECRET_KEY not set)
```

If you see the "enabled" line but the SPA still shows the old
non-Clerk login flow, check that `CLERK_PUBLISHABLE_KEY` is also
set — the SPA needs that one too.

## What users see

On a Clerk-enabled deployment, hitting the dashboard URL renders
Clerk's sign-in widget instead of the dashboard. Signing in via any
configured method (email, Google, Apple, etc.) lands the user in
the normal dashboard view. Sign-out is available via the avatar
menu's account section.

Sessions are managed by Clerk: the SPA fetches a short-lived JWT
(default 60s) on demand, attaches it to every API call as
`Authorization: Bearer <jwt>`, and silently refreshes when needed.
There's no refresh-token handling for the dashboard to do; Clerk's
SDK handles it via the session cookie on Clerk's domain.

## How Clerk identities map to dashboard users

Dashboard users are pre-provisioned in **Manage Mode → Users**.
Clerk does **not** auto-create accounts — sign-ins from a Clerk
identity that doesn't match any dashboard user land on a
"Account not authorized for this deployment" error.

The matching policy is hybrid:

1. **First sign-in: match by email.** When a Clerk identity signs in
   for the first time, the server verifies the JWT, fetches the
   user's primary email from Clerk's Users API, and looks for a
   matching email on the dashboard's User records. If one is found,
   the Clerk subject (e.g. `user_2abc…`) is persisted onto that
   user's `clerk_user_id` field. This is the **JIT-link**.
2. **Subsequent sign-ins: match by Clerk ID.** Once `clerk_user_id`
   is populated, every subsequent sign-in resolves via that field
   directly. An email change in Clerk doesn't break the link, and
   the lookup is one indexed query.

### Pre-provisioning a user for Clerk sign-in

1. **Manage Mode → Users → Create**.
2. Fill in name and **email** — match the email the user signs in
   with on Clerk. (For Google sign-in, this is their Google account
   email; for Apple, the Apple ID email or relay if they used "Hide
   My Email"; for email/password, whatever they typed.)
3. Set capabilities (View / Design / Manage).
4. Save.
5. Have the user sign in via Clerk. The first request JIT-links and
   they're in.

### Manual Clerk ID override

The user edit form has a **Clerk user ID (advanced)** field. Use
it when:

- The JIT-link auto-populated the wrong Clerk identity (rare; only
  happens if two dashboard users share an email).
- You want to pre-link before the first sign-in — paste the user's
  Clerk ID from the Clerk dashboard.
- You need to break a link (e.g. user changed email and the JIT
  match no longer works) — clear the field and the user re-links on
  next sign-in.

The field shows the current value (auto-populated on first sign-in)
and is editable.

## Security notes

- Clerk JWTs are short-lived (default 60s). Revoking a Clerk session
  invalidates new tokens within seconds.
- The session cookie that Clerk uses to mint JWTs lives on Clerk's
  domain (HttpOnly, secure). The dashboard never sees or stores it.
- Token validation uses Clerk's published JWKS (signature + `iss` +
  `exp`). The Clerk SDK handles JWKS fetch and caching; key
  rotations are picked up automatically.
- Clerk integration is mutually-augmenting with API keys: a request
  with `Authorization: Bearer trve_…` is dispatched to the API-key
  validator; anything else with a `Bearer` prefix is dispatched to
  the Clerk verifier. Both can coexist on the same deployment.
- The legacy `X-User-ID` header still works under Clerk mode for
  the dev-mode user switcher — it's gated to `import.meta.env.DEV`
  bundles so production never honors it via the SPA. Server-side
  it's still accepted as a fallback path for migration; admins can
  disable it once everyone has migrated.

## Troubleshooting

**"Account not authorized for this deployment" after sign-in.** The
Clerk identity verified, but no dashboard user matched. Check that
a User record exists with the matching email, or set the
`clerk_user_id` field manually from the user edit form.

**SPA still shows the old login flow even with `CLERK_SECRET_KEY` set.**
Confirm `CLERK_PUBLISHABLE_KEY` is also set and the server printed
the "enabled" line at startup. The SPA reads the publishable key
from `/api/config/system` — if you `curl http://localhost:3001/api/config/system`
you should see `clerk_publishable_key` in the response.

**JWT validation 401s with no matching error.** Make sure the server
process inherited the env vars (`docker-compose` services need them
in the `environment:` block; `systemd` units need them in the unit
file or via `EnvironmentFile=`). Logs include the verifier failure
reason when the `LOG_LEVEL` is set to `debug`.

## See also

- [API Keys](api-keys.md) — per-user tokens for non-browser callers,
  unaffected by Clerk.
- [Logging In & User Selection](getting-started.md) — the v0.9.x
  bootstrap chain that's still active when Clerk is disabled.
- [User Management](user-management.md) — Manage Mode user CRUD.
