# TRV Outpost

A full-stack application for creating, managing, and viewing dynamic
data visualization dashboards with AI-powered component generation,
real-time streaming, and smart device control, built by a technologist
that has been building complex system for over 40 years. This was my first
large development using Claude Code to assist me in the development, 
testing, and documentation. 

The dashboards have visualizations, controls and displays. Controls and displays are
dependant on specific technologies in my homelab. These areas will be more generalized
in the future. The component types can be turned off. The visulization layer on
the otherhand was the primary motivation to this repo and should be able to be used
in most any environment.

## What it does

- **Dashboards** with a 32-px cell grid, configurable column count,
  and four fit modes (Actual size / Fit to window / Fit to width /
  Stretch to fill)
- **Charts, controls, and displays** composed into dashboards. Chart
  code is stored in the database and evaluated at runtime — no
  build-and-deploy cycle for new components
- **AI Component Builder** for generating chart components via
  Anthropic Claude with SSE streaming
- **Real-time data** over SSE from 10 built-in connection types:
  SQL, REST API, CSV, WebSocket (read-only or bidirectional),
  TCP, MQTT, Prometheus, EdgeLake, ts-store, Frigate NVR
- **Type availability gating** — admins enable / disable connection
  and component types (and bundled integrations like Frigate or
  Weather) per deployment from the Settings UI, propagating to
  pickers, the AI agent, and the MCP catalog
- **Namespaces** — every connection, component, and dashboard
  belongs to a namespace; uniqueness is `(namespace, name)` so two
  namespaces can each have a dashboard called `Home` without
  colliding. The active namespace lives in the header (drives
  defaults for new records); list pages multi-select-filter by
  namespace
- **Per-user namespace access** — restrict a user to specific
  namespaces and they see only that content, and can never read data
  through a connection they weren't granted (enforced server-side).
  Users are unrestricted by default. A dashboard that depends on
  something out of reach still opens — only the affected panels show
  an error, and the out-of-reach names never reach the browser
- **Dashboard export / import** — bundle one or more dashboards plus
  their referenced components and connections into a single JSON
  file (including the connections a connection-swap variable can
  select, bundled as soft dependencies with warnings when missing).
  Re-import to update in place (preserved IDs, same target
  namespace) or to copy into a different namespace (re-minted IDs).
  Import preflight classifies every object as identical / conflict
  / new / blocked and surfaces per-object diffs for review before
  any writes
- **Dashboard variables** — one dashboard serves many hosts or sites:
  a connection-swap dropdown repoints every panel to another
  connection, a filter value substitutes into each query, and a
  **time-range picker** (relative presets or absolute from/to) drives
  every time-series panel — including live streaming charts, which
  re-backfill to the picked window and hold that span. Connection
  types that downsample server-side (ts-store, Prometheus) get a
  **step** control with presets sized to the window
- **Mobile view** — on a phone-sized screen the dashboard viewer
  stacks every panel full-width in a single scrolling column (reading
  order), so any dashboard is legible on mobile with no re-authoring;
  tap any chart for an edge-to-edge fullscreen view (rotate to
  landscape for wide charts), and streaming charts keep updating live.
  Served from the same URL as desktop — the layout switches on viewport
  width, and the mobile page is code-split so desktop never loads it
- **MQTT retained-state replay** so panels repopulate instantly on
  dashboard switches instead of waiting for the next publish
- **Shared tag filtering** across connections, components, and
  dashboards with autocomplete and case-insensitive collation
- **Smart device control** (Zigbee, Caséta) through bidirectional
  MQTT and WebSocket connections, with a capability-based device
  type system
- **Frigate NVR integration** with camera snapshots, live streams,
  and a thumbnail grid of unreviewed alerts
- **Role-based user management** (Admin, Designer, Support)
- **MCP server** — integrated SSE endpoint at `/mcp/sse` so external
  AI clients like Claude Desktop (via [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy))
  can introspect connections, create components, and build whole
  dashboards via a single tool surface
- **Dashboard Assistant** — an in-app chat agent that builds whole
  dashboards from a one-line natural-language prompt: it probes the
  connection, plans the layout, creates the components, and assembles
  the dashboard. The same capability is available to external agents
  through the MCP server. See [examples/dashboards](examples/dashboards/)
  for a walkthrough of a multi-panel Prometheus monitoring dashboard
  built from a single prompt, plus screenshots of the Assistant mid-edit
  and an AI-built Sankey.
- **Desktop app (macOS)** — an Electron build of the dashboard with a
  built-in **Claude Code sidebar** that launches the Claude Code CLI
  pre-wired to your dashboard's MCP server. It uses your existing Claude
  subscription (not a pay-as-you-go API key). See the
  [Desktop App guide](udoc/docs/getting-started.md#electron-desktop-app).

## High-level architecture

```
┌────────────────────────────────────────────────────┐  ┌──────────────────────┐
│            React frontend (Vite, :5173)            │  │  External AI agents  │
│       Carbon · ECharts · React Router              │  │  (Claude Desktop +   │
│  Design mode  │ View mode  │ Manage mode           │  │   other MCP clients  │
│  - Conns      │ - Viewer   │ - Users               │  │   via mcp-proxy)     │
│  - Components │ - Live data│ - Settings            │  │                      │
│  - Dashboards │ - Fit modes│ - Devices             │  │  inputs:             │
│  - AI Builder + Dashboard Assistant (chat)         │  │  agent-driven        │
│  - Component "Edit with AI"                        │  │  + deployment key    │
└────────────────────────┬───────────────────────────┘  └──────────┬───────────┘
                         │  REST · SSE · WebSocket                  │  MCP / SSE
                         ▼                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                Go backend (port 3001)                                       │
│                       Gin · Eclipse Paho · Anthropic SDK · Swaggo                           │
│  /api/connections  /api/components  /api/dashboards  /api/devices  /api/users               │
│  /api/tags  /api/ai/sessions  /api/frigate      /mcp/sse  /mcp/message   ...                │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                              ┌───────────────┼────────────────────────┐
                              ▼                                        ▼
                       ┌────────────┐                          ┌────────────────┐
                       │  MongoDB 7 │                          │  External      │
                       │            │                          │  connections   │
                       │ Dashboards │                          │  (SQL, REST,   │
                       │ Components │                          │  MQTT, ...)    │
                       │ Datasources│                          └────────────────┘
                       │ Users      │
                       │ Devices    │
                       └────────────┘
```

AI-assisted building runs server-side: the **Dashboard Assistant**
(in-app chat) and the in-editor **Component AI agent** call Anthropic
with a tool surface over `/api/ai/sessions`, while **external agents**
(Claude Desktop, etc.) reach the same component/dashboard tools through
the MCP endpoints. See [examples/dashboards](examples/dashboards/) for a
full end-to-end run.

For the full architecture — data model, streaming internals,
connection adapters, grid system, API reference, etc. — see the
**[architecture doc set](docs/architecture/ARCHITECTURE.md)**.

## Quick start

### Option 1 — Docker (try it without installing anything else)

If you have Docker, you can have the dashboard running in one
command. Pulls the published images from `ghcr.io`; no source build,
no language toolchains required.

```bash
git clone https://github.com/trv-enterprises/trv-outpost
cd trv-outpost
docker compose -f docker-compose.deploy.yml up -d
```

Open <http://localhost> (Caddy serves the SPA on port 80; the
self-signed HTTPS cert on 443 also works if you accept the warning).

To customize anything — pin a specific release, set an Anthropic key
to enable the AI Builder, enable Clerk sign-in, change ports — copy
`.env.example` to `.env` and edit. The defaults are tuned for "I want
to see the dashboard on my laptop right now."

#### Enabling HTTPS

The `caddy` service in the compose file **is** the client image
(`outpost-client`) — it bundles [Caddy](https://caddyserver.com/) + the
built SPA + a baked-in `Caddyfile`. There's no separate web server:
**Caddy serves the SPA and reverse-proxies the API on a single origin**
(it proxies `/api/*`, `/health`, `/swagger/*`, `/mcp/*`, `/docs` to the
Go server; everything else falls through to the SPA). That single-origin
design is why CORS and cross-site-cookie issues don't arise in this
topology — the browser only ever talks to one origin.

**HTTPS is controlled entirely by the `DOMAIN` env var** — Caddy keys
its automatic HTTPS off its site address, so this one value is the lever:

| `DOMAIN` | Result |
|---|---|
| `localhost` *(default)* | Serves HTTP on `:80`; a self-signed cert is also available on `:443` (accept the browser warning). No DNS/ACME. |
| `:80` | HTTP only, no TLS. |
| a **bare IP** (e.g. `192.168.1.50`) | **Not recommended — see below.** Caddy issues an internal-CA cert with an IP SAN; Chrome and Firefox reject the handshake for IP-address certs from a private CA, so the site is unreachable in real browsers even though macOS's native TLS (and `curl`) may accept it. Use a hostname instead. |
| a **hostname** (e.g. `dash.lan` or `dash.example.com`) | **HTTPS that browsers accept.** For an *internal* name, add it to `/etc/hosts` (or a local DNS server) pointing at the host's IP — Caddy issues an internal-CA cert for the **hostname** (trust Caddy's root CA once to drop the warning). For a *public* name with public DNS + reachable 80/443, Caddy gets a **Let's Encrypt** cert automatically (no warning). |

Set it in `.env`: `DOMAIN=dash.lan` (internal hostname via `/etc/hosts`
or local DNS) or `DOMAIN=dash.example.com` (public hostname).

> **Why a hostname, not a bare IP?** Two independent reasons, both
> learned the hard way: (1) **TLS** — Chromium/Firefox reject internal-CA
> certs that carry an *IP* SAN, so bare-IP HTTPS fails the handshake in
> real browsers. (2) **Clerk** — Clerk's session cookies need a valid
> cookie *domain*, which a bare IP can't provide (`__clerk_test_etld …
> rejected for invalid domain`). A hostname fixes both at once. If you
> have no DNS, an `/etc/hosts` entry on each client machine
> (`<ip>  dash.lan`) is enough.

**Choosing the cert source — `CADDY_TLS_DIRECTIVE`:** for HTTPS that
isn't public Let's Encrypt, set this env var to a `tls` block Caddy
injects into its config (empty by default = today's behavior). Two
common cases:

- **Tailscale `.ts.net` hostname** (publicly-trusted cert, **no browser
  warning**, no ACME challenge — ideal for a tailnet):
  ```
  DOMAIN=<node>.<tailnet>.ts.net
  CADDY_TLS_DIRECTIVE="tls { get_certificate tailscale }"
  ```
  Requires `tailscaled` reachable from the client container and "HTTPS
  Certificates" enabled on the tailnet (Tailscale admin → DNS).
- **Internal CA for an intranet hostname** (one-time per-device root-CA
  trust): `CADDY_TLS_DIRECTIVE="tls internal"`.

**Gotchas:**

- **Don't prefix `DOMAIN` with `https://`** — it's a site *address*, not
  a URL. Use the bare IP or hostname.
- **Port 443 must be published.** `docker-compose.deploy.yml` already
  maps both `80:80` and `443:443`, so the bundled compose is fine. If
  you write your own compose (or an orchestration role that gates
  HTTPS), make sure 443 is mapped — TLS is unreachable otherwise even
  with `DOMAIN` set.
- **Self-signed = browser warning** in IP/internal mode. To remove it,
  trust Caddy's root CA, extractable from the container at
  `/data/caddy/pki/authorities/local/root.crt`.
- **Certs persist in the `caddy_data` volume** (`/data`). Don't wipe it
  casually — the internal CA (and any device trust you've set up)
  regenerates if you do.
- **Testing TLS:** don't use macOS's built-in `curl` — its LibreSSL
  mishandles IP-address SNI and returns spurious `tlsv1 alert internal
  error` / exit 35 even when Caddy is fine. Use a browser, or
  `openssl s_client -servername <host> -connect <host>:443`.

**The client is HTTPS-ready as shipped** (≥ v0.29.2): it uses a relative
same-origin API base and derives the WebSocket scheme from the page
(`wss://` under HTTPS), so there's no mixed-content gotcha — **leave
`VITE_API_URL` unset** (an absolute `http://…` base would reintroduce
mixed content).

**Clerk sign-in needs HTTPS** (Clerk uses `crypto.subtle`, which browsers
only expose in a secure context). Clerk also enforces its **own** origin
allowlist in the Clerk dashboard, independent of this app — when you
change the deploy origin, add the new origin there.

For the full origins/CORS/cookie/HTTPS reference (and an
`http://<ip>` → `https://<host>` migration checklist), see
[Origins, CORS, cookies & HTTPS](docs/architecture/auth-modes.md#origins-cors-cookies--https).

### Option 2 — Native (run Go + React directly for development)

For active development on the codebase. Starts the Go server and
Vite dev server with hot reload.

#### Prerequisites
- Go (version in [`server-go/go.mod`](server-go/go.mod))
- Node.js 18+
- Docker + Docker Compose (for the bundled MongoDB)

```bash
# Start MongoDB only
docker compose up -d mongodb

# Start the Go backend (Terminal 1)
cd server-go
go build -o bin/server cmd/server/main.go && ./bin/server
# Listens on http://localhost:3001
# Swagger UI at http://localhost:3001/swagger/index.html

# Start the React frontend (Terminal 2)
cd client
npm install
npm run dev
# Dev server at http://localhost:5173
```

Then open <http://localhost:5173>.

> **Dev note — multiple tabs + streaming.** The Vite dev server proxies
> over HTTP/1.1, so all tabs on `localhost:5173` share the browser's
> ~6-connections-per-origin limit. Streaming panels each hold one
> persistent SSE connection open, so a couple of stream-heavy dashboards
> across two tabs can exhaust the pool and make new streams stall. If you
> need several streaming dashboards open at once in dev, use a second
> browser (or browser profile) — each gets its own connection pool.
> Production is fronted by Caddy over HTTP/2, which multiplexes and isn't
> affected. (trv-outpost#142)

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for production
deployment options (HTTPS via Let's Encrypt, building images from
source, backup + restore).

### Install on a phone (Add to Home Screen)

The app ships a web-app manifest, so a phone can run it like an
installed app — launched from its own home-screen icon with **no
browser UI at all**, which pairs with the mobile layout for an
edge-to-edge dashboard. Nothing to configure server-side; just open
your deployment's URL on the phone and install:

- **iPhone / iPad (Safari)** — tap **Share → Add to Home Screen**,
  then launch from the new icon. (On iPhone this is also the only
  way to a truly fullscreen dashboard — Safari doesn't let web pages
  fullscreen arbitrary elements, so the in-browser fullscreen view
  keeps Safari's bars.)
- **Android (Chrome)** — accept the **Install app** prompt, or menu
  **⋮ → Add to Home screen**.

Works over HTTPS (or plain HTTP on a trusted LAN). Sign-in state is
kept separately from the browser tab, so you'll log in once on first
launch.

## Application modes

- **Design mode** (`/design/*`) — author connections, components,
  and dashboards. AI Builder lives here as an alternate path to
  component creation.
- **View mode** (`/view/*`) — end-user dashboard runtime with
  real-time data, auto-refresh, fullscreen, four fit modes, and the
  dashboard-variable controls (connection swap, filter, time range +
  step). On a phone it switches to a view-only **mobile layout** that
  stacks panels vertically for legibility.
- **Manage mode** (`/manage/*`) — admin settings, user management,
  device and device-type management.

## Documentation

- **[Architecture doc set](docs/architecture/ARCHITECTURE.md)** —
  start here for anything technical. Sub-documents cover data
  model, backend, frontend, streaming, connections, database, API
  reference, and the grid system.
- [MCP server](docs/mcp.md) — tool inventory, agent flow, and
  Claude Desktop setup via `mcp-proxy`
- [Examples](examples/) — reference runs and demos
  ([dashboards](examples/dashboards/) is a screenshot gallery: AI-built
  boards, the Assistant mid-edit, ts-store rollups under a range
  variable, and a camera/control/weather kiosk)
- [Deployment guide](docs/DEPLOYMENT.md) — production deployment
- [Test plan](docs/TEST_PLAN.md)
- [Project CLAUDE.md](CLAUDE.md) — conventions for contributors
- Historical plans and archived implementation notes live under
  [`docs/plans-archive/`](docs/plans-archive/)

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting,
the scanning tools used (`npm audit`, `govulncheck`, `gitleaks`),
and the project's known security posture.

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Acknowledgements

This project bundles third-party assets. See
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for full
attribution and license texts.
