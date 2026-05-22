# Quick Start

The fastest path to a running dashboard depends on what you want to do.

## Just try it out (Docker)

Pull the published container images and run a complete stack
(MongoDB + Go backend + React UI) with one compose command. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full procedure —
including which compose file to use, env vars, and how to wire the
Caddy reverse proxy.

## Develop locally

Run the Go backend and the Vite dev server side by side. See the
**Development Setup** section in [`CLAUDE.md`](CLAUDE.md#development-setup)
for prerequisites (Go 1.26+, Node 18+, Docker for MongoDB) and the
exact commands.

The short version:

```bash
# Terminal 1 — MongoDB
docker compose up -d mongodb

# Terminal 2 — Go backend (port 3001)
cd server-go && go build -o bin/server cmd/server/main.go && ./bin/server

# Terminal 3 — React frontend (port 5173)
cd client && npm install && npm run dev
```

Then visit <http://localhost:5173>.

## Build from source (Docker images)

If you want to reproduce the published images yourself —
[`BUILDING.md`](BUILDING.md) walks through prereqs, single-platform
and multi-arch builds, and how to verify a local build matches a
published image by SHA.

## What's next

- Read the architecture landing page at
  [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md).
- Explore the API at <http://localhost:3001/swagger/index.html> once
  the server is running.
- The test plan at [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md) is a good
  feature tour even if you don't intend to run every checklist item.
