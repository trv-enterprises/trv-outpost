# Building from source

This document is for **anyone who wants to build the TRV Outpost
container images themselves** rather than pull the prebuilt ones from
ghcr.io. The published images at
`ghcr.io/trv-enterprises/outpost-{server,client}:<version>` are
produced by exactly the steps below, running on a clean Ubuntu
runner via GitHub Actions (see `.github/workflows/publish-containers.yml`).
You can reproduce them with nothing but Docker.

If instead you just want to run the dashboard from prebuilt images,
see the deployment docs in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
If you want to hack on the source locally without Docker, see the
"Development Setup" section in [`CLAUDE.md`](CLAUDE.md).

---

## Prerequisites

Just **Docker** with Buildx and QEMU support. Modern Docker Desktop
on macOS / Windows ships with both; on Linux, install the
`docker-buildx-plugin` and (for multi-arch) `qemu-user-static`.

```bash
docker --version             # any 24+ works
docker buildx version        # should print a version, not an error
```

For multi-architecture builds (linux/amd64 + linux/arm64), enable
QEMU emulation once per machine:

```bash
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
docker buildx create --use   # create a buildx builder if you don't have one
```

If you only need single-arch images (your local platform), Buildx
defaults are fine — skip the QEMU setup.

---

## One-shot build (local platform only)

The simplest path. Produces two images you can `docker run` immediately.

```bash
git clone https://github.com/trv-enterprises/trv-outpost.git
cd trv-outpost
git checkout v0.18.2                   # or whichever tag you want

# Server image — context is the repo root because the server's
# Dockerfile pulls files from both ./server-go and ./udoc.
docker build -f server-go/Dockerfile -t outpost-server:local .

# Client image — context is ./client because everything the client
# build needs lives there.
docker build -f client/Dockerfile -t outpost-client:local ./client
```

Builds take ~3-5 minutes depending on your machine and whether
Docker has cached the upstream `golang:1.26-alpine` and
`node:20-alpine` base layers.

---

## Multi-architecture build (matches the published images)

The GitHub Actions workflow builds for both `linux/amd64` and
`linux/arm64` so a single image tag works on both Intel servers and
ARM Pi 4 / Apple Silicon hardware. To reproduce that:

```bash
# Server
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f server-go/Dockerfile \
  -t outpost-server:local \
  --load \
  .

# Client
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f client/Dockerfile \
  -t outpost-client:local \
  --load \
  ./client
```

`--load` saves to the local Docker daemon. If you want to push
to your own registry instead, swap that for `--push` and provide
appropriate `-t` tags.

---

## What's in each image

### `outpost-server`

- **Go binary** at `/server` — built from `server-go/cmd/server/main.go`
  with Go 1.26 inside the image
- **Docs static bundle** at `/docs/` — built from `udoc/` (Docusaurus)
  with Node 20 inside the image
- **Swagger UI** at `/swagger/index.html` — served from generated
  `server-go/docs/swagger.{json,yaml}` (already in-tree; not regenerated
  at build time)
- Listens on port `3001`

### `outpost-client`

- **Static SPA bundle** in `/srv/` — Vite production build of
  `client/` with Node 20 inside the image
- **Caddy** as the runtime server, with the project's
  `client/Caddyfile` (serves the SPA, proxies `/api/*` to the
  server)
- Listens on port `80` (and `443` for auto-TLS if configured
  upstream)

---

## Verifying a build matches a published image

You can confirm the published image at
`ghcr.io/trv-enterprises/dashboard-server:0.17.7` is exactly what
the source produces by comparing image digests:

> **Note:** images were renamed `dashboard-{server,client}` →
> `outpost-{server,client}` partway through the project's history.
> Tags published **before** the rename keep the `dashboard-*` name
> (the example below pulls one); tags published **after** use
> `outpost-*`. Pick the registry path that matches the tag's era.

```bash
# Pull the published one
docker pull ghcr.io/trv-enterprises/dashboard-server:0.17.7

# Build locally from the matching tag
git checkout v0.18.2
docker buildx build \
  --platform linux/amd64 \
  -f server-go/Dockerfile \
  -t outpost-server:from-source \
  --load \
  .

# Compare. Note: digests will NOT match byte-for-byte because the
# published image's layer ordering and the build timestamp metadata
# differ. To verify equivalence, compare the *binary contents* of
# the /server executable inside both:
docker run --rm --entrypoint sha256sum ghcr.io/trv-enterprises/dashboard-server:0.17.7 /server
docker run --rm --entrypoint sha256sum outpost-server:from-source /server
```

If those two sha256 values match, the binary is bit-identical. This
is the same property a third party can verify: nothing about the
published image requires trust beyond "the v0.18.2 git tag is what
went in."

---

## Building only the server-side binary (no Docker)

If you want a Go binary without the image, that path needs Go 1.26
locally:

```bash
cd server-go
go build -o bin/server cmd/server/main.go
```

This is the path the `Makefile` uses for local development (`make
run-server` and friends). It's also what gets built inside the
server Docker image. The Dockerfile path is the more portable one
because it pins Go 1.26 to the image layer regardless of what's
on the host.

---

## Reproducible builds and supply-chain notes

The container images published to ghcr.io are produced exclusively
by GitHub Actions running on a clean `ubuntu-latest` runner from
the matching tag. The workflow file is in this repo at
[`.github/workflows/publish-containers.yml`](.github/workflows/publish-containers.yml)
and the build commands it runs are the same `docker buildx build`
invocations shown above. There is no separate "release engineer
laptop" producing the published images.

The base images pinned in the Dockerfiles
(`golang:1.26-alpine`, `node:20-alpine`, `caddy:2-alpine`) are
themselves Docker Official images, signed by the Docker Library
maintainers and available from Docker Hub.

---

## Troubleshooting

**`failed to solve: process "/bin/sh -c npm ci" did not complete`** —
the client Dockerfile uses `npm ci` which requires `package-lock.json`.
Make sure you cloned the full repo (not just a sparse tree).

**`exec format error` on the resulting image** — your build target
platform didn't match where you're trying to run it. Either rebuild
with `--platform` matching your runtime, or use the published
multi-arch image.

**Build is very slow on first run** — Docker is downloading the
`golang:1.26-alpine` (~150MB) and `node:20-alpine` (~50MB) base
layers plus Go module deps (~100MB). After the first build, the
layer cache makes subsequent builds much faster.
