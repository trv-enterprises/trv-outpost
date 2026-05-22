# Aggregation sharing on the dashboard server

## What this is about

The dashboard server has its own time-bucket aggregator that sits between
the raw streaming connection and the browser-side chart. This document
captures **what's shared today** at that layer, **what isn't**, and the
follow-up work needed to share more.

This is **distinct from** ts-store's own planned aggregation
([ts-store/design-notes/time-windowed-aggregation.md](../../../ts-store/design-notes/time-windowed-aggregation.md)),
which adds `agg_window` parameters to ts-store's REST/WS/MQTT outputs so
ts-store can pre-aggregate at the source before bytes ever leave it. The
two layers are siblings:

```
ts-store source ──┬── ts-store own aggregation (planned upstream — that doc)
                  │
                  └── raw stream ──> dashboard server
                                          │
                                          ├── dashboard BucketAggregator (this doc)
                                          │
                                          └── SSE per browser ──> useData per chart
```

Pushing aggregation all the way down to ts-store eliminates the need for
the dashboard's aggregator **in cases where the source supports it AND
every chart wants the same bucketing**. The dashboard's aggregator
remains relevant for:
- Ad-hoc bucketing the dashboard author configures per-component without
  reconfiguring the source.
- Non-tsstore streaming sources (MQTT brokers, WebSocket relays) that
  don't have aggregation primitives.

## How aggregation sharing works today

### The BucketAggregator + registry

When a chart component has a `timeBucket` config — `{interval, function,
value_cols, timestamp_col, series_col}` — its `useData` hook opens a
`POST /api/connections/<id>/stream/aggregated` SSE stream instead of
subscribing through the raw `StreamConnectionManager`.

On the server, `StreamHandler.StreamAggregatedConnection` calls
`AggregatorRegistry.Subscribe(bucketConfig)`
(`server-go/internal/streaming/registry.go`). The registry:

1. Computes a `configKey` from the bucket params (see below).
2. If an aggregator with that key already exists, returns a new
   subscriber channel on the same aggregator (the comment at line 15
   reads literally "Multiple subscribers with the same config share one
   aggregator").
3. Otherwise creates a new `BucketAggregator`, starts it, registers it
   in the map, and returns the first subscriber channel.

Raw records flow in via `registry.FeedRecord(connectionID, record)`,
called from `Stream.run()` for every record on every streaming
connection. The registry fans the record into every aggregator
registered against that connection ID. So **one raw record updates N
on-server aggregators in parallel.**

When the last subscriber on an aggregator unsubscribes, the aggregator
is stopped and removed from the map.

### What "the same config" means

`BucketConfig.ConfigKey()` (`server-go/internal/streaming/aggregator.go:31`)
hashes:

```
ConnectionID | Interval | Function | TimestampCol | SeriesCol | sorted(ValueCols)
```

Two charts share an aggregator only when **every one of those matches
exactly**. `ValueCols` is sort-normalized so column order doesn't break
the match.

### What's already shared at this layer

- The math (one rolling-bucket computation per matching configKey).
- The state (one set of in-memory buckets, one set of running sums/
  counts, etc.).
- The raw-record feed (one `ProcessRecord` invocation per aggregator,
  fanned in from the connection's single raw stream).

### What's NOT shared even when configs match

- **The SSE stream out to the browser.** Each browser-subscriber chart
  opens its own `POST /stream/aggregated` and gets its own dedicated
  `chan models.Record` from the aggregator. The aggregator fans the
  same bucket result into N channels; the handler serializes each
  bucket-record to JSON N times and writes it onto N separate SSE
  responses. Bytes-on-the-wire scale linearly with chart count even
  when math is shared.
- **The client-side React state.** `useData` is per-component; each
  chart maintains its own `data = {columns, rows}` array, its own rAF
  batch queue, and its own ECharts canvas. (Same constraint as the raw
  streaming path — different `data_mapping` per chart forces per-chart
  column projection.)

### What kills sharing entirely (different aggregators)

Any of:

- Different `interval` (60s vs 30s).
- Different `function` (avg vs max).
- Different `timestamp_col` (rare; usually `timestamp`).
- Different `series_col` (one chart partitions by `location`, the other
  doesn't).
- Different `value_cols` set (one chart wants `cpu.pct`, another wants
  `memory.pct`) — **this is the most common cause** of two charts on
  the same connection failing to share.

Two aggregators on the same connection are independent computations.

## Open follow-ups

### Priority — share at the SSE-stream layer

Today, two charts with matching `BucketConfig` share the aggregator but
each opens its own SSE stream. For a dashboard with N identically-
configured aggregate charts, this means N JSON-serializations and N
local HTTP streams for each bucket-record.

The right shape would mirror the browser-side `StreamConnectionManager`
pattern: a server-side broker that holds **one** outbound SSE stream
per (configKey, client-session) and fans bucket-records to the
browser's `useData` callbacks over a single transport. The browser
already has the multiplex infrastructure — the manager just needs an
equivalent for aggregated streams.

Concretely, look at:

- `client/src/hooks/useData.js` — currently builds its own POST request
  for aggregated; would need to route through `StreamConnectionManager`
  with an extra topic-like key (e.g. `agg:<configKey>`).
- `client/src/utils/streamConnectionManager.js` — add a notion of an
  aggregated subscription parallel to topic subscriptions.
- `server-go/internal/handlers/stream_handler.go::StreamAggregatedConnection` —
  could be unified with the raw stream handler if subscribers are
  identified by (connection_id, configKey) tuples.

This is purely a CPU/bandwidth win — it doesn't change correctness or
expand the feature surface. Worth doing after the system has multiple
dashboards in active use where the cost is measurable.

### Lower priority — share across slightly-different configs

Two aggregators on the same connection with different `ValueCols` could
in theory share if one is a strict superset. E.g. an aggregator over
`{cpu.pct, memory.pct}` could feed a virtual aggregator over `{cpu.pct}`
by projection. Adds substantial complexity (config-graph maintenance,
projection at fan-out) for a benefit that's usually small. **Not worth
doing unless we measure a real cost.**

### Lower priority — reconcile with ts-store upstream aggregation

When ts-store's own aggregation lands
([ts-store/design-notes/time-windowed-aggregation.md](../../../ts-store/design-notes/time-windowed-aggregation.md)),
some dashboards will be able to skip the dashboard-side aggregator
entirely by configuring the ts-store connection to deliver pre-
aggregated records. The dashboard's connection record (or per-component
override) would need a way to express "ask ts-store to aggregate this
for me," distinct from "configure a dashboard-side aggregator over the
raw stream."

There's a UX question buried here: when both sides can aggregate, the
dashboard author shouldn't have to think about which layer is doing it.
The right answer might be that the dashboard pushes aggregation to
ts-store **when the source supports it AND no two charts on the same
dashboard have different bucket params over the same connection** —
otherwise fall back to the dashboard-side aggregator. Decide when both
layers are in place; don't pre-design.

## File pointers

- `server-go/internal/streaming/registry.go` — `AggregatorRegistry`,
  the singleton that dedups aggregators by `configKey`.
- `server-go/internal/streaming/aggregator.go` — `BucketConfig`,
  `BucketAggregator`, `ConfigKey()`.
- `server-go/internal/handlers/stream_handler.go::StreamAggregatedConnection` —
  HTTP entry point; one SSE response per client subscriber.
- `server-go/internal/streaming/stream.go::Stream.run` (around 304) —
  raw records pumped into `registry.FeedRecord` on every record.
- `client/src/hooks/useData.js` — the consumer side; routes to
  aggregated or raw streaming based on whether `timeBucket` is set on
  the component.
- `client/src/utils/streamConnectionManager.js` — the browser-side
  manager for raw streams; the model the SSE-layer sharing follow-up
  would mirror.
