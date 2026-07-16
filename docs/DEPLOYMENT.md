# Dashboard Deployment Guide

There are two ways to deploy the dashboard with Docker Compose:

- **Quick start** — pull pre-built images from `ghcr.io`. No source
  build, no toolchain. Right for evaluators and for production
  deploys that don't need code changes. **Verified end-to-end on
  macOS Docker Desktop and on the project maintainer's homelab
  (Ubuntu, Docker Compose v2).**
- **Build from source** — `docker-compose.prod.yml` builds the
  client and server images locally from `./client/Dockerfile` and
  `./server-go/Dockerfile`. Right when you've forked, customized,
  or want to deploy off `main` between tagged releases.

## Quick Start (deploy from published images)

> **You must configure a login before this is usable.** The deploy
> compose ships secure-by-default, which means *no* credential channel is
> enabled out of the box. Read [No login configured](#no-login-configured)
> first — a stack started with pure defaults comes up healthy and serves
> the app, but cannot be signed into.

```bash
git clone https://github.com/trv-enterprises/trv-outpost
cd trv-outpost

# Copy and edit .env. At minimum, configure a login (Clerk, or legacy
# GUID for localhost-only evaluation) — see "No login configured" below.
# Also used for DOMAIN, IMAGE_TAG, ASSISTANT_ANTHROPIC_API_KEY (for AI;
# falls back to ANTHROPIC_API_KEY), and non-default ports.
cp .env.example .env

docker compose -f docker-compose.deploy.yml up -d
docker compose -f docker-compose.deploy.yml ps
```

Your dashboard will be available at:
- `http://localhost` (defaults — port 80 + self-signed cert on 443)
- `https://your-domain.com` (set `DOMAIN=your-domain.com` in `.env`
  with public DNS pointing at the host; Caddy requests a Let's
  Encrypt cert automatically on first start)

Pin a specific release with `IMAGE_TAG=v0.10.0` in `.env`; otherwise
`latest` is used. Available tags:
<https://github.com/trv-enterprises/trv-outpost/releases>.

## No login configured

`docker-compose.deploy.yml` sets `DASHBOARD_AUTH_ALLOW_LEGACY_GUID=false`
and leaves Clerk unset. Those are each individually correct defaults, but
together they leave the server with **no credential channel at all**:

- **Clerk unset** → no browser sign-in.
- **Legacy GUID off** → `?user_id=` / `X-User-ID` are not honored.
- **API keys** → can't bootstrap you in; minting one needs an admin
  session you have no way to obtain.

The stack still comes up fully healthy and serves the SPA, which makes
this look like a bug rather than a config gap. The symptoms:

- `GET /api/auth/session` returns `401`
- the UI reports **"login not configured"**
- `docker compose -f docker-compose.deploy.yml logs server` shows both
  `Clerk identity verifier disabled` and `Legacy GUID auth disabled`

Pick one of the two options below.

### Option 1 — Clerk (recommended for anything reachable)

Set both keys in `.env` and restart. See
[Clerk SSO setup](../udoc/docs/clerk-sso.md).

```bash
CLERK_SECRET_KEY=sk_test_…
CLERK_PUBLISHABLE_KEY=pk_test_…
```

### Option 2 — legacy GUID (localhost evaluation only)

Layer the `docker-compose.localhost.yml` overlay onto the deploy file:

```bash
docker compose -f docker-compose.deploy.yml \
               -f docker-compose.localhost.yml up -d
```

Then browse to `http://localhost/?user_id=<guid>`. On a fresh database
the server seeds a default admin user; its GUID is in the server logs on
first boot, or read it from the `users` collection.

> **This is identity assertion, not authentication.** It trusts *any*
> GUID presented to it — anyone who can reach the port becomes any user
> they name, including an admin.

The overlay is ~10 lines and does exactly two things, which ship welded
together on purpose:

1. sets `DASHBOARD_AUTH_ALLOW_LEGACY_GUID=true` — opens the door
2. rebinds Caddy to `127.0.0.1` — confines it to your machine

**Neither is safe without the other.** The deploy file publishes Caddy on
`0.0.0.0`, so doing (1) alone would expose an open door to your whole
LAN/tailnet. Don't split them apart, and don't layer this overlay onto a
deployment anyone else can reach — use Clerk there instead.

The `ports: !override` tag in the overlay is load-bearing: without it
Compose *merges* the port lists and the original `0.0.0.0` bindings
survive alongside the loopback ones, silently defeating the confinement.

---

## Migrating from the dev compose (existing MongoDB data)

The repo's two compose files declare **different, non-interchangeable
volumes**, and the names differ only by a hyphen vs an underscore:

| File | Volume declared | Actual Docker volume |
|------|-----------------|----------------------|
| `docker-compose.yml` (local dev) | `mongodb-data` | `dashboard_mongodb-data` |
| `docker-compose.deploy.yml` | `mongodb_data` | `dashboard_mongodb_data` |

(Compose prefixes the project name — the directory, normally `dashboard`.)

So running the deploy compose on a box that has been doing local dev
comes up against a **brand-new empty database**, sitting next to your
real one. Nothing is lost, but it presents as total data loss. Check
what you actually have:

```bash
docker volume ls | grep mongodb
```

To point the deploy stack at your existing dev data, adopt the volume
with a `docker-compose.override.yml`:

```yaml
services:
  mongodb:
    volumes:
      - dashboard_mongodb-data:/data/db

volumes:
  dashboard_mongodb-data:
    external: true
```

`external: true` means Compose expects the volume to already exist and
will error rather than silently create an empty one — which is what you
want here. Back up before switching (see [Backup & Restore](#backup--restore)).

---

## Build from source

```bash
# 1. Copy and configure environment
cp .env.example .env
# Edit .env with your ASSISTANT_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) and DOMAIN

# 2. Build and start all services
docker compose -f docker-compose.prod.yml up -d --build

# 3. Check status
docker compose -f docker-compose.prod.yml ps
```

Same URLs as the quick start path. Re-run with `--build` after any
local code change.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     CADDY (Port 80/443)                          │
│  - Serves React static files                                     │
│  - Reverse proxies /api/* to Go backend                         │
│  - Automatic HTTPS via Let's Encrypt                            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GO SERVER (Port 3001)                         │
│  - REST API, WebSocket, AI sessions                             │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                        ┌──────────────┐
                        │   MongoDB    │
                        └──────────────┘
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `ASSISTANT_ANTHROPIC_API_KEY` | API key for AI features (**preferred**). Falls back to `ANTHROPIC_API_KEY`. Preferred for local dev so you can keep `ANTHROPIC_API_KEY` pointed at Claude Code / other tooling and the server at a different key. |
| `ANTHROPIC_API_KEY` | Legacy fallback for the AI API key, used when `ASSISTANT_ANTHROPIC_API_KEY` is unset. |
| `DOMAIN` | Domain for HTTPS (e.g., `dashboard.example.com` or `localhost`) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_SERVER_PORT` | `3001` | Go server port |
| `DASHBOARD_SERVER_MODE` | `release` | Gin mode (release/debug) |
| `DASHBOARD_MONGODB_URI` | `mongodb://mongodb:27017` | MongoDB connection string |
| `DASHBOARD_MONGODB_DATABASE` | `dashboard` | Database name |
| `CADDY_TLS_DIRECTIVE` | _(empty)_ | TLS directive injected into the bundled Caddyfile, for HTTPS cert sources other than public ACME. Empty = today's behavior. E.g. `tls { get_certificate tailscale }` for a Tailscale `.ts.net` cert, or `tls internal` for an internal-CA hostname cert. See [Internal / Tailscale HTTPS](#internal--tailscale-https). |
| `DASHBOARD_AUTH_COOKIE_SECURE` | `false` | Set `true` when serving over HTTPS so the refresh cookie carries the `Secure` flag. Must match the scheme: a `Secure` cookie is dropped on a plain-HTTP origin, and an HTTP deployment needs this `false`. |
| `DASHBOARD_AUTH_ALLOW_LEGACY_GUID` | `false` | Enables the `?user_id=` / `X-User-ID` identity channel. **Trusts any GUID presented to it** — localhost evaluation only, and pair it with a `127.0.0.1` port binding. With Clerk also unset, `false` means no login exists at all: see [No login configured](#no-login-configured). |
| `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` | _(empty)_ | Set **both** to enable Clerk browser sign-in. See [No login configured](#no-login-configured). |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Override the published host ports if those are taken. **Caveat:** Caddy builds its HTTP→HTTPS redirect from `DOMAIN` and doesn't know about the remap, so `http://localhost:8080/` redirects to `https://localhost/` (bare 443) and goes nowhere. Browse directly to the HTTPS port instead. |

---

## HTTPS Configuration

> **Auth, CORS, cookies & origins:** the behavior that matters when you
> change scheme/origin (HTTP→HTTPS, IP→hostname, single- vs split-origin)
> — CORS defaults, the `SameSite`/`Secure` refresh-cookie rules, the
> `ws://`→`wss://` handling, Clerk's separate origin + secure-context
> requirements, and a step-by-step `http://<ip>` → `https://<host>`
> migration checklist — is documented in
> [Origins, CORS, cookies & HTTPS](architecture/auth-modes.md#origins-cors-cookies--https).
> **Key gotcha:** keep the SPA and `/api` on **one origin** (Caddy proxies
> `/api`); a cross-origin API base silently breaks the `SameSite=Lax`
> refresh cookie even with permissive CORS.

### Public Domain (Automatic Let's Encrypt)

1. Point your DNS to your server's IP
2. Open ports 80 and 443 on your firewall
3. Set `DOMAIN=your-domain.com` in `.env`
4. Start the containers - Caddy will automatically obtain certificates

### Local/Private Deployment

Set `DOMAIN=localhost` - Caddy will use a self-signed certificate.

### Internal / Tailscale HTTPS

For an internal deployment reached by **hostname** (not a public domain, so
public ACME can't validate it), set `CADDY_TLS_DIRECTIVE` to choose the cert
source. Empty by default; the value is injected verbatim into the Caddyfile.

- **Tailscale `.ts.net`** — a publicly-trusted cert from the local `tailscaled`,
  **no browser warning**, no ACME challenge. Needs `tailscaled` reachable from
  the Caddy container (mount `/var/run/tailscale/tailscaled.sock`) and "HTTPS
  Certificates" enabled on the tailnet (admin console → DNS).
  ```
  DOMAIN=<node>.<tailnet>.ts.net
  CADDY_TLS_DIRECTIVE=tls { get_certificate tailscale }
  DASHBOARD_AUTH_COOKIE_SECURE=true
  ```
- **Internal CA for an intranet hostname** (one-time per-device root-CA trust):
  ```
  DOMAIN=dash.lan            # add to /etc/hosts or local DNS, pointing at the host
  CADDY_TLS_DIRECTIVE=tls internal
  DASHBOARD_AUTH_COOKIE_SECURE=true
  ```

> **Do not use a bare-IP `DOMAIN` for HTTPS.** Caddy issues an IP-SAN cert that
> Chromium/Firefox reject at the handshake (only macOS native TLS tolerates it),
> and Clerk can't establish a cookie domain on an IP. Always use a hostname.

When you switch to HTTPS, set `DASHBOARD_AUTH_COOKIE_SECURE=true` (a `Secure`
refresh cookie is dropped over plain HTTP).

### Custom Certificates

Mount your certificates into the Caddy container:

```yaml
# In docker-compose.prod.yml
caddy:
  volumes:
    - ./certs:/etc/caddy/certs:ro
```

Update Caddyfile:
```caddyfile
your-domain.com {
    tls /etc/caddy/certs/cert.pem /etc/caddy/certs/key.pem
    # ... rest of config
}
```

---

## Manual Deployment (Without Docker)

### 1. Build the Go Server

```bash
cd server-go
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o bin/server cmd/server/main.go
```

### 2. Build the React Client

```bash
cd client
npm ci
npm run build
# Output: client/dist/
```

### 3. Deploy Files

Copy to your server:
- `server-go/bin/server` → `/opt/dashboard/server`
- `server-go/config/` → `/opt/dashboard/config/`
- `client/dist/` → `/var/www/dashboard/`

### 4. Configure Systemd Service

Create `/etc/systemd/system/dashboard.service`:

```ini
[Unit]
Description=Dashboard API Server
After=network.target mongodb.service

[Service]
Type=simple
User=dashboard
WorkingDirectory=/opt/dashboard
ExecStart=/opt/dashboard/server
Restart=always
Environment=DASHBOARD_SERVER_MODE=release
Environment=DASHBOARD_MONGODB_URI=mongodb://localhost:27017

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable dashboard
sudo systemctl start dashboard
```

### 5. Configure Caddy (Manual Install)

Install Caddy: https://caddyserver.com/docs/install

Create `/etc/caddy/Caddyfile`:
```caddyfile
your-domain.com {
    root * /var/www/dashboard
    file_server

    handle /api/* {
        reverse_proxy localhost:3001
    }

    handle /health {
        reverse_proxy localhost:3001
    }

    try_files {path} /index.html
    encode gzip
}
```

```bash
sudo systemctl restart caddy
```

---

## Updating

```bash
# Pull latest code
git pull

# Rebuild and restart
docker compose -f docker-compose.prod.yml up -d --build
```

### Database migrations

Database migrations run automatically at server startup via
`database.RunMigrations`. Each migration is tracked in the
`migrations` collection and is idempotent — safe to re-run. In
particular, the first startup after upgrading to a build that
introduced case-insensitive collation will rebuild each affected
collection (copy + drop + rename under the hood). This is normal
and takes a few seconds on a homelab-scale deployment. Back up the
database first if you're worried. See
[`docs/architecture/database.md`](architecture/database.md) for
migration details.

---

## Backup & Restore

### Backup MongoDB

```bash
# Create backup
docker compose -f docker-compose.prod.yml exec mongodb mongodump --out /data/backup

# Copy from container
docker cp $(docker compose -f docker-compose.prod.yml ps -q mongodb):/data/backup ./backup
```

### Restore MongoDB

```bash
# Copy to container
docker cp ./backup $(docker compose -f docker-compose.prod.yml ps -q mongodb):/data/backup

# Restore
docker compose -f docker-compose.prod.yml exec mongodb mongorestore /data/backup
```

---

## Troubleshooting

### Check Logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Specific service
docker compose -f docker-compose.prod.yml logs -f server
docker compose -f docker-compose.prod.yml logs -f caddy
```

### Health Checks

```bash
# API health
curl http://localhost:3001/health

# Check container health status
docker compose -f docker-compose.prod.yml ps
```

### Certificate Issues

If Caddy fails to obtain certificates:
1. Verify DNS points to your server
2. Check ports 80/443 are open
3. View Caddy logs: `docker compose logs caddy`

### Database Connection Issues

```bash
# Test MongoDB
docker compose -f docker-compose.prod.yml exec mongodb mongosh --eval "db.runCommand('ping')"

```

---

## Security Recommendations

1. **Firewall**: Only expose ports 80, 443 publicly
2. **MongoDB**: Not exposed externally by default (good)
3. **Legacy GUID auth**: Keep `DASHBOARD_AUTH_ALLOW_LEGACY_GUID=false` on
   anything reachable — it trusts any GUID presented to it. If you enable
   it for local evaluation, bind the Caddy ports to `127.0.0.1` so the
   open door isn't reachable from your LAN/tailnet. See
   [No login configured](#no-login-configured).
4. **API Key**: Never commit `.env` to version control
5. **Updates**: Regularly update base images for security patches

---

## Resource Requirements

Minimum recommended:
- **CPU**: 2 cores
- **RAM**: 2GB
- **Disk**: 20GB (includes MongoDB data)

For production with multiple users:
- **CPU**: 4+ cores
- **RAM**: 4-8GB
- **Disk**: 50GB+ SSD
