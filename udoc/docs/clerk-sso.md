---
sidebar_position: 20
---

# Clerk Sign-In (Optional)

The dashboard supports browser sign-in via [Clerk](https://clerk.com)
as an optional auth backend. When enabled, users sign in through
Clerk's hosted UI (email + password, "Sign in with Google", "Sign in
with Apple", magic links, etc.); the bootstrap endpoint validates
Clerk's JWT, mints a dashboard session token (see
[Logging In](getting-started.md#under-the-hood-session-tokens-v0170)),
and the SPA carries that token thereafter. When disabled, the
bootstrap chain (URL `?user_id=…` when legacy GUID is allowed,
browser local storage, deployment-default user) is in effect — no
behavior change for existing deployments.

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
  authenticates users. The session-token system has a pluggable
  IdP registry (v0.17.0), so an additional verifier — generic OIDC,
  a trusted reverse-proxy header, etc. — can be added as a one-file
  addition without middleware changes.
- Your environment requires that credentials never flow through a
  third-party domain. Same answer: stay on API keys or the legacy
  GUID channel (gated by `auth.allow_legacy_guid`) until a
  non-Clerk IdP is wired up.

API keys are unaffected by Clerk. Whether Clerk is enabled or not,
the [dashboard-agent](dashboard-agent.md) CLI, [MCP](mcp.md) clients,
and any script using `Authorization: Bearer trve_…` continue to work
the same way.

## Supported sign-in methods

The dashboard supports the following Clerk-managed sign-in methods:

- **Email + password** (recommended starter) — Clerk hosts the
  signup, sign-in, password reset, and email verification flows
  end-to-end. **Zero third-party setup, zero additional cost.**
  Clerk sends the verification + reset emails from their own
  infrastructure on their free tier; you don't configure SMTP or
  buy a sending domain.
- **Email + one-time code** ("magic link" style) — Clerk emails a
  6-digit code or one-click link instead of using a password.
  Same zero-setup story as email + password; pick whichever UX
  you prefer.
- **Sign in with Google** *(optional)* — In Clerk's Development
  instance type, Clerk uses its own shared OAuth credentials so
  enabling Google is a single checkbox. In Production instance
  type you must create your own Google Cloud project and OAuth
  consent screen — straightforward but ~30 minutes of work.
- **Sign in with Apple** *(optional)* — Requires an
  [Apple Developer Account](https://developer.apple.com/programs/)
  ($99 USD per year) **even in Development mode.** Skip unless
  you specifically want it; Email + Google covers the same
  use case for free.

Other methods Clerk offers (SMS / phone, GitHub, Microsoft,
enterprise SSO via SAML, etc.) will likely also work — the JWT
validation surface is identical — but we don't formally support
them and won't troubleshoot method-specific issues. If you need
one, file an issue and we'll evaluate adding it to the supported
list.

### What the user sees

The sign-in widget that the dashboard renders is the standard
`<SignIn />` component from Clerk's React SDK with no method
overrides. **Whichever methods you enable in the Clerk dashboard
are the only ones that appear** — nothing to configure on the
dashboard side. If you want email-only, enable just email; the
sign-in screen will show only the email field with no social
buttons.

## Development vs Production instance — pick one

Clerk distinguishes two instance types per application. The
dashboard works with either, but the trade is real and most
self-hosters are best off **staying in Development mode**.

| | Development (`pk_test_…` / `sk_test_…`) | Production (`pk_live_…` / `sk_live_…`) |
|---|---|---|
| Cost | Free (no time limit) | Free up to 10k MAU; paid above |
| Sign-in widget hosted at | `*.clerk.accounts.dev` (Clerk's domain) | `accounts.your-domain.com` (your custom domain) |
| Dev banner shown to users | Yes — "this app is using development keys" | No |
| Monthly active user cap | 100 | 10,000 (free tier) |
| Google OAuth setup | Use Clerk's shared dev credentials (one click) | Bring your own Google Cloud project |
| Apple OAuth setup | Apple Developer Account required ($99/yr) — same as prod | Apple Developer Account + domain-association file |
| Right for | Homelab, personal, small-team self-host (≤100 users) | Public deployments, organizational sign-in |

**Recommendation:** stay in Development mode unless you have a
specific reason not to. The 100-MAU cap is plenty for personal /
small-team use, and it spares you the Google Cloud + custom-domain
setup work. The "development keys" banner is the only real
downside and most users learn to ignore it. You can always switch
to a Production instance later — you create a separate instance
under the same Clerk application, your existing user records and
configuration carry over.

## Admin setup

### 1. Create a Clerk account and application

1. Sign up at [clerk.com](https://clerk.com). The free tier is
   sufficient.
2. Click **Create application**. Name it something like "TRVE
   Dashboard". The new application starts in Development mode by
   default.
3. On the "Choose how your users will sign in" screen, enable
   **Email address** at minimum. The dashboard uses email as the
   JIT-link identifier — see
   [user mapping](#how-clerk-identities-map-to-dashboard-users)
   below — so it must be on. Then pick a **first-factor strategy**
   (Clerk asks for one of):
   - **Password** — most familiar UX; Clerk hosts password reset.
   - **Email code / link** — no password to remember; Clerk emails
     a one-time code or click-link on each sign-in.
   Either works fine. Pick what you prefer.
4. *(Optional)* enable social methods if you want them. Each is a
   single checkbox in Clerk's wizard:
   - **Google** — free in Development mode (shared OAuth creds);
     in Production mode you'll do a Google Cloud OAuth setup.
   - **Apple** — requires an Apple Developer Account ($99/yr)
     even in Development. Skip unless you specifically want it.
5. The wizard will produce your two keys at the end. **Don't
   close that page yet** — you'll copy them in step 2.

### 2. Copy the publishable + secret keys

From the Clerk dashboard, **Configure → API Keys**:

- **Publishable key** — starts with `pk_test_` (Development) or
  `pk_live_` (Production). Safe to expose in browser code; the
  dashboard SPA reads it via the dashboard server's
  `/api/config/system` endpoint.
- **Secret key** — starts with `sk_test_` or `sk_live_`. Server-only;
  treat like a password.

### 3. Set the env vars on the dashboard server

```sh
export CLERK_PUBLISHABLE_KEY="pk_test_…"
export CLERK_SECRET_KEY="sk_test_…"
```

How you make these persist depends on your deployment:

| Deployment style | Where to put them |
|---|---|
| `docker-compose.deploy.yml` | A `.env` file next to the compose file. See [.env.example](https://github.com/trv-enterprises/trve-dashboard/blob/main/.env.example) for the full list of optional env vars. |
| Native dev (`go run` / `./bin/server`) | `~/.zshrc` or `~/.bashrc`, then `source` it. |
| Kubernetes / Nomad | Your orchestrator's secret manager. |
| Ansible | Group/host vars or vault. |

Both must be set for Clerk to be useful end-to-end. The server
checks `CLERK_SECRET_KEY` at startup; its presence flips the soft
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

### 5. Pre-provision your dashboard user

Before signing in for the first time, **create a User record in
Manage Mode → Users with an email that matches the email on your
Clerk account**. This is what the JIT-link policy uses to connect
your Clerk identity to a dashboard user — without a matching email,
your first sign-in returns "Account not authorized for this
deployment."

Most homelab self-hosters can edit the seeded `Tom Viviano` user (or
similar) in place rather than creating a new one. After the first
sign-in, the dashboard saves your Clerk user ID to that record
automatically and email matching is no longer used; future
sign-ins resolve via the (more stable) Clerk user ID.

## What you (probably) don't need to set up

- **Domains page in Clerk dashboard.** Development instances pre-allow
  `localhost:*` and `127.0.0.1:*` automatically. You only configure
  Domains when switching to a Production instance with your own
  hostname.
- **Webhooks.** The dashboard doesn't consume Clerk webhooks. (We
  use the JIT-link policy to react to first sign-ins instead.)
- **Custom JWT templates.** Clerk's default session JWT works as-is.
  We fetch the user's email via the Clerk Users API on first
  sign-in, so we don't need email embedded in the JWT.
- **Sessions config.** Default 60-second session token works well.
  Customize only if you have a specific reason (e.g., you want
  MFA-on-every-sign-in for regulated industries).
- **Account Portal.** Clerk's hosted "manage your account" pages
  work but the dashboard doesn't link to them today. Treat as
  Clerk-side feature; users discover it via Clerk's UI.

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
- The legacy `X-User-ID` header is **off by default** on new
  deployments (v0.17.6+). It is only accepted server-side when
  `auth.allow_legacy_guid` is true (set via `config.yaml` or the
  `DASHBOARD_AUTH_ALLOW_LEGACY_GUID` env var). The dev-mode user
  switcher is also gated to `import.meta.env.DEV` bundles, so
  production SPAs never send it regardless. Keep it off in prod;
  enable only for migration, dev, or single-user homelabs that
  understand the trade-off.

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
- [Logging In & User Selection](getting-started.md) — the
  bootstrap chain that's still active when Clerk is disabled, plus
  the session-token model that sits underneath every auth path.
- [User Management](user-management.md) — Manage Mode user CRUD.
