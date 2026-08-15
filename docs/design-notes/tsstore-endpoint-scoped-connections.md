# tsstore endpoint-scoped connections — store moves to the component (#248)

**Status: agreed, 2026-08-12.** All decisions settled in the 2026-08-12
design session (log in § 11). Depends on ts-store#138 (scoped API keys +
`GET /api/stores`), merged 2026-08-07; ts-store#152 (per-store access
classes in the store listing), shipped in v0.20.0-rc.2; and the in-flight
ts-store reclassification of ws/mqtt connection endpoints to `read`
(§ "What ts-store actually shipped").

## Vocabulary

- **Connection profile** (the `connections` record): a dictionary — base URL,
  credentials, defaults. What the UI calls a "connection" today. The profile
  never restricts runtime behavior beyond what its endpoint and key grants
  allow. (A product-wide UI rename to "connection profile" is a separate
  decision, out of scope here; this doc uses the term for precision.)
- **Channel** (the in-flight connection): a runtime object — an HTTP request,
  or a live push registration + inbound socket. One profile fans out to N
  channels. Channel identity is the subject of § 4.
- **Pinned profile**: `store_name` set — the profile is bound to exactly one
  store (today's shape).
- **Endpoint-scoped profile**: `store_name` unset — the profile identifies
  only the ts-store *server* (base URL + key), like a SQL connection pointing
  at a database server rather than one table; the store is chosen per
  component. Not transport-specific — applies to REST and streaming alike.

## Goal

A tsstore profile today is `(host, port, store_name, key)` — one profile per
store. Scoped keys make the key endpoint-wide, so the profile can become
`(host, port, key)` and the **store is chosen per component**, like a table
name on a SQL connection. Existing pinned profiles keep working untouched; no
boot migration.

## What ts-store actually shipped (verified against ts-store v0.20.0-rc.2)

Facts the design leans on, with sources:

- **`GET /api/stores`** (`internal/handlers/store_handler.go`) — authed by any
  scoped key (`X-API-Key` or `Bearer`); admin key deliberately rejected.
  **Visibility = any grant** (a write-only collector key sees its stores);
  each entry carries the caller's effective access classes (ts-store#152,
  v0.20.0-rc.2). Response:

  ```json
  {"stores": [{"name": "home-env", "data_type": "json", "role": "store",
               "access": ["read", "write", "manage"]}]}
  ```

  plus `rollup_of`/`window` on rollup entries. Objects, not strings; empty
  list serializes as `[]`. An empty list means the key holds **no grants at
  all**. Clients filter by `access` — no probing needed to learn "read here,
  manage there."
- **Grants** (`internal/apikey/grant.go`) — `read` / `write` / `manage` are
  **independent flags, not a hierarchy** (manage does not imply read). Store
  patterns: exact, trailing-`*` prefix, or `*`.
- **Access classes per endpoint** (`internal/middleware/auth.go:137-176`):
  data reads + schema = `read`; ingest = `write`; **alert CRUD (including the
  GETs) = `manage`**. Push-connection endpoints (`/ws/connections`,
  `/mqtt/connections`) shipped as `manage` in rc.2 but are being
  **reclassified as `read`** (upstream change in flight, 2026-08-12):
  registering a push connection is a way of reading, and `manage`-for-
  streaming forced destructive-capable keys (schema PUT, store reset) onto
  every streaming dashboard. **Confirmed 2026-08-12: the reclassification
  covers the whole ws/mqtt connection group — list, get, create, and
  delete** — which Outpost's stale-cleanup depends on (list+delete on every
  channel start; a read key that could create but not delete would re-orphan
  push connections and their cursors).
  Unclassified routes fail closed to `write`. `/stats` and `/metrics` are
  unauthenticated by design.
- **Legacy migration** — each legacy per-store key becomes exact-name grants
  with **all three classes** on its store(s), idempotently, at boot. So every
  existing Outpost profile keeps read+write+manage on its one store — the
  shipped alerts flows and streaming keep working with zero reconfiguration.
- **Push-connection creation is NOT idempotent** — every
  `POST /api/stores/:store/ws/connections` mints a fresh 8-char id; no
  duplicate detection by URL or config (`internal/ws/manager.go:123-189`).
  Upstream defensive fix is **ts-store#143** (open). Outpost must design out
  duplication on its side regardless (§ 4).

Grant consequence, now directly visible to the UI: charting **and streaming**
a store need `read` (post-reclassification); only alert management needs
`manage`. With the `access` array, the store dropdown scopes itself per use —
`read`-granted stores for components (covers REST and streaming alike),
`manage`-granted stores for the alerts wizard. This makes the read/manage
split a real operational boundary between profiles: the canonical deployment
is one endpoint-scoped `read:*` profile powering every dashboard, plus (if
alerts are used) one dedicated alerts profile whose key carries
**`read,manage`** on the alert-target stores — manage for rule CRUD, read
because the wizard's field discovery uses the read-class schema endpoint (a
manage-only key passes the probe, then presents an empty field picker; the
wizard should detect probe-ok-but-schema-403 and say so). The separation is
optional, not mandated — a single `read,manage:*` profile behaves exactly
like today, and the extension composes with either shape: it fans out per
(profile, manage-granted store), read-only profiles contribute nothing, and
the `backendKey` dedup collapses two profiles holding manage on the same
store into one row. A read-only profile selected in the alerts wizard shows
an empty store picker with a clear message ("this connection's key has no
manage grants — alerts need a key with manage on the target store").

Namespaces complete the pattern with zero new authz code: place the alerts
profile in a dedicated namespace (e.g. `alerts-admin`) granted only to alert
administrators. Per-user namespace grants are already enforced at the
tsstore-alerts chokepoint — `ListAll` and the wizard's connection dropdown
both go through `ListConnectionsByType`'s in-service grant filtering
(`connection_service.go:369-393`, whose doc comment names this exact role) —
so for everyone else the manage-capable profile is invisible end to end: not
offered in the wizard, no rows in the central table, unreachable for
delete/probe. The two layers bound different things and fail independently:
ts-store key grants limit what a *credential* can do; namespace grants limit
which *users* can reach the credential.

## 1. Data model

### Profile: `store_name` = optional **pinned store** **[decided]**

Semantics, per the 2026-08-12 session: the field is **more than a default —
it is a pin**.

- `store_name` **set** → pinned profile. Every component on it uses that
  store. **A component cannot override a pin** — the editor doesn't offer the
  store field, and the server resolves the pin regardless of any
  `params.store` on the component (silently, param ignored — erroring would
  break #186-style same-type swaps where a component moves from an
  endpoint-scoped profile onto a pinned one; the pin winning is the coherent
  outcome).
- `store_name` **unset** → endpoint-scoped profile. Every component **must**
  choose a store; no store resolves to an error ("endpoint-scoped connection:
  choose a store on the component").

Effective store: **pin if set; else component `params.store`; else error.**

Consolidation path: old per-store pinned profiles keep working untouched;
consolidating means creating one endpoint-scoped profile and repointing
components to it (choosing a store on each) — not layering overrides onto
pinned profiles.

Declaration sites that relax together:

| Site | Change |
|---|---|
| `models/connection.go:524` | drop `binding:"required"` on `TSStoreConfig.StoreName` |
| `service/connection_service.go:1132` | `validateTSStoreConfig` stops requiring it |
| `connection/tsstore.go:42` | registry schema field `store_name` → `Required: false` |
| `ConnectionDetailPage.jsx:1324-1331` | label "Pinned store (optional)"; helper: "Pin this connection to a single store. Leave empty to choose the store per component (endpoint-scoped)." |

### Component: store lives in `query_config.params.store` **[decided in session — applies to endpoint-scoped profiles only]**

- New reserved param key `store` joins `reservedQueryParams`
  (`connection/substitution.go:72-77`) so SQL-style adapters never bind it
  positionally.
- Why params and not a new `ChartQueryConfig` field: params already flow
  through `buildComponentDataQuery` (`handlers/component_handler.go:105-134`)
  untouched, through MCP field-complete via `decodeInto`, and through the chat
  agent's `query_connection` params map — no wire or schema change, no
  `schema_parity_test.go` churn. It sits next to `latest_by`/`filter`, which
  are the same kind of dispatch input.
- The adapter reports the **effective** store in result metadata
  (`tsstore.go:316`, `:1082`) so the client can display which store answered.

### Transport and protocol stay on the profile **[decided in session]**

The component gains exactly one knob: the store. `Transport` (rest/streaming)
and `Protocol` (http/https) remain profile-level fields
(`models/connection.go` `TSStoreConfig`), because neither is a per-component
concept in the tsstore architecture:

- There is **no client-dialed WebSocket to ts-store** (no `/ws/read`).
  Streaming = a REST registration call (`POST
  {BaseURL}/api/stores/<store>/ws/connections`, using the profile's
  `Protocol`) after which **ts-store dials out** to Outpost's inbound WS
  endpoint. "The websocket" is therefore a property of the **channel**, its
  URL generated server-side (`GetInboundURL`) — never authored by user,
  profile, or component. Under this design only the registration path and
  inbound URL become per-channel; no scheme or URL ever surfaces to the
  component.
- All subtype gating keeps working unchanged: `isTSStoreStreaming`
  (`ComponentEditor.jsx:1903`) and server `IsStreamingConnection` both read
  the profile's `transport` — the only new gate the editor learns is
  "endpoint-scoped tsstore profile → show the store ComboBox."
- Consequence: an endpoint-scoped profile is still *either* REST *or*
  streaming for every component on it. Both behaviors against one ts-store
  server = two endpoint-scoped profiles sharing the key — now cheap (two
  profiles total, vs. two-per-store today). Moving transport to the
  component is explicitly not proposed: large change (gating logic, mixed
  poll/push semantics in `useData`) for a payoff the two-profile pattern
  covers.

### Threading through the dual adapter

`tsstore.go` contains two live implementations (registry `TSStoreAdapter` +
legacy `TSStoreDataSource`), six fetch helpers each reading
`config.StoreName` inline (11 URL builders in the file). The change is
mechanical but must hit both: resolve the effective store at the top of both
`Query` methods (`tsstore.go:164`, `:781`) and pass it as an argument to
`fetchNewest`/`fetchOldest`/`fetchRange`/`fetchSchemaInternal`/`GetStoreStats`.
Add a URL-path assertion test per helper — today only
`tsstore_latestby_test.go:111` asserts a store lands in a URL, so a
store-threading bug would be silent.

`GetConnectionSchema` grows a store argument end-to-end (the alerts wizard and
the editor's field discovery both need per-store schema; the endpoint is
already store-scoped internally at `tsstore.go:474`).

### `data_type` is a store property — resolved per store, not authored **[decided in session]**

What it drives: `data_type == schema` → the adapter requests
`format=compact` and re-expands compact index-keys to field names via the
store's schema (`tsstore.go:596/617/646`, expansion at `:405`); `text` gets
its own read handling. It lives on the profile today only because there was
exactly one store, auto-detected at Test time (`tsstore.go:1305-1316`).

Under this design:

- **Pinned profiles**: unchanged — config field + Test-time auto-detect.
- **Endpoint-scoped profiles**: the adapter resolves `data_type` **per
  effective store** from the store listing (discovery already returns it),
  cached per (profile, store), and picks compact/full per request and per
  channel automatically. The author never chooses. The mixed case —
  one component on a `schema` store, another on a `json` store, same
  profile — just works: two channels, each with the right format.
- The profile-level `data_type` field remains as a back-compat value for
  pinned profiles only; it is ignored on endpoint-scoped profiles.

## 2. Store discovery — adapter-declared, no ComponentEditor branch

Two pieces:

**a) Proxy endpoint** `GET /api/connections/:id/stores` **[proposed]** — new
optional adapter interface (`StoreLister`), implemented by the tsstore adapter
as a pass-through to ts-store's `GET /api/stores` with the profile's key.
Server-side because the key never reaches the browser. Returns ts-store's
entries verbatim — including `access` and `data_type` — so every consumer
scopes itself:

| Consumer | Filter on `access` |
|---|---|
| Component editor store dropdown | `read` (covers REST and streaming — push registration is `read`-class post-reclassification) |
| Alerts wizard store picker | `manage` (empty ⇒ explain: key needs manage on the target store) |

404/never-registered for adapters that don't implement it.

**b) Query-surface declaration** **[proposed]** — the existing
`QuerySurfaceKind` has only `catalog`, which is a *whole-query preset picker*
(selecting a preset overwrites `raw` + `params` wholesale —
`ComponentEditor.jsx:4196-4206`). A store field is orthogonal to the query, so
`catalog` is the wrong shape. Add a second kind:

```go
QuerySurfaceStoreList QuerySurfaceKind = "store_list"
// "this type supports a per-component store, discoverable via
//  GET /api/connections/:id/stores"
```

registered from tsstore's `init()` (`registry.RegisterQuerySurface`, the seam
`registry/types.go:123-126` was written for). The ComponentEditor's existing
hand-written tsstore branch (`ComponentEditor.jsx:3874-4031`) renders a Carbon
`ComboBox` at the top of the query section **when the active surface has kind
`store_list` AND the selected profile is endpoint-scoped** — surface-driven
visibility, so no new type check is added, and the branch-ordering hazard (the
`isTSStore` branch shadows `catalog` surfaces at `:4173`) doesn't bite. For a
pinned profile the field is absent (the pin is not overridable, § 1).
Free-text fallback if the list call fails. The dropdown filters to
`read`-granted stores and badges rollups via `role`.

Client save/load/dirty/preview sites that carry the new param:
`ComponentEditor.jsx:2896-2901` (save spread), `:1367-1420` (restore),
`:1512-1573` (baseline), `:1644-1655` (defaults), `:2513`/`:2700` (preview),
and — easy to miss — **`useData.js:451-491`**, which re-synthesizes tsstore
params client-side for the streaming-backfill path and would otherwise
silently drop the component's store.

## 3. Connection test

- Pinned profile → unchanged (stats + alerts probe, two stages; `data_type`
  auto-detect as today).
- Endpoint-scoped profile → `GET /api/stores` with the key: connectivity +
  auth in one call. Success message: `"Connection successful (N stores
  accessible)"`. **Empty list = failure**, not warning — under any-grant
  visibility (rc.2) an empty listing means the key holds no grants at all.

## 4. Streaming — channel identity (the crux)

### The problem, restated

`connection_id` is currently the accidental identity of five things
(`streaming/manager.go:20` streams map, the inbound URL
`tsstore_stream.go:181-182`, `inbound_handler.go:22-23` socket+listener maps,
`aggregator.go:38` ConfigKey, and the client streamKey). With per-component
stores, one profile fans into N source channels, and **push-agg config is
source-side** — it changes what ts-store sends (aggregated push even emits a
different inner timestamp scale, `inbound_handler.go:165-177`) — so channels
cannot be unioned like MQTT topics or post-processed like `data_path`.

### Channel key **[decided in issue: `(connection_id, store, agg-config-hash)`; composition proposed]**

> **Implementation deviation (PR 2, risk-reducing):** pinned connections
> KEEP the bare `connection_id` as their channel key and inbound URL —
> the composite `connID/<hash>` shape applies only to per-component store
> channels on endpoint-scoped connections. Consequences: existing
> deployments see zero re-keying, zero inbound-URL change, no reconnect
> blip, and no legacy sweep for pinned connections (invariants 1–2 in § 9
> become moot for them); the eviction hazard the composite key solves
> only ever existed for the new per-store case, which gets distinct URLs.
> The legacy-URL sweep survives in one narrow form: a per-store channel
> also deletes push connections targeting `/inbound/<connID>` on ITS
> store, covering a connection that was pinned and later unpinned. The
> `BucketConfig.ConnectionID` field now carries the feed key (the stream
> key) rather than strictly a connection id.

```
channelKey = connectionID + "/" + hex(sha256(
    store | format | filter | filterIgnoreCase |
    agg_window | agg_default(sorted) | agg_fields(normalized)
)[:8])
```

- **Stable across restarts** (pure config hash — a random component would
  orphan a push connection *and its persisted cursor* on ts-store every
  restart, permanently).
- **Normalized before hashing**: `agg_default` is comma-joined by checkbox
  order in the UI (`ConnectionDetailPage.jsx:1441-1454`), so `"avg,sum"` vs
  `"sum,avg"` must not open two channels — sort the list; parse+sort
  `agg_fields` likewise. Same lesson as `BucketConfig.ConfigKey()`'s
  sorted `ValueCols` (`aggregator.go:33-35`).
- **connectionID stays a visible prefix** (not hashed) so URLs, logs, and
  ts-store's connection list remain attributable to a profile, and the
  inbound route can keep a connection param for future auth.
- `format` is derived from the store's `data_type` (§ 1), so it is a
  channel-key input but not an authored value.
- The hash is computed **server-side only**. The client never mirrors it
  (avoids a third hand-synced key implementation — the `_aggStreamKey` /
  `ConfigKey` pair is already two).

### Keying changes

| Site | Today | Becomes |
|---|---|---|
| `manager.go:20-21` `streams`/`failed` | connectionID | channelKey |
| `manager.go:186-237` `createStream` | binds whole profile config once | resolves (store, push cfg) per channel; tsstore branch takes channel params |
| Inbound URL (`tsstore_stream.go:182`) | `/api/streams/inbound/<connID>` | `/api/streams/inbound/<connID>/<hash>` |
| `main.go:1106` route | `:connectionId` | `:connectionId/:channel` (legacy single-segment route kept — see migration) |
| `inbound_handler.go:22-23` maps | connectionID | channelKey (fixes the sharpest failure mode: two stores sharing a URL would silently evict each other's socket, `:87-91`) |
| `tsstore_stream.go:111/219/288` ts-store URLs | `config.StoreName` | channel's store |
| Stale cleanup (`:157-158`) | exact inbound-URL match | per-store list + match this channel's URL **and** the legacy path suffix `/api/streams/inbound/<connID>` (one-time orphan sweep for pre-upgrade push connections) |
| `aggregator.go:38` `ConfigKey` | includes ConnectionID | includes channel identity (connID + store); `registry.go:93` `FeedRecord` fed by channelKey |
| `multiplex_handler.go:196-201` `MultiplexAddSub` | `{Key, ConnectionID, Topics, Agg}` | + `Store string` (server resolves effective channel; the client-chosen `Key` stays a frame tag — `key`/`connID` are already separate fields, `:71-78`) |
| `streamConnectionManager.js` maps | streamKey = connectionId for raw | streamKey = `connId\|store` for tsstore raw (client-local fan-out key; precedent: synthetic `agg\|…` keys, `:245-283`) |
| `main.go:376` `InvalidateStream` hook | fires on profile edits only | component save with a changed `store` must also invalidate the affected channel (or simply let the old channel die via the 60s idle `cleanupLoop`, `manager.go:337-377` — **proposed: rely on cleanupLoop**, no new hook) |

### Sharing semantics **[decided in issue]**

Two components landing the same `(profile, store, agg-config)` **share one
channel**: `Manager.streams[channelKey]` is the dedup point — same refcounted
get-or-create + last-unsubscriber-teardown the `AggregatorRegistry` already
implements (`registry.go:38-84`). One `TSStoreStream` per channel → exactly one
push registration per distinct channel → exactly one aggregator per
(store, config) on the ts-store server. The output channel is **shared**
(multiplexed to N subscribers), never duplicated. ts-store#143 remains the
defensive backstop for misbehaving clients; Outpost does not depend on it.

### What does NOT force a channel split

`data_path` / `timestamp_field` / `StreamParserConfig` are applied client-side
after fan-out (`useData.js:102-152`, `:360`) and stay per-component. MQTT
topics keep their union semantics — untouched.

## 5. Push-aggregation config placement **[decided: staged]**

"Placement" = which record owns the `push.agg_*` settings (the "ts-store,
pre-aggregate before pushing to me" config), authored today in the profile
editor's Push section. Proposal: **stage it.**

- **This issue**: `push.*` stays authored on the profile, acting as the
  setting for every channel the profile opens (each per-store channel
  registers with the profile's agg config). Helper text at
  `ConnectionDetailPage.jsx:1358` changes from "These settings affect all
  charts using this connection" to "Push settings for all streaming charts on
  this connection (all stores)."
- **Later, if demanded**: a per-component `push_agg` override. The channel key
  **already hashes the agg config**, so the later change is additive — no
  second identity migration. That is the load-bearing part; the authoring
  surface can wait for a real use case.

## 6. tsstore-alerts extension

> Implemented in PR 3 as specified, with one narrowing: the schema store
> param landed as `GET /api/connections/:id/schema?store=` via a new
> `GetSchemaForStore` (existing AI/MCP callers keep the store-less
> signature and get the adapter's clear error on endpoint-scoped
> connections until they adopt the param).

Rule identity becomes `(connection_id, store, alert_id)` **[decided in
issue]**. Mechanics **[proposed]**:

- **Wire shape: `store` as a query param / body field**, not a path segment
  (store names aren't guaranteed slug-safe; the endpoints already take
  `connection_id` as a query param). `GET/DELETE /rules/:alert_id` gain
  `store`; `POST /rules` body gains `store_name`; `GET /probe` gains `store`.
  Required for endpoint-scoped profiles, defaulted from the pin otherwise —
  so existing clients/bookmarks keep working.
- **Aggregation**: `backendKey{BaseURL, StoreName}`
  (`tsstore_alert_rules_service.go:164-179`) becomes one key per
  (profile, store) pair — for a pinned profile that's current behavior; for
  an endpoint-scoped profile, `ListAll` enumerates its **manage-granted**
  stores via the adapter's `ListStores` (the `access` array makes this one
  call) and fans out per store. The six URL builders
  (`:275, :286, :352, :391, :480, :675`) take the store argument.
  `TSStoreFetchError` and `TSStoreConnectionRef` gain a store field.
- **Probe verifies `manage` for real**: the probe URL is the alerts list,
  which ts-store classes as `manage` — so `probe(connection_id, store)` is
  precisely the "can I create/manage alerts on this store" check. With the
  rc.2 `access` array the wizard can pre-filter the picker to manage-granted
  stores and keep the probe as the authoritative final check.
- **Wizard**: the "Store" FormGroup (`TsStoreAlertRuleEditorPage.jsx:486-560`)
  gains the third cell it was named for — a store ComboBox fed by
  `GET /api/connections/:id/stores` filtered to `manage`, shown when the
  profile is endpoint-scoped, fixed to the pin otherwise. The probe effect
  (`:197-208`), schema/field discovery (`:214-236`), clone prefill
  (`:152-177` — copy `src.store_name` too), and `handleCreate` payload
  (`:370-391`) all thread the store through.
- **List page**: row keys `${connection_id}|${alert_id}|${rule_name}`
  (`TsStoreAlertsExtensionPage.jsx:160`, `:369`) gain `store_name`; the
  Connection column already renders `store_name` as its second line — keep.
  View-page route gains `?store=` (`App.jsx:1042`, `TsStoreAlertRuleViewPage`
  reads store from the rule row, not `connection.config`).
- **Webhook receiver** (`webhook_handler.go:224-240`) **[decided in
  session]**: the payload-store == profile-store equality check only makes
  sense with a pin. Keep it for pinned profiles; for endpoint-scoped
  profiles, validate **payload `store_name` ∈ the key's manage-granted
  stores**, using the same per-(profile, store) cache the adapter keeps for
  `data_type` resolution (§ 1) — no per-webhook round-trip. Manage is the
  right set because a rule can only have been created on a manage-granted
  store. Two conscious edge choices: (a) a rule that keeps firing after its
  store's `manage` grant is revoked gets **rejected + logged** — a behavior
  change from "alerts always deliver," accepted because the rejection
  surfaces the zombie rule; (b) if the cache is cold and refresh fails,
  **fail-open** (accept + log) — the secret still gates, and
  defense-in-depth shouldn't cost deliveries. The check remains
  defense-in-depth, not authz: the per-connection secret authenticates, and
  a secret-holder can forge any store name (store names aren't secret).
  Secrets stay per-connection (minting per-store secrets buys nothing while
  the receiver route is `/webhooks/tsstore/{connection_id}`).

## 7. #186 interaction — store swap as a component variable **[follow-up, design-compatible]**

The multi-connection-swap design note (tag-value selection) is agreed but not
implemented; for tsstore, "swap store" should become a variable substitution
*within one endpoint-scoped profile*. This issue makes that possible but does
not build it:

- `params.store` is the substitution site; the `{{dashboard-variable}}` filter
  pipeline (`resolveFilterParam`, `substitution.go:103-115`) is the exact
  precedent for a later `resolveStoreParam` — token → chosen value, no value →
  error (endpoint-scoped requires a store; on a pinned profile the pin wins
  and the variable is inert).
- A variable-driven store needs one new runtime key alongside
  `dashboard_variable`/`range` in `ComponentDataRequest`
  (`models/component.go:157-160`) and `dataClient.js:64-96` when it lands.
- Streaming already works with it: a store change just resolves to a different
  channelKey; the old channel idles out via cleanupLoop.

File the store-variable as its own issue once #248 core lands; it shrinks the
tsstore case of #186 as intended.

## 8. AI / MCP surfaces

- **`connectionguidance/guidance.go:264-440`** — the shared `store.tsstore`
  guidance blob (feeds MCP, chat, and component agents): document pinned vs
  endpoint-scoped, `query_config.params.store` with an example, and that a
  pin cannot be overridden.
- **`ai/chat/tools_builtin.go:538`** — `query_connection` params description
  already enumerates `limit/filter/latest_by`; add `store`.
- **MCP `parseConnectionConfig` (`mcp/tools.go:1676`)** — hand-rolled decode
  already reads `store_name`; no new field, no change. Component
  `query_config` decodes field-complete via `decodeInto`; a params key needs
  nothing.
- **`schema_parity_test.go`** — fires only if `ChartQueryConfig` gains a
  field; the params approach adds none. (Deliberate — see § 1.)
- `ai/system_prompt.go:181, 284-285`, `ai/chat/prompt.go:97` — mention the
  store choice where tsstore query shapes are described.
- `make api-docs` regen picks up the swagger `required` change.

## 9. Migration / compatibility **[decided in issue]**

No boot migration. Compat invariants:

1. Existing pinned profile + existing components → effective store = the pin;
   REST URLs identical; **channel key differs from the old `connection_id`
   key only in shape** — handled by the legacy-URL stale sweep (§ 4), which
   deletes the pre-upgrade push connection (and its cursor) on first channel
   start. One reconnect blip per streaming profile on the first deploy, same
   as any server restart.
2. Legacy inbound route stays registered for one release so an old ts-store
   pusher that reconnects before the sweep runs doesn't hammer a 404.
3. Old server + new component config: a `params.store` on a pre-upgrade
   server is ignored by the adapter (unknown param) — harmless, reads the
   pinned store. No forward-compat hazard.
4. tsstore-alerts: store param optional-on-wire, defaulted from the pin, so
   existing clients/bookmarks keep working.

## 10. Out of scope (flagged, pre-existing)

- **Inbound WS route is unauthenticated** (`main.go:1104-1106`) and hardcodes
  `ws://` (`inbound_handler.go:252-254`). Predates this change; the channel
  hash makes URLs no more guessable than connection ids. Worth its own issue.
- **`TSStorePushConfig.From` and `.ConnectionID` are dead fields** (never
  honored / never written). Persisting the ts-store push id per channel would
  upgrade stale cleanup from URL-scan to exact DELETE — nice-to-have, not
  needed for correctness given the URL sweep. Fold into the ts-store#143 arc.
- **`cleanup` lock-hold during HTTP DELETE** (`tsstore_stream.go:473-492`)
  blocks Subscribe for up to 10s — worth fixing while the file is open, not a
  design item.
- **ts-store `/stats` is unauthenticated** (store-existence leak) — upstream
  ts-store concern, noted in the audit, not Outpost's to fix.
- **UI rename "connection" → "connection profile"** — raised in the design
  session; a product-wide terminology change with its own blast radius (the
  "connection" term was standardized after the datasource rename). Own issue
  if pursued.

## 11. Decision log (2026-08-12 session — nothing open)

- `store_name` is a **pin**, not an overridable default; endpoint-scoped =
  unset, store required per component (§ 1).
- `data_type` resolves per store on endpoint-scoped profiles; profile field
  is pinned-only back-compat (§ 1).
- Transport (rest/streaming) and protocol (http/https) stay profile-level;
  the component's only knob is the store (§ 1).
- Store-list `access` classes (ts-store#152, v0.20.0-rc.2) drive all
  dropdown/wizard filtering; empty listing on test = failure (§§ 0, 2, 3, 6).
- ws/mqtt push-connection endpoints reclassified `read` upstream (in
  flight), covering list/get/create/delete — streaming runs on read-only
  keys; only alert CRUD needs `manage` (§ 0).
- Alerts pattern: optional dedicated `read,manage` profile, isolated via a
  namespace granted only to alert admins; no new authz code (§ 0).
- Webhook store check = membership in the cached manage set (reject+log on
  revoked-grant zombies, fail-open on cache unavailability), not accept-any
  (§ 6).
- **Push-agg placement: staged** — authoring stays profile-level; the
  channel key hashes agg config now so a per-component override later is
  additive (§ 5).
- **Delivery: three stacked PRs** — (1) REST core: model + adapter threading
  + per-store data_type + discovery + Test + editor + AI/MCP, with streaming
  on endpoint-scoped profiles gated behind a clear error; (2) streaming
  channel identity (removes the gate; includes the cleanup lock-hold fix;
  pinned-profile regression coverage); (3) alerts extension. 1→2 and 1→3
  are hard dependencies; 2 and 3 are independent of each other. Chosen over
  one monolith because each stage has real users exercising it the moment
  it merges — the deliberate contrast with ts-store#138's one-PR rationale,
  where a half-landed auth rewrite had no one to exercise it.

## File pointers (primary)

- `server-go/internal/connection/tsstore.go` — dual adapter, 11 store-URL
  builders, Test, config schema
- `server-go/internal/connection/substitution.go` — reserved params, resolver
  precedent
- `server-go/internal/streaming/{manager,tsstore_stream,inbound_handler,aggregator,registry}.go`
  — everything in the § 4 table
- `server-go/internal/handlers/multiplex_handler.go` — `MultiplexAddSub`
- `server-go/internal/service/tsstore_alert_rules_service.go` — backendKey +
  six URL builders
- `server-go/internal/handlers/webhook_handler.go:224-240` — store equality
  check
- `client/src/pages/ComponentEditor.jsx` — tsstore branch `:3874-4031`, save
  spread `:2896-2901`
- `client/src/hooks/useData.js:451-491` — client-side param re-synthesis
- `client/src/utils/streamConnectionManager.js` — synthetic-key precedent
- `client/src/pages/TsStoreAlertRuleEditorPage.jsx:486-560` — wizard store
  FormGroup
- ts-store: `internal/middleware/auth.go:137-176` (access classes),
  `internal/handlers/store_handler.go` (`GET /api/stores` + `access` array,
  v0.20.0-rc.2)
