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
                    stream_handler.go
                      │  GET /api/connections/:id/stream?topics=…
                      ▼
                    SSE response ──────────────────▶   EventSource
```

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

## SSE handler

`internal/handlers/stream_handler.go` is the HTTP endpoint clients
connect to. `GET /api/connections/:id/stream?topics=foo,bar`:

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

## Client-side connection manager

`client/src/utils/streamConnectionManager.js` is a singleton on the
frontend that manages one `EventSource` per datasource. Multiple
components can subscribe to the same datasource at once — their
topic filters are combined into a single SSE URL, and records are
routed to subscribers by client-side topic matching.

Key behaviors:

- **Single EventSource per datasource.** A dashboard with five MQTT
  panels all on the same broker shares one SSE connection.
- **Topic-diff reconnect.** When the set of active subscribers
  changes (dashboard switch, component unmount), the manager
  recalculates the combined topic set. If it changed, the SSE
  connection is closed and reopened with the new topic list.
- **30-second grace period.** When the last subscriber drops, the
  manager waits 30 s before actually closing the SSE connection.
  Arriving subscribers within that window reuse the existing
  connection — the common case when the user flips between
  dashboards.
- **1000-record client buffer.** A ring buffer per datasource on
  the client side, flushed to new subscribers on mount (the
  client-side analog of the backend buffer flush).
- **Heartbeat watchdog.** If 60 s pass without any event (not even
  a heartbeat), the manager tears the EventSource down and
  reconnects with exponential backoff.

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
