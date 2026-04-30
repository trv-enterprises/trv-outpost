# MQTT Data Pipeline

End-to-end architecture for how MQTT data flows from broker to browser.

## Pipeline Overview

```
MQTT Broker (Mosquitto)
    │
    │  MQTT protocol (paho autopaho)
    │  Only subscribes to topics that active components need
    ▼
MQTTStream (streaming/mqtt_stream.go)
    │
    │  Per-subscriber topic routing
    │  Records only sent to channels whose topic filters match
    ▼
Manager (streaming/manager.go)
    │
    │  Manages stream lifecycle, cleanup, topic-aware subscription
    ▼
StreamHandler (handlers/stream_handler.go)
    │
    │  SSE (Server-Sent Events) over HTTP
    │  GET /api/connections/:id/stream?topics=<filter>
    ▼
StreamConnectionManager (utils/streamConnectionManager.js)
    │
    │  Singleton, shared SSE connections keyed by datasourceId::topics
    ▼
useData Hook (hooks/useData.js)
    │
    │  Extracts topic from query.raw, subscribes to manager
    │  Converts records to { columns, rows } format
    ▼
DynamicComponentLoader → Chart Component
```

## Layer Details

### 1. MQTT Broker → MQTTStream

**File**: `server-go/internal/streaming/mqtt_stream.go`

The `MQTTStream` maintains a single persistent connection to the MQTT broker per datasource (connection). It does NOT subscribe to `#` (all topics). Instead, it dynamically subscribes/unsubscribes at the broker level based on what subscribers need.

**Key structures**:

```go
type mqttSubscriber struct {
    ch     chan models.Record   // Per-subscriber channel
    topics []string             // MQTT topic filters this subscriber wants
}

type MQTTStream struct {
    datasourceID string
    config       *models.MQTTConfig
    cm           *autopaho.ConnectionManager
    subscribers  []*mqttSubscriber
    topicRefs    map[string]int  // ref count: topic → number of subscribers
    buffer       *RingBuffer     // Circular buffer, capacity 100
    connected    bool
}
```

**Topic ref counting**: When a subscriber requests topics `["sensors/temp/#"]`, the ref count for that filter increments. When it reaches 1 (first subscriber for that topic), `subscribeBrokerTopics()` sends `SUBSCRIBE` to the broker. When it drops to 0 (last subscriber gone), `unsubscribeBrokerTopics()` sends `UNSUBSCRIBE`.

**Message routing**: `handleMessage()` receives every message from the broker. For each message, it:
1. Parses JSON payload, merges fields into a `Record`
2. Validates timestamps (must be Unix epoch > 1 billion, otherwise uses server time)
3. Pushes to the `RingBuffer` (all messages, unfiltered)
4. Feeds to bucket aggregators
5. Routes to **only matching subscribers** — checks each subscriber's topic filters against the message's topic using `MQTTTopicMatch()`

**MQTT wildcard matching** (`MQTTTopicMatch`):
- `+` matches exactly one topic level: `sensors/+/room1` matches `sensors/temp/room1`
- `#` matches zero or more levels: `sensors/#` matches `sensors/temp/room1`

**Reconnection**: `OnConnectionUp` callback re-subscribes to all topics in `topicRefs` after a reconnect.

### 2. Manager → MQTTStream

**File**: `server-go/internal/streaming/manager.go`

The `Manager` holds a map of `datasourceID → Streamer`. One stream per datasource, regardless of how many SSE clients connect.

**Topic-aware methods** (MQTT-specific):

```go
// Type-asserts to *MQTTStream and calls SubscribeWithTopics
func (m *Manager) SubscribeWithTopics(ctx, datasourceID, topics) chan models.Record

// Type-asserts to *MQTTStream and calls GetBufferFiltered
func (m *Manager) GetBufferFiltered(datasourceID, topics) []models.Record
```

For non-MQTT streams, these fall back to `Subscribe()` and `GetBuffer()`.

**Stream lifecycle**: The manager runs a cleanup goroutine that checks every 30s for streams with 0 subscribers. After a 60s grace period, idle streams are stopped and removed.

**Stream creation** (`createStream`): Looks up the connection config from MongoDB, creates the appropriate `Streamer` implementation based on type (`socket`, `mqtt`, `tsstore`), calls `Start()`, and stores it.

### 3. StreamHandler (SSE Endpoint)

**File**: `server-go/internal/handlers/stream_handler.go`

**Endpoint**: `GET /api/connections/:id/stream?topics=<comma-separated>`

The handler:
1. Parses `?topics=` query param via `streaming.ParseTopicFilters()`
2. If topics present → calls `manager.SubscribeWithTopics()` (broker-level filtering)
3. If no topics → calls `manager.SubscribeAndGetChannel()` (subscribes to `#`)
4. Sends buffered records via `manager.GetBufferFiltered()` as initial state
5. Enters SSE loop: reads from channel, marshals to JSON, writes `event: record\ndata: {...}\n\n`
6. Sends heartbeat every 30s to keep the connection alive
7. On client disconnect, calls `manager.Unsubscribe()` to decrement ref counts

No topic filtering happens in the handler — it's all done upstream in `MQTTStream.handleMessage()`.

### 4. StreamConnectionManager (Browser SSE Client)

**File**: `client/src/utils/streamConnectionManager.js`

Singleton that manages SSE connections. Multiple React components subscribing to the same datasource+topics share one `EventSource`.

**Connection keying**: `_connectionKey(datasourceId, topics)` returns `datasourceId` or `datasourceId::topics`. Different topic filters on the same datasource get separate SSE connections, ensuring server-side filtering is per-client.

**Subscribe flow**:
1. `subscribe(datasourceId, callback, { topics })` is called
2. Builds key, checks if connection exists
3. If not, calls `_connect()` → `_createEventSource()`
4. EventSource URL: `${API_BASE}/api/connections/${id}/stream?topics=${topics}`
5. Listens for `record` events, parses JSON, distributes to all subscriber callbacks
6. Maintains a client-side buffer (max 1000 records) for late subscribers

**Reconnection**: On error, exponential backoff from 1s to 30s. Re-creates EventSource. Notifies subscribers of connection state changes.

**Cleanup**: When last subscriber for a key unsubscribes, closes the EventSource and removes all state.

### 5. useData Hook

**File**: `client/src/hooks/useData.js`

Detects datasource type on mount via `apiClient.getDatasource(id)`. If type is `mqtt` or `socket`, uses streaming instead of polling.

**MQTT topic extraction**:
```javascript
const topicFilter = (datasourceType === 'mqtt' && parsedQuery?.raw) ? parsedQuery.raw : null;
```
The chart's `query.raw` field contains the MQTT topic filter (e.g., `shellyplug-s-xxx/relay/0`). This is passed as the `topics` option to `StreamConnectionManager.subscribe()`.

**Record processing** (`processStreamRecord`):
1. First record's keys become column headers
2. Each record is converted to a row array matching column order
3. Rows are appended, trimmed to `maxBuffer` (default 1000)
4. State is `{ columns: [...], rows: [[...], ...] }`

**Connection state**: Tracks `connected`, `reconnecting`, `disconnectedSince`. Shows error after 30s grace period.

### 6. Component Rendering

**File**: `client/src/components/DynamicComponentLoader.jsx`

`DynamicComponentLoader` calls `useData()` with the chart's `connection_id` and `query` config. The resulting `data` (columns + rows) is passed as a prop to the dynamically evaluated chart component.

The chart component (stored as a code string in MongoDB) receives `data` and renders using ECharts or other visualization libraries.

## RingBuffer

**File**: `server-go/internal/streaming/buffer.go`

Thread-safe circular buffer with fixed capacity (default 100). Used by `MQTTStream` to retain recent messages for new SSE clients.

- `Push()`: Overwrites oldest record when full (O(1), fixed memory)
- `GetAll()`: Returns records in chronological order (oldest first)
- Buffer stores ALL topics — `GetBufferFiltered()` on `MQTTStream` filters by topic pattern at read time

## Timestamp Handling

MQTT payloads may contain a `timestamp` field in various formats:

| Source | Format | Handling |
|--------|--------|----------|
| Shelly | Unix epoch (int64) | Used directly if > 1 billion |
| Caseta | ISO 8601 string | Stored as `payload_timestamp`, server time used for `timestamp` |
| No timestamp | — | Server time (`time.Now().Unix()`) |

Validation in `handleMessage()`: If payload `timestamp` is a `float64` > 1 billion, it's a valid Unix epoch. Otherwise, server time is used and the original value is preserved as `payload_timestamp`.

## Data Flow Example

A dashboard has a chart showing Shelly plug power consumption, configured with:
- `connection_id`: `"abc123"` (MQTT connection to Mosquitto)
- `query.raw`: `"shellyplug-s-80646F840029/relay/0"`

1. **useData** detects `mqtt` type, extracts topic `"shellyplug-s-80646F840029/relay/0"`
2. **StreamConnectionManager** opens SSE to `/api/connections/abc123/stream?topics=shellyplug-s-80646F840029/relay/0`
3. **StreamHandler** parses topics, calls `manager.SubscribeWithTopics(ctx, "abc123", ["shellyplug-s-80646F840029/relay/0"])`
4. **Manager** finds or creates `MQTTStream` for `"abc123"`, calls `mqttStream.SubscribeWithTopics(["shellyplug-s-80646F840029/relay/0"])`
5. **MQTTStream** increments ref count for that topic. If ref count is 1, sends `SUBSCRIBE` to Mosquitto broker
6. Broker publishes a message on `shellyplug-s-80646F840029/relay/0`
7. **MQTTStream.handleMessage** receives it, parses JSON (`{"apower":150.2,"timestamp":1741550000}`), creates Record
8. Routes record only to subscribers whose topic filters match — sends to this subscriber's channel
9. **StreamHandler** reads from channel, writes SSE event
10. **StreamConnectionManager** receives event, parses JSON, calls subscriber callbacks
11. **useData.processStreamRecord** appends row to state
12. **Chart component** re-renders with updated data

## Key Design Decisions

- **One broker connection per datasource**: All SSE clients for the same MQTT connection share one `autopaho.ConnectionManager`. Different topic needs are handled by dynamic subscribe/unsubscribe.
- **Ref-counted broker subscriptions**: Prevents subscribing to topics nobody needs. Automatically unsubscribes when last interested client disconnects.
- **Per-subscriber routing**: `handleMessage` only sends records to channels whose filters match, preventing channel overflow from irrelevant messages.
- **Non-blocking channel sends**: If a subscriber's channel (capacity 100) is full, the record is dropped silently. This prevents a slow consumer from blocking the broker message handler.
- **Composite SSE keys**: Client-side uses `datasourceId::topics` as connection key, so different topic filters get separate SSE connections with independent server-side filtering.
