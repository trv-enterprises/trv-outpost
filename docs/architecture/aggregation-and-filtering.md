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
│  retained-state cache.                                       │
│  Use when source can't filter (MQTT) or when multiple        │
│  charts share an upstream stream and need different views.   │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│  Layer 3 — Chart (data_mapping)                              │
│  filters, aggregation, time_bucket, series, group_by,        │
│  sort_by, limit.                                             │
│  Use for interactive UX (changing a bucket without touching  │
│  source config), or when a chart needs a final shape that's  │
│  cheap to compute on a small batch.                          │
└──────────────────────────────────────────────────────────────┘
```

## Per-source-type capability

| Source        | Aggregation                               | Filtering                                   | Schema discovery                          |
|---------------|-------------------------------------------|---------------------------------------------|-------------------------------------------|
| **SQL**       | `GROUP BY` + `SUM/AVG/COUNT/...`          | `WHERE`, parameterized                      | Native — `information_schema`, sample rows |
| **Prometheus**| Built-in operators: `sum / avg / min / max / count`, with `by (...)` / `without (...)` to control label retention | Label matchers in `{...}`; boolean filters via `> 80`; `topk / bottomk` | None for a specific expression — `/api/v1/labels` is global, only post-hoc inspection of returned `metric: {}` |
| **ts-store**  | Push connection's `agg_window` + `agg_default` (avg/min/max/sum). One bucketed series per push connection. | None pre-push — every record flows; consumer filters chart-side | Schema endpoint per store; columns and types are known |
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
