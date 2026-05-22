# Dashboard End-to-End Test Plan

## Overview
Comprehensive test plan for all dashboard features, connection types, and aggregation capabilities.

**Version**: v0.3.2
**Date**: 2026-05-22 (synced to dashboard v0.18.2 terminology)
**Excludes**: Rules Engine (not in scope)

---

## 1. Connection Types

### 1.1 SQL (PostgreSQL)
- [ ] Create PostgreSQL connection with host/port/database/user/password
- [ ] Test connection succeeds
- [ ] Schema discovery returns tables and columns with types
- [ ] Execute SELECT query returns data
- [ ] Execute query with parameters works
- [ ] Health check shows healthy status
- [ ] Update connection configuration
- [ ] Delete connection

### 1.2 SQL (MySQL)
- [ ] Create MySQL connection
- [ ] Test connection succeeds
- [ ] Schema discovery returns tables and columns
- [ ] Execute query returns data

### 1.3 SQL (SQLite)
- [ ] Create SQLite connection with file path
- [ ] Test connection succeeds
- [ ] Schema discovery works
- [ ] Execute query returns data

### 1.4 REST API
- [ ] Create API connection with URL
- [ ] Configure Bearer token authentication
- [ ] Configure Basic authentication
- [ ] Configure API-Key authentication
- [ ] Test connection succeeds
- [ ] Execute GET request returns data
- [ ] Response parsing with JSON path extraction works
- [ ] Custom headers are sent
- [ ] Query parameters are applied

### 1.5 CSV
- [ ] Create CSV connection with file path
- [ ] Configure custom delimiter
- [ ] Header detection works correctly
- [ ] Schema inference from file works
- [ ] Query with filter expression returns filtered data

### 1.6 WebSocket/Socket
- [ ] Create WebSocket connection with URL
- [ ] Configure message parser (JSON path, field mapping)
- [ ] Test connection succeeds
- [ ] Stream endpoint receives real-time data
- [ ] Reconnection on disconnect works
- [ ] Buffer configuration works (initial records sent on connect)

### 1.7 TSStore
- [ ] Create TSStore connection with URL and API key
- [ ] Test connection succeeds
- [ ] Schema discovery returns store fields
- [ ] Query with time range returns data
- [ ] Push streaming connection works (TSStore dials back)
- [ ] Aggregation window configuration works
- [ ] Format options (full/compact) work correctly

### 1.8 Prometheus
- [ ] Create Prometheus connection with URL
- [ ] Configure basic auth if required
- [ ] Test connection succeeds
- [ ] Schema discovery returns metrics list
- [ ] Schema discovery returns label names
- [ ] Get label values for specific label
- [ ] Execute instant query returns current values
- [ ] Execute range query with start/end/step returns time series
- [ ] Relative time expressions work (now-1h, now-5m)

### 1.9 EdgeLake
- [ ] Create EdgeLake connection with URL
- [ ] Test connection succeeds
- [ ] Schema discovery: list databases
- [ ] Schema discovery: list tables for database
- [ ] Schema discovery: list columns for table
- [ ] Execute SQL query with database parameter
- [ ] Distributed query option works
- [ ] Extended fields (+ip, +hostname) work

---

## 2. Chart Types

### 2.1 Standard Chart Types
- [ ] Create Line chart with data mapping
- [ ] Create Bar chart with data mapping
- [ ] Create Area chart with data mapping
- [ ] Create Pie chart with data mapping
- [ ] Create Scatter chart with data mapping
- [ ] Create Gauge chart with single value
- [ ] Create Heatmap chart
- [ ] Create Radar chart
- [ ] Create Funnel chart
- [ ] Create DataView (table) chart

### 2.2 Chart Configuration
- [ ] Set chart title and description
- [ ] Configure X-axis label (e.g., "Time")
- [ ] Configure Y-axis label (e.g., "Temperature (°F)")
- [ ] Configure multiple Y-axis columns
- [ ] Configure group by for multiple series
- [ ] Configure legend position
- [ ] Configure tooltip formatting
- [ ] Configure colors
- [ ] Enable/disable data labels
- [ ] Enable stacking (bar/area)
- [ ] Enable line smoothing

### 2.3 Custom Code Charts
- [ ] Create chart with custom React component code
- [ ] Access `data` prop with columns and rows
- [ ] Use `toObjects(data)` utility
- [ ] Use `getValue(data, 'column')` utility
- [ ] Use `formatTimestamp()` utility
- [ ] ReactECharts renders correctly
- [ ] Carbon DataTable renders correctly

### 2.4 Chart Versioning
- [ ] New chart starts at version 1 (final)
- [ ] Update creates new version
- [ ] List versions shows history
- [ ] Get specific version works
- [ ] Delete specific version works
- [ ] Draft creation for AI sessions works
- [ ] Save draft as final version works

---

## 3. Data Filtering

### 3.1 Filter Operators
- [ ] `eq` (equals) filter works
- [ ] `neq` (not equals) filter works
- [ ] `gt` (greater than) filter works
- [ ] `gte` (greater than or equal) filter works
- [ ] `lt` (less than) filter works
- [ ] `lte` (less than or equal) filter works
- [ ] `contains` (string contains) filter works
- [ ] `in` (value in array) filter works
- [ ] `isNull` filter works
- [ ] `isNotNull` filter works

### 3.2 Multiple Filters
- [ ] Multiple filters combine with AND logic
- [ ] Filters on different columns work together
- [ ] Filters with aggregation work correctly

---

## 4. Aggregation

### 4.1 Simple Aggregations
- [ ] `first` aggregation returns first row
- [ ] `last` aggregation returns last row
- [ ] `min` aggregation returns minimum value
- [ ] `max` aggregation returns maximum value
- [ ] `avg` aggregation returns average value
- [ ] `sum` aggregation returns sum of values
- [ ] `count` aggregation returns row count
- [ ] Aggregation with sort column works (for first/last)
- [ ] Aggregation on specific field works

### 4.2 Row Limiting
- [ ] Limit parameter restricts row count
- [ ] Limit with sort order works

### 4.3 Sliding Window (Time-based)
- [ ] Configure sliding window duration (e.g., 300 seconds)
- [ ] Specify timestamp column
- [ ] Data outside window is excluded
- [ ] Window slides with new data

### 4.4 Time Bucketing
- [ ] Configure bucket interval (e.g., 60 seconds)
- [ ] Configure aggregation function per bucket
- [ ] Timestamp column alignment works
- [ ] Multiple columns aggregate correctly
- [ ] Empty buckets handled appropriately

---

## 5. Dashboards

### 5.1 Dashboard CRUD
- [ ] Create dashboard with name and description
- [ ] List dashboards with pagination
- [ ] Get dashboard by ID
- [ ] Update dashboard settings
- [ ] Delete dashboard

### 5.2 Dashboard Layout
- [ ] Add panel to 12-column grid
- [ ] Set panel position (x, y)
- [ ] Set panel dimensions (width, height)
- [ ] Multiple panels arrange correctly
- [ ] Assign chart to panel
- [ ] Panel renders assigned chart

### 5.3 Dashboard Settings
- [ ] Configure refresh interval
- [ ] Configure timezone
- [ ] Set public/private access
- [ ] Configure title scale (50-200%)
- [ ] Enable/disable export

### 5.4 Dashboard Viewer
- [ ] Dashboard loads all charts
- [ ] Auto-refresh triggers at interval
- [ ] Manual refresh button works
- [ ] Last refresh timestamp displays
- [ ] Fullscreen mode works
- [ ] Reduce-to-fit scaling works
- [ ] Chart data inspection modal works
- [ ] Navigate to chart editor works

### 5.5 Dashboard Tiles
- [ ] Tile view shows all dashboards
- [ ] Thumbnails display correctly
- [ ] Connection names shown
- [ ] Click tile opens dashboard
- [ ] First dashboard auto-loads on app start

---

## 6. AI Chart Builder

### 6.1 Session Management
- [ ] Create new AI session
- [ ] Session creates draft chart
- [ ] Get session state returns current state
- [ ] Cancel session cleans up draft
- [ ] Save session commits chart with name

### 6.2 Chat Interaction
- [ ] Send message receives SSE response
- [ ] AI responses stream correctly
- [ ] Tool calls are displayed
- [ ] Chart updates reflect in preview
- [ ] Message history is preserved
- [ ] WebSocket connection works as alternative

### 6.3 AI Tool Usage
- [ ] AI calls `list_connections` to find sources
- [ ] AI calls `get_schema` to discover columns
- [ ] AI calls `update_chart_config` to set type
- [ ] AI calls `get_chart_template` for starter code
- [ ] AI calls `update_data_mapping` with columns
- [ ] AI calls `update_filters` when needed
- [ ] AI calls `update_aggregation` when needed
- [ ] AI calls `set_custom_code` for complex charts
- [ ] AI calls `query_connection` to test queries
- [ ] AI calls `preview_data` to see results

### 6.4 AI with Different Connections
- [ ] AI creates chart from SQL connection
- [ ] AI creates chart from Prometheus connection
- [ ] AI creates chart from EdgeLake connection
- [ ] AI creates chart from API connection
- [ ] AI creates chart from WebSocket connection
- [ ] AI creates chart from TSStore connection

### 6.5 AI Chart Types
- [ ] AI creates line chart on request
- [ ] AI creates bar chart on request
- [ ] AI creates pie chart on request
- [ ] AI creates gauge chart on request
- [ ] AI creates custom chart when needed
- [ ] AI applies appropriate formatting

---

## 7. Streaming & Real-time

### 7.1 WebSocket Streaming
- [ ] Connect to stream endpoint via SSE
- [ ] Receive buffered records on connect
- [ ] Receive new records as they arrive
- [ ] Heartbeat keeps connection alive
- [ ] Reconnect on disconnect
- [ ] Multiple clients receive same data

### 7.2 TSStore Push Streaming
- [ ] TSStore dials back to inbound endpoint
- [ ] Data flows through push connection
- [ ] Aggregation window applies to stream
- [ ] Format selection works (full/compact)

### 7.3 Prometheus Polling
- [ ] Polling interval triggers queries
- [ ] New values sent on each poll
- [ ] Instant queries return current state

### 7.4 Real-time Dashboard
- [ ] Streaming chart updates in dashboard
- [ ] Multiple streaming charts work together
- [ ] No memory leaks on long-running streams

---

## 8. API Endpoints

### 8.1 Health & System
- [ ] `GET /health` returns status and version
- [ ] `GET /version` returns version info
- [ ] `GET /api/health` returns service health

### 8.2 Authentication
- [ ] `GET /api/auth/me` returns current user
- [ ] X-User-ID header sets user context

### 8.3 Connection Endpoints
- [ ] `POST /api/connections` creates connection
- [ ] `GET /api/connections` lists with pagination
- [ ] `GET /api/connections/:id` returns connection
- [ ] `PUT /api/connections/:id` updates connection
- [ ] `DELETE /api/connections/:id` deletes connection
- [ ] `POST /api/connections/test` tests connection
- [ ] `POST /api/connections/:id/health` checks health
- [ ] `POST /api/connections/:id/query` executes query
- [ ] `GET /api/connections/:id/schema` returns schema

### 8.4 Component Endpoints
- [ ] `POST /api/components` creates component
- [ ] `GET /api/components` lists with pagination
- [ ] `GET /api/components/:id` returns latest version
- [ ] `PUT /api/components/:id` updates component
- [ ] `DELETE /api/components/:id` deletes component
- [ ] `GET /api/components/:id/versions` returns version history
- [ ] `GET /api/components/:id/draft` returns draft

### 8.5 Dashboard Endpoints
- [ ] `POST /api/dashboards` creates dashboard
- [ ] `GET /api/dashboards` lists with pagination
- [ ] `GET /api/dashboards/:id` returns dashboard
- [ ] `GET /api/dashboards/:id/details` returns expanded
- [ ] `PUT /api/dashboards/:id` updates dashboard
- [ ] `DELETE /api/dashboards/:id` deletes dashboard

### 8.6 AI Session Endpoints
- [ ] `POST /api/ai/sessions` creates session
- [ ] `GET /api/ai/sessions/:id` returns session
- [ ] `POST /api/ai/sessions/:id/messages` sends message (SSE)
- [ ] `POST /api/ai/sessions/:id/save` saves chart
- [ ] `DELETE /api/ai/sessions/:id` cancels session

---

## 9. Error Handling

### 9.1 Connection Errors
- [ ] Invalid connection string shows clear error
- [ ] Connection timeout handled gracefully
- [ ] Authentication failure shows clear message
- [ ] Invalid query shows syntax error
- [ ] Missing database/table shows not found

### 9.2 Chart Errors
- [ ] Invalid connection reference caught
- [ ] Missing required fields show validation error
- [ ] Invalid chart type rejected
- [ ] Malformed custom code shows error

### 9.3 Dashboard Errors
- [ ] Invalid chart reference caught
- [ ] Invalid panel configuration rejected
- [ ] Missing layout shows error

### 9.4 AI Errors
- [ ] Rate limit (429) handled with message
- [ ] API error shows user-friendly message
- [ ] Tool execution error captured
- [ ] Session timeout handled

---

## 10. UI/UX Verification

### 10.1 Design Mode Navigation
- [ ] Connections list page loads
- [ ] Charts list page loads
- [ ] Dashboards list page loads
- [ ] Create buttons work
- [ ] Edit navigation works
- [ ] Delete with confirmation works

### 10.2 View Mode Navigation
- [ ] Dashboard tiles load
- [ ] Click tile opens viewer
- [ ] Mode toggle switches correctly
- [ ] Sidebar navigation works

### 10.3 Forms & Validation
- [ ] Required fields show validation
- [ ] Invalid input shows error message
- [ ] Save button disabled when invalid
- [ ] Success notification on save

### 10.4 Responsive Design
- [ ] Dashboard renders on different screen sizes
- [ ] Charts scale appropriately
- [ ] Navigation works on smaller screens

---

## Test Environment Checklist

### Infrastructure
- [ ] MongoDB running and accessible
- [ ] Redis running and accessible
- [ ] Go server running on port 3001
- [ ] Client running on port 5173 (dev) or served by Caddy

### Test Connections Available
- [ ] PostgreSQL with test data (simulators)
- [ ] WebSocket simulator running
- [ ] REST API simulator running
- [ ] Prometheus instance (if testing)
- [ ] EdgeLake instance (if testing)
- [ ] TSStore instance (if testing)
- [ ] CSV test file available

### Test Data
- [ ] Sensor readings in PostgreSQL
- [ ] Time series data for streaming tests
- [ ] Multiple data types for filter testing

---

## N. ts-store Alert Webhook Receiver (Phase 1)

The dashboard receives ts-store alerts via webhook and surfaces them in
the notification bell panel. Rule authoring on ts-store is **manual**
in this phase (curl recipe below); Phase 2 will add an in-app component
for managing rules from the dashboard.

### N.1 System user provisioning
- [ ] Manage → System Users page loads (admin only).
- [ ] Non-admin (Support / Designer) sees 403 / has no nav link.
- [ ] Create a system user named `tsstore-webhook-recvr`.
- [ ] System user shows up in the list with `kind: system` tag.
- [ ] Mint an API key — one-time-reveal modal appears with `trve_...` token.
- [ ] Copy the token; modal closes.
- [ ] Listed key shows `trve_<prefix>…` and `active` tag.
- [ ] Revoke an individual key — confirms before revoking; key flips to `revoked` tag.
- [ ] Delete the system user — confirms; user disappears; cascaded keys gone.

### N.2 Auth posture
- [ ] System user CANNOT sign in via `X-User-ID: <guid>` — server returns 403.
- [ ] System user CANNOT sign in via IdP / Clerk (when Clerk enabled).
- [ ] Inbound call with `Authorization: Bearer trve_<key>` resolves to the system user;
  `/api/auth/me` returns the system user record.

### N.3 Webhook receiver
- [ ] `POST /api/webhooks/tsstore/:connection_id` with no auth returns 401.
- [ ] Wrong-shape body returns 400.
- [ ] `connection_id` not in DB returns 404.
- [ ] `connection_id` of non-tsstore type returns 400.
- [ ] Payload `store_name` mismatching the connection's configured `store_name` returns 400.
- [ ] Well-formed payload returns 202 within a few ms.

### N.4 SSE fan-out
- [ ] App load opens `/api/events/stream`; browser console shows `[events] SSE connected`.
- [ ] Server log shows `events: SSE opened user=...`.
- [ ] After firing a webhook, every open browser tab (any logged-in user) receives a bell-panel
  entry titled `<rule_name> on <connection.name>`, subtitle = condition string.
- [ ] Bell panel badge increments by 1; entry persists until cleared.
- [ ] No corner toast is shown (Phase-1 design choice: bell panel only).

### N.5 Manual ts-store rule configuration

Use the ts-store HTTP API to register a webhook rule. Run from any host
that can reach both the ts-store and the dashboard:

```bash
TS_STORE_URL="http://<ts-store-host>:21080"
DASH_URL="http://<dashboard-host>"        # e.g. https://dashboard.example.com
STORE="journal-logs"                      # ts-store's `store_name`
CONN_ID="<dashboard-connection-uuid>"     # from /api/connections (filter by type=tsstore)
TOKEN="trve_<system-user-key>"            # from Manage → System Users

curl -X POST "${TS_STORE_URL}/api/stores/${STORE}/alerts/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url":          "'"${DASH_URL}/api/webhooks/tsstore/${CONN_ID}"'",
    "headers":      { "Authorization": "Bearer '"${TOKEN}"'" },
    "rules":        [ { "name": "high-temp", "condition": "temperature > 80", "cooldown": "30s" } ],
    "poll_interval": "1s",
    "timeout":       "10s"
  }'
```

- [ ] ts-store returns 201 and the persisted webhook config.
- [ ] Inject a record into the store with `temperature > 80`.
- [ ] Within ~1s, an alert appears in the dashboard bell panel.
- [ ] Repeat within the cooldown window — only one alert fires (cooldown honored on ts-store side).
- [ ] Restart ts-store — the rule persists; alerts continue to fire after restart.

### N.6 Negative paths
- [ ] System user revoked while ts-store is still configured: next webhook fires → server returns 401;
  ts-store logs the failure but does not retry (expected per ts-store webhook policy).
- [ ] Dashboard server restart with an active SSE: client EventSource auto-reconnects; `connected`
  event fires again; no missed alerts during the brief window (ts-store fires-and-forgets, so any
  alert that lands during the gap is logged-and-lost — known limitation).

---

## Notes

Use this space to track issues found during testing:

### Issues Found
| # | Area | Description | Severity | Status |
|---|------|-------------|----------|--------|
| 1 |      |             |          |        |
| 2 |      |             |          |        |
| 3 |      |             |          |        |

### Test Session Log
| Date | Tester | Sections Completed | Notes |
|------|--------|-------------------|-------|
|      |        |                   |       |
