# Aggregation and filtering

Two questions that come up every time we add a connection type or
change AI behavior:

1. **Where should aggregation happen** — at the data source, in the
   dashboard server, or in the chart?
2. **Where should filtering happen** — same three layers.

This document captures the current model so we don't accidentally
violate it when adding features. The rule of thumb up front:

> Push aggregation and filtering as close to the source as the source
> can express it. Every layer up the stack increases bytes on the wire
> and CPU on the dashboard server. Only fall back to a higher layer
> when the source can't express what's needed, or when the user is
> driving an interactive change that shouldn't round-trip to source
> config.

## The three layers

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 1 — Source                                            │
│  PromQL, SQL, ts-store push config, MQTT broker filters      │
│  Best place. Smallest result set on the wire.                │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│  Layer 2 — Dashboard server                                  │
│  Stream parser (`data_path`), aggregator registry,           │
│  retained-state cache, `time_bucket` (BucketAggregator).     │
│  Use when source can't filter (MQTT) or when multiple        │
│  charts share an upstream stream and need different views.   │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│  Layer 3 — Chart (data_mapping)                              │
│  filters, aggregation, sliding_window, latest_by, series,    │
│  group_by, sort_by, limit.                                   │
│  Use for interactive UX (changing a bucket without touching  │
│  source config), or when a chart needs a final shape that's  │
│  cheap to compute on a small batch.                          │
└──────────────────────────────────────────────────────────────┘
```

### Layer 3 output shape: rows vs. a scalar

`transformData` (`client/src/utils/dataTransforms.js`) runs its stages in a
fixed order:

**sliding window → latest-by → filters → sort → limit → aggregation**

That order is load-bearing at three points:

- The **sliding window runs first** because it *bounds* everything downstream.
  It is what makes "average over the last 5 minutes" expressible, and it is
  what makes "newest" meaningful for latest-by — a series that stopped
  reporting outside the window drops out instead of surviving with a stale
  row presented as current state.
- **latest-by runs before `limit`.** Reversed, the limit would truncate the
  buffer before the dedupe and silently drop whole series — a `limit: 5` would
  return five samples of one disk rather than one row for each of five disks.
- **Aggregation runs last**, over the already-reduced set. On a latest-by
  component that means `avg` averages the current value *across* series, not
  each series' history.

The editor's Data Mapping tab lists these sections in this same order, under a
"Client-side processing" heading, so the UI reads the way the pipeline runs.
Keep the two in step when adding a stage.

The aggregation stage returns **two** things, and which one a chart should
read depends on the aggregation type:

| Aggregation | `rows` | `aggregatedValue` |
|---|---|---|
| `first` / `last` | sliced to 1 | null (unless an explicit field is set) |
| `avg` / `min` / `max` / `sum` / `count` | **unchanged** | the scalar |
| `limit` | sliced to N | null |
| none | unchanged | null |

The middle row is the trap: those five types leave `rows` completely
untouched and put their result in a separate field. A chart that reads
`rows[0]` therefore renders the first raw sample while the author believes
they configured an average — computed correctly, then dropped on the floor.

**Single-value charts must read `aggregatedValue` first.** `gauge` and `value`
do this via `singleDisplayValue()` in `chart-spec/option-helpers.js`, falling
back to row 0 when there's no scalar. Multi-row charts (line, bar, …)
deliberately keep consuming `rows` — an aggregate scalar has no meaning on a
series.

Two related constraints on single-value types:

- The aggregation **Field** is pinned to the value column in the editor. Left
  blank, `applyAggregation` returns `value: null` and the chart silently falls
  back to row 0; pointed at another column, it aggregates data the chart never
  displays. Neither surfaces an error, so the editor removes the choice
  instead of validating it.
- The value chart's **text/number detection reads the raw cell**, never the
  aggregate. An aggregate is always numeric, so deciding from it would flip a
  text column onto the numeric path and render a row count where a status
  string belongs.

> **Open:** which of filters / aggregation / sliding window are coherent for a
> given `(component type, connection type)` pair is currently expressed by two
> independent mechanisms that don't compose — per-type flags in
> `CHART_TYPE_CONFIG` and a single `queryLanguageOwnsClientSideOps` gate for
> SQL/EdgeLake. Aggregation has no well-defined time bound on polled
> connections, and the sliding window silently empties a chart when timestamps
> aren't wall-clock-current. See issue #222.

## Per-source-type capability

| Source        | Aggregation                               | Filtering                                   | Schema discovery                          |
|---------------|-------------------------------------------|---------------------------------------------|-------------------------------------------|
| **SQL**       | `GROUP BY` + `SUM/AVG/COUNT/...`          | `WHERE`, parameterized                      | Native — `information_schema`, sample rows |
| **Prometheus**| Built-in operators: `sum / avg / min / max / count`, with `by (...)` / `without (...)` to control label retention | Label matchers in `{...}`; boolean filters via `> 80`; `topk / bottomk` | None for a specific expression — `/api/v1/labels` is global, only post-hoc inspection of returned `metric: {}` |
| **ts-store**  | Push connection's `agg_window` + `agg_default` (avg/min/max/sum). One bucketed series per push connection. | REST mode: substring `filter` (+ `filter_ignore_case`) and `latest_by` (newest record per distinct value). Neither is available on the push/streaming transport — those consumers filter and reduce chart-side. | Schema endpoint per store; columns and types are known |
| **MQTT**      | None at the broker                        | Topic-level subscription only; no value-level filtering | None — payload shape is whatever the publisher sent; learned by inspection |
| **REST API**  | Whatever the upstream API supports        | URL params / request body, fully API-specific | API-specific; treat as opaque |
| **WebSocket** | None at protocol layer                    | Connection-level parser (`data_path`) carves a slice; no value filter | None — payload shape is publisher-defined |

## Why "push to source" matters

Three concrete examples from this codebase:

1. **ts-store `agg_window`**: a 10-second push window means ts-store
   itself averages 600 raw samples per minute into 6 averaged records.
   The dashboard server sees 6 records on the wire, not 600. This is
   why ts-store push connections expose `agg_window` and `agg_default`
   as first-class config — the bandwidth and CPU savings are
   substantial on long-lived dashboards.

1b. **ts-store `latest_by` — the same reduction at two tiers**:
   "one row per disk" can be expressed either as a ts-store query param
   (`query_config.params.latest_by`, Layer 1 — ts-store returns one
   record per distinct value and the wire carries N rows instead of the
   whole buffer) or as `data_mapping.latest_by` (Layer 3 — the browser
   reduces already-fetched rows). **Prefer Layer 1 whenever the
   connection can reach it.** The Layer 3 twin exists because a ts-store
   *streaming* connection cannot: the push transport takes no query
   params, so a live per-disk table has nowhere else to do the
   reduction. Same semantics, chosen by what the transport allows —
   not a duplicate implementation.

   Setting both is harmless (the second reduction is a no-op on an
   already-reduced set) but redundant; the editor surfaces an
   informational note rather than blocking it, since keying the two on
   *different* columns is a legitimate, if unusual, thing to express.

2. **PromQL `avg(...)` vs no aggregation**: a query like
   `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes`
   returns one series per scraped instance — every time it's
   evaluated. Wrap it in `avg(...)` and the result is one row, every
   time. The data table modal reflects this faithfully (see
   `node_memory_usage_gauge` vs `node_cpu_usage_gauge` for a side-by-
   side that confused us into thinking it was a UI bug).

3. **SQL `WHERE` vs chart-side filter**: filtering 10M rows down to
   100 with `WHERE timestamp > NOW() - INTERVAL '1 hour'` ships 100
   rows. Filtering chart-side ships 10M rows and CPU-burns the
   browser.

## When to do it server-side or chart-side anyway

Source-side isn't always available or appropriate:

- **MQTT** has no broker-level filter beyond topic subscription. Any
  value-level filtering happens chart-side. The connection-level
  parser (`data_path`, `timestamp_field`) helps shape the record but
  doesn't filter.

- **Multiple charts share one stream**. The dashboard server's stream
  manager keeps a single upstream subscription per `(connection,
  topic-set)` and fans out to subscribers. If two charts on the same
  ts-store push need different bucketings, the bucketing has to
  happen *after* the fan-out — server-side or chart-side. We picked
  server-side via the aggregator registry (`internal/streaming/`).

- **Interactive UX**. Changing a chart's `time_bucket` from 1m to 5m
  shouldn't ALTER the underlying SQL or PromQL or push config —
  that's a per-user view preference, not a data-source change.
  Chart-side `data_mapping.time_bucket` is the right home.

  > **`time_bucket` is configured per component but EXECUTES on the
  > server** (Layer 2), in `internal/streaming/aggregator.go`'s
  > `BucketAggregator`, against the live stream. It has no
  > implementation in `dataTransforms.js` and is not part of the
  > client-side stage order above. The editor groups it under
  > "Server-side processing" for exactly this reason — it changes what
  > data reaches the browser, not just what the browser renders.

- **Discovery / one-off introspection**. The SQL connection editor
  lets users sample rows to pick column names. That's a chart-side
  concern by definition (it's UX, not pipeline).

## Implications for the AI builder

The "configure first, custom-code last" policy already pushes
aggregation into `data_mapping`. Layer it with this:

1. **For SQL and Prometheus**: prefer source-side aggregation in the
   query the user provides. The AI should *not* generate a chart that
   reads a million rows and then aggregates with `data_mapping` — it
   should generate a query with `GROUP BY` (SQL) or
   `avg by (...)` (PromQL).

2. **For ts-store**: configure `agg_window` on the push connection
   if the chart's bucketing matches. If the user wants a different
   bucket per chart on the same connection, fall back to chart-side
   `time_bucket`.

3. **For MQTT and WebSocket**: source can't aggregate. Use the
   connection-level parser to shape the record, then chart-side
   `aggregation` + `time_bucket` for any windowing.

4. **Filtering**: same priority. If SQL, use `WHERE`. If PromQL, use
   `{label="value"}`. If MQTT, choose a narrow topic, then filter
   chart-side.

5. **Anti-pattern**: do not generate `set_custom_code` to perform
   aggregation that `data_mapping` could express, and do not add
   chart-side aggregation when the source could express it.

## What this means for new connection types

When adding a new connection type, ask:

1. Can it aggregate at the source? (Document the syntax in the
   adapter and expose it through whatever query/config UI we have.)
2. Can it filter at the source? (Same.)
3. Can it report its schema? (If yes, wire it into the connection
   editor's discovery UI. If no, document why, like MQTT.)
4. If aggregation is unavailable at the source, does it make sense
   to add server-side aggregation in the streaming layer? (We did
   this for ts-store push because the source supports it natively.
   We did not for MQTT because MQTT brokers don't aggregate at all
   and putting it server-side would cement an arbitrary scheme.)

## Cross-references

- [`connections.md`](connections.md) — adapter and capability model
- [`streaming.md`](streaming.md) — stream manager, fan-out, and the
  aggregator registry
- [`data-model.md`](data-model.md) — `data_mapping` field reference
  on the chart side
- [`backend.md`](backend.md) — service / handler layering
