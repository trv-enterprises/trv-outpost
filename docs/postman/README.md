# Postman collection

Postman v2.1 collection for the TRV Outpost API, generated from the
Swagger spec the Go server emits at `server-go/docs/swagger.json`.

## Files

| File | Purpose |
|------|---------|
| `trv-outpost.postman_collection.json` | The collection itself — every documented `/api/*` endpoint, grouped by tag, plus a hand-authored `MCP` folder for `/mcp/message`. **Regenerated** by `build-collection.js`. |
| `trv-outpost.postman_environment.json` | Your local environment variables: `baseUrl`, `apiKey`, `userId`. **Only seeded on first run** so your real values don't get clobbered when you regenerate. |
| `build-collection.js` | The converter. Re-run after any change to a handler's swag annotations. |
| `package.json` | Just `"type": "module"` so `node` doesn't print a warning when running the converter. |

## First-time setup

1. **Issue an API key**
   In the dashboard UI: avatar menu → **API Keys** → **New API key**. Copy
   the token (`trve_…`) — it's shown once.

2. **Import the collection + environment into Postman**
   - File → Import → drop both JSON files
   - Top-right environment selector → pick "TRV Outpost (local)"
   - Set `apiKey` to the token from step 1
   - Adjust `baseUrl` if you're not on `localhost:3001`

That's it. Every request inherits the collection-level
`Authorization: Bearer {{apiKey}}` header. `userId` is unused unless
you flip a request's disabled `X-User-ID` header on (legacy path,
dev only).

## Auth model

The collection mirrors the server's auth precedence as of v0.9.0:

1. `Authorization: Bearer trve_…` — **collection-level default**.
2. `X-User-ID: <guid>` — **disabled per-request header**, shown but
   off. Flip it on if you want to test the legacy identity-assertion
   path. Don't enable both at once; the server prefers Bearer when
   present.

Unauthenticated endpoints (`/health`, `/api/ws/status`,
`/api/streams/inbound/:datasourceId`) still receive the Bearer
header — the server ignores it for those routes, so this is
harmless.

## Regenerating

When you add or change an API endpoint, re-run the two-step refresh:

```bash
# 1. regenerate the swagger spec from Go annotations
cd server-go
$GOPATH/bin/swag init -g cmd/server/main.go -o docs

# 2. rebuild the Postman collection
cd ../docs/postman
node build-collection.js
```

The collection JSON is overwritten in place; the environment JSON is
left alone if it already exists.

After regeneration, re-import the collection into Postman (File →
Import; Postman replaces the existing one by ID).

## Known mismatches

A few quirks live in the source Swagger spec, not the converter:

- The Swagger spec declares `basePath: /api` *and* every handler
  annotates `@Router /api/foo`, which would double the prefix. The
  converter detects this and skips `basePath` so the URLs match the
  real server (`/api/foo`). If you ever change the Go annotations to
  *not* include the `/api` prefix, the converter will need a tweak.
- The Swagger spec lists `/api/health`, `/api/ws/status`, and
  `/version` under `/api/*`, but those routes are actually served
  outside the authenticated group (no `/api` prefix). The collection
  faithfully reproduces what Swagger says; if you call them and
  they 404, drop the leading `/api` in the request URL.
- `/mcp/sse` and `/mcp/message` are not in Swagger. The MCP folder
  contains three hand-authored examples (initialize, tools/list,
  tools/call) covering the common debug flow.
