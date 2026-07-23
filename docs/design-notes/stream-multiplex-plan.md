# Issue #187 — Multiplex chart streams over one SSE connection

**Status:** plan (not started)
**Issue:** [#187](https://github.com/trv-enterprises/trv-outpost/issues/187) — HTTP/1.1 connection-pool starvation
**Related:** [`aggregation-sharing.md`](./aggregation-sharing.md), memory `sse-http1-pool-starvation`

## Problem recap

Browsers cap **6 concurrent connections per origin on HTTP/1.1**. The viewer
holds long-lived SSE/streaming connections:

- 1 × global events stream (`/api/events/stream`, tab-scoped).
- 1 × raw stream **per streaming connection** (`/api/connections/:id/stream`)
  — opened by `StreamConnectionManager`, already deduped so N charts on the
  same connection share one pipe.
- 1 × aggregated stream **per aggregated chart** (`POST
  /api/connections/:id/stream/aggregated`) — a direct `fetch`-stream in
  `useData`, **not** deduped, so each aggregated chart holds its own slot.

On a dashboard with several distinct connections and/or several aggregated
charts, held streams reach 6 and every remaining one-shot request (number-tile
`/query`, chart backfills, polling refreshes) queues **forever**. No errors;
completed requests all 200. Presents as "many/most panels stuck at Loading…".

Over HTTPS/h2 the limit vanishes (multiplexed), so prod-via-tailscale-hostname
is fine; plain-HTTP LAN/kiosk/docker-compose viewing is not.

## The design question: one pipe, or scale to many?

**Decision: one pipe. Do not add a second/Nth multiplex pipe as stream count
or payload volume grows.** The user's instinct is correct. Reasoning:

1. **The constraint is connection *count*, not bandwidth.** The 6-per-origin
   cap is about the number of open TCP/HTTP1.1 sockets, not bytes. All our
   streaming payloads share one origin and traverse the same network path
   regardless of how many logical pipes we open. Splitting across 2–3 SSE
   connections just re-consumes the very slots we're trying to free — it moves
   the ceiling from "6 streaming connections" to "6 − K", never removes it.

2. **A single SSE stream is not bandwidth-bound in our regime.** ts-store /
   MQTT record rates for dashboards are human-observation-rate (seconds per
   bucket, not microseconds). Even a busy 20-panel dashboard is a modest,
   bursty JSON trickle. One `text/event-stream` on one goroutine handles this
   with headroom; there is no serialization or write-contention wall we'd
   relieve by sharding.

3. **Multiple pipes add real overhead for zero win.** Each extra SSE stream is
   another server goroutine, another set of heartbeats, another reconnect state
   machine on the client, another auth/namespace-grant capture, and another
   fan-out registration — pure multiplicative cost over the same byte volume on
   the same path. It also reintroduces the exact resource we're rationing.

4. **HEAD-OF-LINE is not a concern here.** The usual reason to shard a single
   logical stream is head-of-line blocking (one slow/huge message stalling
   others). Our messages are small, independent, per-record JSON; there is no
   large-payload or ordering-critical message that would justify a dedicated
   lane. If a *future* feature introduces bulk transfers (e.g. large backfill
   dumps), those should be **one-shot HTTP requests** (which h2 multiplexes and
   h1.1 pools), not additional persistent streams.

5. **h2 already solves the "many streams" case for free.** Where genuinely many
   independent streams are wanted, the right lever is the transport (serve h2),
   not application-level pipe-sharding. Our own fix should be the one that helps
   the plain-h1.1 path *and* stays optimal under h2: collapse to one pipe.

**Where scaling *does* belong:** inside the single pipe. If we ever hit a
per-stream throughput wall (we won't at dashboard rates), the answer is
batching/coalescing records within the one stream (already have rAF batching
client-side; could add server-side coalescing), not a second socket. Capacity
grows by making the one pipe fatter/smarter, never by adding pipes.

> One-line answer for the issue: **single pipe is correct — the limit is
> socket count on one path, so more pipes re-spend the scarce resource while
> adding goroutine/heartbeat/reconnect overhead for identical bytes. Scale
> within the pipe (batch), or scale the transport (h2), never the pipe count.**

## Target architecture

One long-lived multiplex SSE stream per browser tab carrying **tagged** frames
for every connection/aggregator the tab is subscribed to. The client
`StreamConnectionManager` becomes the single owner of that one transport and
fans frames out to per-(connection|configKey) subscriber sets exactly as it
already fans out per-connection today.

```
                       ┌─ tab ────────────────────────────────────┐
  many chart hooks ──▶ │ StreamConnectionManager (singleton)       │
  (raw + aggregated)   │   subscribers: Map<streamKey, Set<sub>>   │
                       │   ONE EventSource ── /api/streams/multiplex│
                       └──────────────┬────────────────────────────┘
                                      │ tagged frames {key, event, data}
                       ┌──────────────▼────────────────────────────┐
  server               │ MultiplexHandler (one goroutine per tab)  │
                       │   dynamic subscribe/unsubscribe of:        │
                       │     raw:   StreamManager channels          │
                       │     agg:   AggregatorRegistry channels     │
                       │   merges all channels → tagged SSE frames  │
                       └────────────────────────────────────────────┘
```

Key: a **streamKey** identifies a logical subscription within the pipe:
- Raw: `raw:<connectionId>[:<topics>]`
- Aggregated: `agg:<configKey>` (reuse `BucketConfig.ConfigKey()`).

### The subscription-change channel

EventSource is GET-only and its URL can't change live. The tab's set of active
streams changes as panels mount/unmount. Two options:

- **A (recommended): control channel via a companion POST.** The multiplex GET
  opens the pipe and returns a `mux_session_id` as its first frame. The client
  POSTs subscribe/unsubscribe deltas to `POST /api/streams/multiplex/:sid/subs`
  (a one-shot request — pools/multiplexes fine, doesn't hold a slot). Server
  goroutine adds/drops upstream channels and starts tagging their frames.
  Buffer replay + `connected` are emitted per newly-subscribed key.
- **B: encode the full desired set in the GET URL and reconnect on change.**
  Simpler server, but every mount/unmount tears down and rebuilds the one pipe
  (debounced, like today's topic-reconnect). Acceptable but causes a
  reconnect-storm on dashboards that mount panels in waves, and momentarily
  drops *all* streams to re-add one. Prefer A; keep B as the fallback if the
  control-channel plumbing proves heavy.

Go with **A**. It mirrors the existing debounced-topic-reconnect intent but
without dropping unrelated streams.

## Implementation plan

### Server (`server-go/`)

1. **`internal/handlers/multiplex_handler.go` (new).**
   - `StreamMultiplex(c)` — opens the SSE response (same headers / write-
     deadline-disable / `connected` frame / 30s heartbeat boilerplate as
     `events_handler.go` and `stream_handler.go`). Generates `sid`, registers a
     per-session mux state (map `streamKey → {ch, cancel}`), emits
     `event: session\ndata: {"sid": "..."}`.
   - A `select` loop over: `clientGone`, `heartbeat`, a `frames` channel that
     every subscribed upstream channel feeds into (fan-in goroutine per key, or
     a `reflect.Select`/merged channel). Each frame written as
     `event: record\ndata: {"key":"<streamKey>","record":{…}}` (tagged).
   - `UpdateSubscriptions(c)` — `POST /:sid/subs`, body
     `{add:[{key,connection_id,topics?,agg?}], remove:[key]}`. For each add:
     enforce `checkStreamAccess` per connection (reuse the helper from
     `stream_handler.go`), subscribe the right upstream channel
     (`SubscribeAndGetChannel` / `SubscribeWithTopics` / aggregator registry),
     replay buffered records as tagged frames, wire the channel into the
     session fan-in. For each remove: unsubscribe + stop tagging.
   - Session lifetime = the GET's request context; on `clientGone`, unsubscribe
     every upstream channel and drop the session.

2. **Reuse, don't duplicate.** The per-key subscribe/replay/marshal logic is
   the body of `StreamConnection` and `StreamAggregatedConnection`. Extract the
   shared pieces (subscribe→channel, buffer-replay, record→JSON) into small
   helpers both the single-stream handlers and the mux handler call, so
   behavior can't drift. Keep the old single-stream endpoints working
   (Electron/`file://` and any external consumer may still use them; they're
   also the clean fallback if mux has a bug).

3. **Auth / namespace.** Each `add` runs the same `checkStreamAccess`
   (issue #4) the single-stream path runs. The mux GET itself only needs a
   valid user (like events). Grants are captured per-add off the POST request
   context — matches how events captures grants off its request context.

4. **Routes (`cmd/server/main.go`).** Register under the authed group:
   ```
   GET  /api/streams/multiplex          → StreamMultiplex
   POST /api/streams/multiplex/:sid/subs → UpdateSubscriptions
   ```
   (Sits alongside the existing `/api/streams/inbound/:connectionId`.)

5. **Swagger + Postman.** New handlers carry annotations; `make api-docs`
   regenerates. Required before release per project CLAUDE.md.

### Client (`client/src/`)

6. **`utils/streamConnectionManager.js` — become the sole transport owner.**
   - Replace per-`connectionId` `EventSource`s with **one** EventSource to
     `/api/streams/multiplex`. Keep the existing public API
     (`subscribe(connectionId, cb, {topics})`) intact so no call-site changes
     for raw streams.
   - Internally: `subscribers: Map<streamKey, Set<sub>>`. On first subscriber
     for a key, POST an `add` delta; on last-unsubscribe (after grace period),
     POST a `remove`. Debounce deltas exactly like today's topic-reconnect so a
     mount wave produces one POST.
   - Incoming frames carry `{key, record}`; route `record` to
     `subscribers.get(key)` and run the existing topic-filter + buffer logic
     **per key** (buffers become `Map<streamKey, […]>`). Heartbeat/`connected`
     semantics stay but are now pipe-global; per-key `onConnect` fires when its
     `add` is acked (server can echo an `event: subscribed\ndata:{key}` frame).
   - Token rotation: rebuild the one EventSource + re-POST the full current
     subscription set (the reconnect path already re-reads
     `streamAuthQuery()`).

7. **`hooks/useData.js` — route aggregated through the manager too.**
   - Add an aggregated subscription path on `StreamConnectionManager`
     (`subscribeAggregated(connectionId, bucketConfig, cb)` → streamKey
     `agg:<configKey>`; the client can compute the same configKey or let the
     server return it in the `subscribed` ack). Replace the direct
     `fetch`-stream block (lines ~484–...) with a manager subscription.
   - This folds the aggregated path into the one pipe and, as a bonus, delivers
     the **SSE-layer sharing** that `aggregation-sharing.md` lists as its
     priority follow-up (two charts with matching configKey now share the
     server aggregator's frames over one transport instead of one fetch-stream
     each). Note the overlap in that doc.

8. **Electron / `file://` caveat.** The comments in `streamConnectionManager`
   and `useData` note EventSource quirks under Electron's `file://` renderer
   and the reason aggregated uses `fetch`. Verify the multiplex EventSource
   works there (it should — it's the same EventSource the raw path already
   uses); if not, the mux GET can be consumed via the same `fetch`-stream shim
   the aggregated path uses today. Keep single-stream endpoints as the fallback.

### Verification

9. **Repro-driven.** The issue was reproduced headless (Chrome, plain HTTP,
   `nextHopProtocol: http/1.1`, 6 held SSE, 10 panels stuck). Re-run the same
   headless check against a rebuilt client on a ≥6-distinct-connection +
   aggregated-chart dashboard: expect **1** held streaming connection
   (`/api/streams/multiplex`) + the events stream = 2 slots, all panels load,
   `/query` and backfills no longer queue. Drive via puppeteer-core against the
   local dev viewer (per memory: I can drive headless Chrome myself).

10. **Functional parity.** Streaming charts update live; topic-filtered MQTT
    controls still receive only their topics; buffer replay on late-mount still
    works; aggregated charts still bucket correctly and now share; unmount
    drops the right upstream subscription (watch server logs for
    subscribe/unsubscribe balance); token rotation reconnects the one pipe and
    restores all subscriptions.

11. **Build gates.** `npm run build` (lint:strict + chart-spec + build.json
    bump), Go build, `make api-docs`.

## Scope / sequencing notes

- **Keep single-stream endpoints.** Non-breaking, and the honest fallback.
- **Two shippable stages if desired:**
  - Stage 1 — mux the **raw** streams only (biggest starvation contributor:
    one slot per distinct connection). Ship, verify against `docker-overview`.
  - Stage 2 — fold in the **aggregated** path (also lands agg SSE-sharing).
  Splitting lets Stage 1 relieve prod fast; Stage 2 is the completeness pass.
- **Not in scope:** connection-pooling / reconnect-delay work
  (`StreamConnectionManager connection pooling` backlog is separate), h2 infra
  (ops mitigation #2 in the issue — orthogonal, still worth doing).
- **Per project rules:** work on `main` unless this turns into a major rework;
  four doc surfaces on completion (architecture streaming doc + udoc manual +
  README/CHANGELOG as applicable + this note updated to "shipped");
  `aggregation-sharing.md` gets its priority follow-up marked done when Stage 2
  lands.
