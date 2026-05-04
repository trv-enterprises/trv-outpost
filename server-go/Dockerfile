# syntax=docker/dockerfile:1.6

# --- Docs build stage -------------------------------------------------------
# Builds the Docusaurus site under /udoc/ into a static bundle that the Go
# server serves at /docs. Context must be the repo root so this stage can
# see the udoc/ directory.
FROM --platform=$BUILDPLATFORM node:20-alpine AS docs-build
WORKDIR /udoc
COPY udoc/package.json udoc/package-lock.json ./
RUN npm ci
COPY udoc/ ./
RUN npm run build

# --- Go build stage ---------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /build
COPY server-go/go.mod server-go/go.sum ./
RUN go mod download
COPY server-go/ .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -ldflags="-s -w" -o server cmd/server/main.go

# --- Runtime stage ----------------------------------------------------------
FROM alpine:3.19
RUN apk --no-cache add ca-certificates tzdata
WORKDIR /app
COPY --from=builder /build/server .
COPY --from=builder /build/config ./config
COPY --from=docs-build /udoc/build ./udoc/build
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q --spider http://localhost:3001/health || exit 1
CMD ["./server"]
