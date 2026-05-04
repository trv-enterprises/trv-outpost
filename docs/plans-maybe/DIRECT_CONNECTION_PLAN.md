# Direct Connection Mode - Implementation Plan

> **Status (2026-05-03): SUPERSEDED.** This plan was the original
> motivation for the `mask_secrets` flag on connections. The feature
> was never built, so the flag was removed and the API now always
> masks secrets in GET responses. If we revisit direct-mode
> connections, we'd need a different mechanism for delivering
> credentials to the browser — likely a separate short-lived
> token-issue endpoint, not a per-connection always-on opt-out.

## Overview

Add a per-datasource toggle that determines whether the frontend communicates directly with the data source or proxies through the dashboard server.

**Connection Modes:**
1. **Server-proxied (default)**: Frontend → Dashboard Server → Data Source
2. **Direct**: Frontend → Data Source (bypassing server)

## Why This Feature

**Benefits of direct connections:**
- Lower latency for real-time data (WebSockets, SSE)
- Reduced server load for high-frequency updates
- Useful when data source is on same network as browser client

**Why server-proxied remains important:**
- CORS restrictions (most APIs won't allow browser requests)
- Credentials stay secure on server (never exposed to browser)
- Server can transform/aggregate data before sending to client
- Works when data source isn't network-accessible from browser

## Security Constraint

**Critical**: Direct connections require `mask_secrets: false` because the frontend needs credentials to authenticate with the data source.

This means:
- Credentials will be visible in browser dev tools (Network tab)
- Only appropriate for internal/trusted environments
- User must acknowledge security implications when enabling

## Data Model Changes

### Datasource Model

```go
type Datasource struct {
    // ... existing fields ...
    MaskSecrets    bool   `json:"mask_secrets" bson:"mask_secrets"`       // If true, secrets masked in API (default: true, immutable after create)
    ConnectionMode string `json:"connection_mode" bson:"connection_mode"` // "server" (default) or "direct"
}
```

### Validation Rules

1. `mask_secrets` cannot be changed after datasource creation
2. `connection_mode: "direct"` requires `mask_secrets: false`
3. `connection_mode: "direct"` not supported for SQL datasources (no browser SQL drivers)

## Implementation Phases

### Phase 1: Backend Model & Validation

**Files to modify:**
- `server-go/internal/models/datasource.go`
  - Add `ConnectionMode` field with default "server"
  - Add validation in request structs

- `server-go/internal/service/datasource_service.go`
  - Validate `connection_mode` + `mask_secrets` combination
  - Prevent `mask_secrets` changes on update
  - Reject `connection_mode: "direct"` for SQL datasources

**Estimated scope:** ~50 lines

### Phase 2: Frontend Datasource Editor UI

**Files to modify:**
- `client/src/pages/DatasourceDetailPage.jsx`
  - Add `mask_secrets` toggle (only in create mode, disabled after save)
  - Add `connection_mode` toggle (only visible when `mask_secrets: false`)
  - Show security warning when enabling direct mode
  - Hide both toggles for SQL datasources

**UI Design:**
```
┌─────────────────────────────────────────────────────┐
│ Security Settings                                    │
├─────────────────────────────────────────────────────┤
│ □ Expose credentials to frontend                    │
│   ⚠️ Warning: Credentials will be visible in        │
│   browser developer tools                           │
│                                                     │
│ Connection Mode (only if above is checked)          │
│ ○ Server-proxied (recommended)                      │
│ ○ Direct connection                                 │
└─────────────────────────────────────────────────────┘
```

**Estimated scope:** ~100 lines

### Phase 3: Frontend Data Fetching Abstraction

**Files to modify:**
- `client/src/hooks/useData.js`
  - Check datasource `connection_mode`
  - Route to appropriate fetching strategy

**New files:**
- `client/src/utils/directConnections.js`
  - `directFetchAPI(config, query)` - Direct REST API calls
  - `directConnectWebSocket(config)` - Direct WebSocket connection
  - `directFetchTSStore(config, query)` - Direct TSStore HTTP calls

**Estimated scope:** ~200-300 lines

### Phase 4: Direct Connection Implementations

#### 4.1 REST API Direct Connection

```javascript
async function directFetchAPI(apiConfig, query) {
  const { url, method, headers, auth_type, auth_credentials, query_params } = apiConfig;

  // Build headers with auth
  const requestHeaders = { ...headers };
  if (auth_type === 'bearer') {
    requestHeaders['Authorization'] = `Bearer ${auth_credentials.token}`;
  } else if (auth_type === 'basic') {
    requestHeaders['Authorization'] = 'Basic ' + btoa(`${auth_credentials.username}:${auth_credentials.password}`);
  } else if (auth_type === 'api-key') {
    requestHeaders[auth_credentials.header || 'X-API-Key'] = auth_credentials.key;
  }

  const response = await fetch(url, { method, headers: requestHeaders });
  return response.json();
}
```

#### 4.2 WebSocket Direct Connection

```javascript
function directConnectWebSocket(socketConfig, onMessage) {
  const ws = new WebSocket(socketConfig.url);

  // Add auth headers if needed (via protocol or query params)
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    // Apply parser config (data_path extraction)
    onMessage(extractData(data, socketConfig.parser));
  };

  return ws;
}
```

#### 4.3 TSStore Direct Connection

```javascript
async function directFetchTSStore(tsstoreConfig, query) {
  const { url, store_name, api_key } = tsstoreConfig;
  const headers = api_key ? { 'X-API-Key': api_key } : {};

  const response = await fetch(`${url}/json/${query.type}/${store_name}`, {
    headers,
    // ... query params
  });
  return response.json();
}
```

**Estimated scope:** ~300 lines

### Phase 5: Integration with DynamicComponentLoader

**Files to modify:**
- `client/src/components/DynamicComponentLoader.jsx`
  - Pass `connectionMode` to data fetching logic
  - Handle direct WebSocket connections for streaming

- `client/src/hooks/useData.js`
  - Fetch datasource config to determine connection mode
  - Cache datasource configs to avoid repeated fetches

**Estimated scope:** ~100 lines

### Phase 6: Testing & Documentation

- Test each datasource type in both modes
- Test credential masking still works for server-proxied
- Update CLAUDE.md with new fields
- Add user documentation for when to use direct mode

## Datasource Type Support Matrix

| Type    | Server-Proxied | Direct | Notes |
|---------|---------------|--------|-------|
| SQL     | ✅            | ❌     | No browser SQL drivers |
| API     | ✅            | ✅     | May hit CORS issues |
| Socket  | ✅            | ✅     | Best candidate for direct |
| TSStore | ✅            | ✅     | May hit CORS issues |
| CSV     | ✅            | ⚠️     | Only if file served via HTTP |

## Migration

- All existing datasources default to `mask_secrets: true`, `connection_mode: "server"`
- No migration script needed (defaults handle it)

## Total Estimated Effort

- Backend: ~50-100 lines
- Frontend UI: ~100 lines
- Frontend data layer: ~400-500 lines
- Testing: ~1 day

## Open Questions

1. Should we provide a CORS proxy option for API datasources that need direct mode but hit CORS?
2. For WebSockets in direct mode, how do we handle reconnection logic currently in the server?
3. Should direct mode show a persistent indicator in the UI (e.g., badge on dashboard)?

---

**Status:** TODO - Deferred for future implementation
**Created:** 2026-01-15
**Priority:** Low (other features more important)
