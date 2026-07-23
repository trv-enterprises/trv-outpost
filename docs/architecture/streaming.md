# Streaming subsystem

Real-time data flows from external sources (MQTT brokers, ts-store,
WebSocket endpoints) through the backend's streaming subsystem and
out to the browser over SSE. The same subsystem also handles
aggregation, topic-level filtering, and retained-state replay for
returning subscribers.

## High-level flow

```
External source       Backend                          Browser
──────────────        ────────                         ───────
MQTT broker     ─▶  MQTTStream                   ──▶  StreamConnectionManager
                      │  (ring buffer)                  │  (1000-record buffer)
                      │  (latestByTopic cache)          │  (grace period on reconnect)
                      │                                 │
                      ▼                                 ▼
                    StreamManager                     Subscriber callbacks
                      │  (per-connection streams)      (Weather, Frigate alerts,
                      │  (reference-counted subs)       controls, charts)
                      ▼
                    multiplex_handler.go
                      │  GET /api/streams/multiplex        (ONE per tab)
                      │  POST /streams/multiplex/:sid/subs (add/remove)
                      ▼
                    tagged SSE frames ─────────────▶   ONE EventSource
                      {key, record}                     (fans out per key)
```

> **One pipe per tab, not per connection.** All of a browser tab's
> streaming subscriptions ride a single multiplexed SSE connection.
> This is what keeps a dashboard with many streaming connections under
> the browser's 6-per-origin HTTP/1.1 cap — see [SSE handler](#sse-handler)
> and [Client-side connection manager](#client-side-connection-manager)
> below, and the design note
> [`stream-multiplex-plan.md`](../design-notes/stream-multiplex-plan.md)
> (issue #187). The per-connection single-stream endpoint
> (`GET /api/connections/:id/stream`) is retained as a fallback.

## Stream manager

`internal/streaming/manager.go` owns one long-lived stream per
datasource. When a handler calls `SubscribeWithTopics(datasourceID,
topics)`:

1. Look up or create the stream for that datasource
2. Call the stream's per-type `SubscribeWithTopics` which returns a
   new `chan Record`
3. Return the channel to the caller

When the caller's channel is dropped (because the SSE client
disconnected), the handler calls `manager.Unsubscribe(datasourceID,
ch)`. The manager decrements topic reference counts and, if a topic
has no remaining subscribers, asks the underlying stream to
unsubscribe from it at the broker.

Streams themselves persist even when their subscriber count hits
zero, so reconnecting doesn't incur a full broker-handshake delay.
Long-idle streams get torn down by a background sweep.

## MQTT stream

`internal/streaming/mqtt_stream.go` is the per-connection MQTT
client. It uses `github.com/eclipse/paho.golang/autopaho` to
maintain the TCP connection to the broker, survive network
interruptions, and handle reconnect logic.

### Data structures

```go
type MQTTStream struct {
    datasourceID  string
    cm            *autopaho.ConnectionManager
    subscribers   []*mqttSubscriber      // channels, one per SSE client
    topicRefs     map[string]int         // ref count per topic filter
    buffer        *RingBuffer            // recent time-series records
    latestByTopic map[string]models.Record // retained-state cache
    // ...
}
```

### Ring buffer

Short time-series memory. Every received message gets pushed into
the buffer (default size 100). When a new SSE client subscribes, the
handler flushes a topic-filtered slice of the buffer to the client
as the first batch of events. Gives late subscribers an
immediately-visible history on components that plot time-series
data.

The buffer is shared across all subscribers and all topics on the
same datasource, so a chatty topic can evict older messages from
quieter topics. The retained-state cache exists specifically to
paper over this race.

### Retained-state cache

`latestByTopic` is a per-topic map of the most recent record seen
for that topic. Every incoming message updates the map under the
same write lock that fans out to subscribers, so a subscriber's
snapshot is guaranteed to be consistent with live updates.

When a new subscriber registers through `SubscribeWithTopics`, the
cache is snapshotted for the subscriber's matching topic filters and
the matching records are pushed into the new channel **before the
function returns**. This handles two cases that the broker alone
can't:

1. **Another subscriber already holds the topic.** `topicRefs > 0`,
   so `subscribeBrokerTopics` is skipped and the broker never
   re-delivers its retained message. Without the cache, the new
   subscriber would wait until the next publish.

2. **Ring-buffer eviction.** Another dashboard pushed 100+ records
   through the shared buffer, evicting the last weather reading.
   When the user returns, the buffer flush returns nothing for
   weather topics. Without the cache, the new subscriber would wait
   for the next weather publish (many minutes).

With the cache, Weather and garage-door contact sensors repopulate
in < 1 s after a dashboard switch.

Memory cost is one `Record` per unique topic the stream has seen —
dozens at most in a homelab setup.

### Fan-out

When a message arrives from the broker, `handleMessage` does four
things (atomically under the write lock):

1. Update `latestByTopic[topic] = record`
2. Push into the ring buffer
3. Feed the record to bucket aggregators (see below)
4. Fan out to all subscribers whose topic filters match this
   topic. Sends are non-blocking (`select { case sub.ch <- record:
   default: }`) so a slow subscriber never stalls the broker reader.

### Aggregators

A subscriber can ask for a time-windowed aggregation of a topic
instead of raw records — e.g. "1-minute averages over 15 minutes".
The streaming engine maintains a small aggregator registry
(`internal/streaming/aggregator.go`) keyed on datasource + topic +
window, and the MQTT stream feeds every record into matching
aggregators before returning. The aggregator emits a derived record
on a time tick.

Used for: chart data that would otherwise flood the browser with
hundreds of messages per second.

## TSStore stream

`internal/streaming/tsstore_stream.go` is the ts-store
counterpart. ts-store is a time-series circular-buffer store; it
exposes a WebSocket push endpoint and a JSON pull API, plus a
schema-discovery endpoint. The stream handles both modes and shares
the same `chan Record` subscriber interface as the MQTT stream.

ts-store doesn't have a "retained state" concept the way MQTT does
(every record is timestamped and falls out of the circular buffer
when full), so there's no `latestByTopic` cache. Subscribers that
need initial data get a bounded time-range pull when they connect.

### Backfill & per-value history

A streaming panel paints initial history with a one-shot REST
backfill before the live stream takes over (`client/src/hooks/useData.js`,
`runBackfillThenConnect`). The backfill query is one of three shapes:

- **Count-based** — `{ raw: 'newest', params: { limit: N } }`. Pulls
  the newest *N* records, **unfiltered at the source**.
- **Time-based** — `{ raw: 'since:<window>' }`. Pulls *every* record in
  the time window. Emitted automatically when the panel has a
  **sliding window** set. (The sliding window itself remains a
  *render-time* filter — it sizes this backfill but never trims the
  live buffer.)
- **Range-driven** — `{ raw: 'newest', params: { range } }` when a
  dashboard **range variable** is active. The client passes the range
  INTENT through unchanged; the server (`resolveRange` /
  `tsstoreRangeFromSpec`) expands it to the dialect's `since:`/`range:`
  form plus the clamped **step**, so the step budget is enforced in one
  place. A range change alters the serialized backfill
  (`effectiveBackfillKey`), which clears the buffer, re-arms the
  backfill latch, and re-backfills at the new window without
  duplicates. Row order is **detected from the data's timestamps**, not
  assumed per endpoint (plain `newest` returns newest-first;
  `since:`/`range:`+step return oldest-first), and the leading epoch-0
  bucket a stepped pull can emit is dropped. An **absolute** range is a
  closed past window: the panel renders the backfill statically and
  never subscribes to the live stream (historical mode); a relative
  range keeps the live tail on the **shared raw stream** — a per-chart
  aggregated-SSE cut was tried and reverted (one SSE per chart
  saturates HTTP/1.1's per-host cap); matching the live tail to the
  step is deferred to a configKey-shared aggregated stream (#84).
  While a range is active the client buffer cap rises from the
  `stream_buffer_size` default to the range point budget
  (`TSSTORE_MAX_POINTS`) so a wide window isn't re-clipped.

These are different contracts, and the difference matters when a panel
is filtered by a **dashboard variable**:

> **Recommended topology: one connection per numeric source.** True
> numeric machine time-series should relate to a single source — a
> separate ts-store / connection per machine. Mixing many sources into
> one stream complicates sequence integrity and backfill.
>
> **The shared-stream exception (dashboard variables).** The
> dashboard-variable feature exists precisely to slice a stream the user
> *doesn't* control the topology of (one connection, many values; the
> variable picks one). Two ways to keep per-value history complete:
>
> 1. **Source-side filter (preferred).** Bind the ts-store `filter`
>    param to the dashboard variable (the Filter row in the editor's
>    Query section, set to "Dashboard variable"). ts-store's `filter` is
>    a substring match that **counts matches, not candidates** — so a
>    filtered `newest <N>` returns *N records of the selected value*, and
>    the same filter rides on the backfill query. No sparsity, with or
>    without a window. (The filter is not field-scoped, but these data
>    sets carry few label fields, so a substring isolates a source
>    reliably.) The literal `{{dashboard-variable}}` token is stored;
>    `resolveFilterParam` in the Go adapter swaps it for the chosen value
>    at query time, on both the REST and websocket paths.
> 2. **Sliding window.** A time-based `since:<window>` backfill returns
>    every record in the window for *every* value, so each selected value
>    gets full history even though the client filter still does the
>    final narrowing.
>
> Without either, a client-side-only variable filter on an unfiltered
> count-based `newest <N>` gets thinned to ≈ *N/M* records for the
> selected value when the stream interleaves *M* values — sparse initial
> history. (Issue #18.)

The editor surfaces an inline hint on exactly this at-risk shape
(tsstore-streaming + client-side variable filter + no source filter + no
window), pointing to the source-side Filter or a window. Polling / SQL /
API panels re-query per value and never have this problem.

### Backfill sharing & superseded-run safety

N identical panels on one connection used to fire N identical backfills
at mount, overloading slow sources. `queryBackfillShared`
(`client/src/api/dataClient.js`) dedups them: the key is
`connectionId + JSON.stringify(query)`, concurrent identical calls join
one in-flight request, and a 10-second TTL cache lets a panel that
mounts moments later reuse the result. Panels backfilling a *different*
window get their own fetch — the key carries the full query, so
correctness is preserved. Sharing is semantically safe because a
ts-store backfill carries no per-panel column projection; each panel
maps its own columns from the shared row set and never mutates it.

Two guards keep async backfills honest across effect re-runs in
`useData`:

- **Per-run `cancelled` flag.** `mountedRef` is shared by every run of
  the stream effect and re-armed by each new run, so it cannot detect
  that a run was *superseded* (e.g. a connection-swap value restoring
  after mount repointed the panel). Each run closes over its own
  `cancelled`, set only by that run's cleanup, and checks it after the
  backfill await and before any subscribe — a stale backfill is
  dropped instead of appending the old connection's rows and
  subscribing a live stream nothing will ever unsubscribe.
- **Latch after the fetch.** `backfillDoneRef` (the once-per-lifecycle
  backfill latch) is set *after* the fetch resolves, not before — a run
  cancelled mid-fetch leaves the latch open so its replacement
  re-fetches (this also covers React StrictMode's dev double-mount).
  Duplicate wire calls are prevented by the dedup above, not the latch.

## SSE handler

### Multiplex handler (the default browser transport)

`internal/handlers/multiplex_handler.go` carries **every** raw
streaming subscription a browser tab needs over **one** long-lived SSE
connection. This is the default path the client
`StreamConnectionManager` uses; it exists to defeat the browser's
6-per-origin HTTP/1.1 connection cap (issue #187 — before it, one
EventSource per distinct connection meant a dashboard spanning >5
streaming connections exhausted the pool and every remaining request,
including tile queries and backfills, queued forever).

Two routes:

- **`GET /api/streams/multiplex`** — opens the pipe. Emits an
  `event: session\ndata: {"sid":"…"}` frame first (the session id used
  to mutate subscriptions), then tagged `event: record\ndata:
  {"key":"<connectionId>","record":{…}}` frames for every subscribed
  connection, plus a 30 s heartbeat. One goroutine per tab holds a
  fan-in channel that each per-subscription pump writes into; a full
  buffer drops the frame rather than stalling other subscriptions
  (mirrors the non-blocking broadcast in `streaming.Stream`).
- **`POST /api/streams/multiplex/:sid/subs`** — mutates the pipe's
  subscription set with `{add:[{key,connection_id,topics?}],
  remove:[key]}`. A one-shot request (pools/multiplexes fine, holds no
  persistent slot). EventSource is GET-only and can't change its URL
  live, so subscription changes as panels mount/unmount go over this
  companion POST rather than reopening the pipe. Each `add` runs the
  same namespace-grant check the single-stream door runs, verifies the
  connection streams, subscribes the upstream channel, replays its
  ring buffer as tagged frames, and emits an `event: subscribed\ndata:
  {"key":…}` ack.

Both routes match the `/stream` read carve-out in
`middleware/auth.go::getRequiredCapability` — no capability gate; the
per-connection namespace grant is enforced in-handler.

### Single-stream handler (fallback)

`internal/handlers/stream_handler.go` is the original one-SSE-per-
connection endpoint, kept as a fallback (Electron `file://`, external
consumers, and a clean bypass if the multiplex path ever misbehaves).
`GET /api/connections/:id/stream?topics=foo,bar`:

1. Validate the connection ID and confirm the type supports
   streaming.
2. Parse the `topics` query parameter into a topic-filter slice.
3. Call `manager.SubscribeWithTopics(...)` to get a channel.
4. Set SSE headers (`text/event-stream`, `no-cache`, disable nginx
   buffering).
5. Flush a topic-filtered slice of the ring buffer (via
   `GetBufferFiltered`) as the first batch of events.
6. Enter a `select { case record := <-ch: ...; case <-heartbeat:
   ...; case <-clientGone: cleanup(); }` loop that writes each
   record as an `event: record\ndata: {...}\n\n` SSE frame.

Heartbeat frames go out every 30 seconds so proxies don't close idle
connections, and so the client's heartbeat watchdog can detect stalls.
Both handlers share the same underlying `StreamManager` subscribe /
ring-buffer machinery — the multiplex handler just tags each frame with
its connection key and merges many channels onto one response.

> **Aggregated streams are not multiplexed yet.** The aggregated path
> (`POST /api/connections/:id/stream/aggregated`, see
> [Aggregators](#aggregators)) is still a dedicated stream per
> aggregated chart. Folding it into the multiplex pipe is stage 2 of
> issue #187; see [`stream-multiplex-plan.md`](../design-notes/stream-multiplex-plan.md).

## Client-side connection manager

`client/src/utils/streamConnectionManager.js` is a singleton on the
frontend. It owns **one** multiplexed `EventSource`
(`GET /api/streams/multiplex`) for the whole tab and fans its tagged
frames out to per-connection subscriber sets. Multiple components can
subscribe to the same connection at once — their topic filters are
combined, and records are routed to subscribers by client-side topic
matching. The public API (`subscribe(connectionId, cb, {topics})`) is
unchanged from the pre-multiplex era; only the transport moved.

Key behaviors:

- **One EventSource per tab (not per connection).** Every streaming
  connection the tab needs rides the single multiplex pipe. A
  dashboard spanning ten connections holds one streaming socket, not
  ten — this is the client half of the issue #187 fix. Per-connection
  subscriptions are added/removed over the pipe with debounced
  `POST /api/streams/multiplex/:sid/subs` deltas (a mount wave produces
  one POST), keyed by `connectionId` (the `streamKey`).
- **Session-driven (re)subscribe.** The pipe's first `session` frame
  supplies the `sid`; deltas queued before it arrives are flushed once
  it does. On token rotation, heartbeat-timeout, or a `404` (server
  session gone), the pipe reopens with a fresh `sid` and the **full
  desired subscription set** is re-sent — so unrelated connections are
  never dropped by one connection's change.
- **Topic-diff re-subscribe.** When a connection's combined topic set
  changes (dashboard switch, component unmount), the manager
  re-subscribes just that `streamKey` on the pipe (remove+add in one
  POST) to change the broker-level filter. Other connections on the
  pipe are untouched — no whole-pipe reconnect.
- **30-second grace period.** When the last subscriber on a connection
  drops, the manager waits 30 s before dropping that connection's pipe
  subscription. Arriving subscribers within that window reuse it — the
  common case when the user flips between dashboards. When the last
  connection goes away entirely, the pipe itself is closed so no idle
  SSE socket lingers.
- **Client buffer.** A ring buffer per connection on the client side
  (capped at the `stream_buffer_size` admin setting, default 1000),
  filled from tagged `record` frames and flushed to new subscribers on
  mount (the client-side analog of the backend buffer flush). Panels
  that run a REST backfill opt out of the replay (`skipBufferReplay`) —
  the backfill is the authoritative history and replaying on top of it
  would duplicate records. Panels under an active dashboard range raise
  their own in-hook cap to the range point budget instead (see
  "Backfill & per-value history").
- **Pipe-level heartbeat watchdog + backoff.** If 60 s pass without any
  frame (not even a heartbeat), the manager tears the one EventSource
  down and reopens with exponential backoff — one reconnect covers
  every subscribed connection. Subscribers see `onDisconnect` /
  `onReconnecting` during the gap.

> The **aggregated** stream path (`useData` charts with a `timeBucket`)
> still opens its own `POST …/stream/aggregated` fetch-stream and is
> **not** on the multiplex pipe yet — stage 2 of issue #187.

## Related docs

- [Connections](connections.md) — per-type adapter details, including
  MQTT publishing and Frigate review proxying
- [Backend architecture](backend.md) — where `streaming/` sits in the
  overall directory layout
- [Frontend architecture](frontend.md) — how
  `StreamConnectionManager` plugs into components via
  `useControlState` and similar hooks
- [MQTT pipeline](../design-notes/mqtt_pipeline.md) — deep dive on
  the MQTT subscribe/publish path and the retained-state cache
