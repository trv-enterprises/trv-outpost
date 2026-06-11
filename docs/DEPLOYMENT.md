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

```bash
git clone https://github.com/trv-enterprises/trv-outpost
cd trv-outpost

# Optional: copy and edit .env to set DOMAIN, IMAGE_TAG,
# ASSISTANT_ANTHROPIC_API_KEY (for AI; falls back to ANTHROPIC_API_KEY),
# CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY (for sign-in), or non-default ports.
# The defaults work for `http://localhost` evaluation as-is.
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
