# TSStore Datasource Architecture

This document describes the complete implementation of the TSStore (Time-Series Store) datasource integration in the GiVi-Solution Dashboard, including backend proxy, frontend data fetching, and chart rendering.

## Overview

TSStore is a time-series database that stores arbitrary JSON objects at timestamps using a block-based storage system. Unlike traditional databases, TSStore has no predefined schema - the schema is discovered at runtime by analyzing the JSON structure of stored records.

### Key Characteristics

- **Schema-less storage**: Objects can have any JSON structure
- **Timestamp-indexed**: Each object is stored with a nanosecond-precision timestamp
- **Batch storage**: Multiple records can be stored at the same timestamp
- **JSON API**: RESTful endpoints that return JSON directly (no base64 encoding)

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (React)                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────────┐  │
│  │   ComponentEditor    │    │    useData Hook   │    │  DynamicComponentLoader  │  │
│  │                  │    │                  │    │                          │  │
│  │  - Query Config  │───▶│  - Fetch data    │───▶│  - Render ECharts        │  │
│  │  - Data Mapping  │    │  - Transform     │    │  - Apply transforms      │  │
│  │  - Preview       │    │  - Cache         │    │  - Handle updates        │  │
│  └──────────────────┘    └────────┬─────────┘    └──────────────────────────┘  │
│                                   │                                             │
└───────────────────────────────────┼─────────────────────────────────────────────┘
                                    │ HTTP POST /api/datasources/:id/query
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           GO BACKEND (Port 3001)                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────────┐  │
│  │ DatasourceHandler│    │DatasourceService │    │  TSStoreDataSource       │  │
│  │                  │    │                  │    │                          │  │
│  │  POST /query     │───▶│  QueryDatasource │───▶│  - Query()               │  │
│  │  - Parse request │    │  - Create adapter│    │  - fetchNewestJSON()     │  │
│  │  - Return JSON   │    │  - Execute query │    │  - jsonToResultSet()     │  │
│  └──────────────────┘    └──────────────────┘    └────────┬─────────────────┘  │
│                                                           │                     │
└───────────────────────────────────────────────────────────┼─────────────────────┘
                                                            │ HTTP GET /api/stores/:name/json/*
                                                            ▼
                                    ┌──────────────────────────────────────────┐
                                    │           TSSTORE SERVER                  │
                                    │                                          │
                                    │  /json/newest?limit=N&since=DURATION     │
                                    │  /json/oldest?limit=N                    │
                                    │  /json/range?start_time=X&end_time=Y     │
                                    │  /json/time/:timestamp                   │
                                    └──────────────────────────────────────────┘
```

---

## Sequence Diagrams

### 1. Chart Preview in Editor

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌────────────────┐     ┌─────────┐
│  User   │     │ ComponentEditor │     │  Go Server  │     │TSStoreDataSource│    │ TSStore │
└────┬────┘     └──────┬──────┘     └──────┬──────┘     └───────┬────────┘     └────┬────┘
     │                 │                   │                    │                   │
     │ Click "Preview" │                   │                    │                   │
     │────────────────▶│                   │                    │                   │
     │                 │                   │                    │                   │
     │                 │ POST /api/datasources/:id/query        │                   │
     │                 │ {query: {raw: "since:1h",              │                   │
     │                 │         type: "tsstore",               │                   │
     │                 │         params: {limit: 100}}}         │                   │
     │                 │──────────────────▶│                    │                   │
     │                 │                   │                    │                   │
     │                 │                   │ Create TSStoreDataSource               │
     │                 │                   │───────────────────▶│                   │
     │                 │                   │                    │                   │
     │                 │                   │                    │ GET /json/newest  │
     │                 │                   │                    │ ?since=1h&limit=100
     │                 │                   │                    │──────────────────▶│
     │                 │                   │                    │                   │
     │                 │                   │                    │ {objects: [...],  │
     │                 │                   │                    │  count: 10}       │
     │                 │                   │                    │◀──────────────────│
     │                 │                   │                    │                   │
     │                 │                   │ jsonToResultSet()  │                   │
     │                 │                   │ (expand arrays,    │                   │
     │                 │                   │  discover schema)  │                   │
     │                 │                   │◀───────────────────│                   │
     │                 │                   │                    │                   │
     │                 │ {success: true,   │                    │                   │
     │                 │  result_set: {    │                    │                   │
     │                 │    columns: [...],│                    │                   │
     │                 │    rows: [...],   │                    │                   │
     │                 │    metadata: {}}} │                    │                   │
     │                 │◀──────────────────│                    │                   │
     │                 │                   │                    │                   │
     │ Display preview │                   │                    │                   │
     │◀────────────────│                   │                    │                   │
     │                 │                   │                    │                   │
```

### 2. Dashboard Chart Rendering

```
┌─────────┐  ┌───────────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────────┐  ┌─────────┐
│  User   │  │DynamicComponent   │  │  useData    │  │  Go Server  │  │TSStoreDataSource│ │ TSStore │
│         │  │    Loader         │  │    Hook     │  │             │  │                │  │         │
└────┬────┘  └────────┬──────────┘  └──────┬──────┘  └──────┬──────┘  └───────┬────────┘  └────┬────┘
     │                │                    │                │                 │                │
     │ View Dashboard │                    │                │                 │                │
     │───────────────▶│                    │                │                 │                │
     │                │                    │                │                 │                │
     │                │ Eval component code│                │                 │                │
     │                │ with useData hook  │                │                 │                │
     │                │───────────────────▶│                │                 │                │
     │                │                    │                │                 │                │
     │                │                    │ POST /query    │                 │                │
     │                │                    │───────────────▶│                 │                │
     │                │                    │                │                 │                │
     │                │                    │                │ Query()         │                │
     │                │                    │                │────────────────▶│                │
     │                │                    │                │                 │                │
     │                │                    │                │                 │ GET /json/*    │
     │                │                    │                │                 │───────────────▶│
     │                │                    │                │                 │                │
     │                │                    │                │                 │ JSON response  │
     │                │                    │                │                 │◀───────────────│
     │                │                    │                │                 │                │
     │                │                    │                │ ResultSet       │                │
     │                │                    │                │◀────────────────│                │
     │                │                    │                │                 │                │
     │                │                    │ {data, loading}│                 │                │
     │                │                    │◀───────────────│                 │                │
     │                │                    │                │                 │                │
     │                │ Apply transforms,  │                │                 │                │
     │                │ render ECharts     │                │                 │                │
     │                │◀───────────────────│                │                 │                │
     │                │                    │                │                 │                │
     │ Display chart  │                    │                │                 │                │
     │◀───────────────│                    │                │                 │                │
     │                │                    │                │                 │                │
```

---

## Backend Implementation

### File: `server-go/internal/datasource/tsstore.go`

The TSStore adapter implements the `DataSource` interface, providing query capabilities for time-series data.

#### Data Structures

```go
// TSStore JSON API response for a single object
type jsonObjectResponse struct {
    Timestamp       int64           `json:"timestamp"`        // Nanoseconds since epoch
    PrimaryBlockNum uint32          `json:"primary_block_num"`
    TotalSize       uint32          `json:"total_size"`
    BlockCount      uint32          `json:"block_count"`
    Data            json.RawMessage `json:"data"`             // Raw JSON payload
}

// TSStore JSON API list response
type jsonListResponse struct {
    Objects []jsonObjectResponse `json:"objects"`
    Count   int                  `json:"count"`
}
```

#### Query Types

| Query Pattern | Description | Example |
|--------------|-------------|---------|
| `newest` | Fetch N newest objects | `{"raw": "newest", "params": {"limit": 100}}` |
| `oldest` | Fetch N oldest objects | `{"raw": "oldest", "params": {"limit": 50}}` |
| `since:DURATION` | Fetch objects from last duration | `{"raw": "since:1h", "params": {"limit": 1000}}` |
| `range:START:END` | Fetch objects in time range | `{"raw": "range:1704067200:1704153600"}` |

#### Key Functions

**Query()** - Main entry point for data fetching:
```go
func (t *TSStoreDataSource) Query(ctx context.Context, query models.Query) (*models.ResultSet, error) {
    // 1. Extract limit from params (default: 10)
    // 2. Parse query type from raw string
    // 3. Call appropriate fetch function
    // 4. Convert response to normalized ResultSet
}
```

**jsonToResultSet()** - Converts TSStore responses to tabular format:
```go
func (t *TSStoreDataSource) jsonToResultSet(objects []jsonObjectResponse) (*models.ResultSet, error) {
    // Key feature: Handles BOTH single objects AND arrays per timestamp

    for _, obj := range objects {
        // Try parsing as array first (batch storage)
        var records []map[string]interface{}
        if err := json.Unmarshal(obj.Data, &records); err == nil {
            // Each record in array becomes a separate row
            for _, record := range records {
                record["timestamp"] = obj.Timestamp / 1e9
                // ... discover columns and add to results
            }
        } else {
            // Fall back to single object parsing
            var record map[string]interface{}
            json.Unmarshal(obj.Data, &record)
            // ...
        }
    }

    return &models.ResultSet{
        Columns: columnOrder,  // Discovered from JSON keys
        Rows:    rows,
        Metadata: map[string]interface{}{
            "row_count":   len(rows),
            "store_name":  t.config.StoreName,
            "source_type": "tsstore",
        },
    }
}
```

#### TSStore API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /api/stores/:name/json/newest?limit=N&since=DURATION` | Fetch newest objects, optionally filtered by time window |
| `GET /api/stores/:name/json/oldest?limit=N` | Fetch oldest objects |
| `GET /api/stores/:name/json/range?start_time=X&end_time=Y&limit=N` | Fetch objects in absolute time range |
| `GET /api/stores/:name/json/time/:timestamp` | Fetch single object by exact timestamp |

---

## Frontend Implementation

### File: `client/src/components/ComponentEditor.jsx`

The ComponentEditor provides the UI for configuring TSStore queries.

#### TSStore-Specific State

```javascript
const [tsstoreQueryType, setTsstoreQueryType] = useState('since');  // since, newest, oldest
const [tsstoreSinceDuration, setTsstoreSinceDuration] = useState('1h');
const [tsstoreLimit, setTsstoreLimit] = useState(100);
```

#### Query Building

```javascript
// Build TSStore query for preview/save
if (isTSStore) {
    queryParams = { limit: tsstoreLimit };  // Always include limit
    if (tsstoreQueryType === 'since') {
        rawQuery = `since:${tsstoreSinceDuration}`;
    } else {
        rawQuery = tsstoreQueryType;  // 'newest' or 'oldest'
    }
}
```

#### Duration Options

| Value | Description |
|-------|-------------|
| `5m` | Last 5 minutes |
| `15m` | Last 15 minutes |
| `30m` | Last 30 minutes |
| `1h` | Last 1 hour |
| `6h` | Last 6 hours |
| `24h` | Last 24 hours |
| `7d` | Last 7 days |

### File: `client/src/hooks/useData.js`

The useData hook handles data fetching for all datasource types.

```javascript
export function useData({ datasourceId, query, refreshInterval, useCache, maxBuffer, timeBucket }) {
    // For TSStore (non-streaming), uses polling-based fetching

    const fetchData = useCallback(async () => {
        const result = await queryData(datasourceId, query, useCache);
        setData(result.data);  // {columns: [], rows: []}
    }, [datasourceId, query, useCache]);

    // Auto-refresh at configured interval
    useEffect(() => {
        if (refreshInterval > 0) {
            const interval = setInterval(fetchData, refreshInterval);
            return () => clearInterval(interval);
        }
    }, [refreshInterval, fetchData]);

    return { data, loading, error, refetch };
}
```

### File: `client/src/api/dataClient.js`

Simple wrapper for datasource queries:

```javascript
export async function queryData(datasourceId, query, useCache = true) {
    const response = await apiClient.request(`/api/datasources/${datasourceId}/query`, {
        method: 'POST',
        body: JSON.stringify({ query })
    });
    return {
        data: response.result_set,
        source: useCache ? 'cache' : 'datasource'
    };
}
```

---

## Data Flow Example

### Example: Temperature Chart from TSStore

**1. User Configuration (ComponentEditor)**
```
Datasource: "TS-STORE SENSOR-READINGS"
Query Type: Time Range
Duration: 1h
Limit: 100
X-Axis: timestamp
Y-Axis: [value]
Filter: sensor_type = "temperature"
```

**2. Query Sent to Backend**
```json
POST /api/datasources/696028e7d7cb5c13dc5dad95/query
{
    "query": {
        "raw": "since:1h",
        "type": "tsstore",
        "params": {"limit": 100}
    }
}
```

**3. Backend Fetches from TSStore**
```
GET http://100.74.102.38:8080/api/stores/sensor-readings/json/newest?since=1h&limit=100
Headers: X-API-Key: tsstore_ab672865-...
```

**4. TSStore Response** (each timestamp has array of 10 sensors)
```json
{
    "objects": [
        {
            "timestamp": 1767988154000000000,
            "data": [
                {"sensor_id": "sensor-001", "sensor_type": "temperature", "value": 72.5, "location": "Building-A"},
                {"sensor_id": "sensor-002", "sensor_type": "humidity", "value": 45.2, "location": "Building-A"},
                // ... 8 more sensors
            ]
        },
        // ... more timestamp objects
    ],
    "count": 10
}
```

**5. Backend Converts to ResultSet** (arrays expanded)
```json
{
    "success": true,
    "result_set": {
        "columns": ["timestamp", "sensor_id", "sensor_type", "value", "location", "unit", "status", "quality"],
        "rows": [
            [1767988154, "sensor-001", "temperature", 72.5, "Building-A", "F", "normal", 98],
            [1767988154, "sensor-002", "humidity", 45.2, "Building-A", "%", "normal", 97],
            // ... 98 more rows (10 timestamps × 10 sensors = 100 rows)
        ],
        "metadata": {"row_count": 100, "store_name": "sensor-readings"}
    }
}
```

**6. Frontend Applies Transforms**
```javascript
// Filter for temperature sensors only
const transforms = {
    filters: [{field: "sensor_type", op: "eq", value: "temperature"}]
};
const filtered = transformData(data, transforms);
// Result: 10 rows (only temperature readings)
```

**7. ECharts Renders**
```javascript
const option = {
    xAxis: { type: 'time', data: timestamps },
    yAxis: { type: 'value', name: 'Temperature (F)' },
    series: [{ type: 'line', data: values }]
};
```

---

## Configuration Model

### Datasource Configuration (MongoDB)

```javascript
{
    "_id": ObjectId("696028e7d7cb5c13dc5dad95"),
    "name": "TS-STORE SENSOR-READINGS",
    "type": "tsstore",
    "config": {
        "tsstore": {
            "url": "http://100.74.102.38:8080",      // TSStore server URL
            "store_name": "sensor-readings",          // Store name
            "api_key": "tsstore_ab672865-...",       // Authentication
            "timeout": 30                             // Request timeout (seconds)
        }
    }
}
```

### Chart Configuration (MongoDB)

```javascript
{
    "_id": ObjectId("..."),
    "name": "Temperature Over Time",
    "chart_type": "line",
    "datasource_id": "696028e7d7cb5c13dc5dad95",
    "query_config": {
        "raw": "since:1h",
        "type": "tsstore",
        "params": {"limit": 100}
    },
    "data_mapping": {
        "x_axis": "timestamp",
        "x_axis_format": "chart",          // Format timestamps for display
        "y_axis": ["value"],
        "filters": [
            {"field": "sensor_type", "op": "eq", "value": "temperature"}
        ],
        "aggregation": null,
        "sliding_window": null,
        "time_bucket": null
    }
}
```

---

## Error Handling

### Backend Errors

| Error | Cause | Response |
|-------|-------|----------|
| Store not found | Invalid store_name | `{"success": false, "error": "store 'xxx' not found"}` |
| Connection failed | TSStore unreachable | `{"success": false, "error": "failed to connect to TSStore: ..."}` |
| Invalid duration | Bad since format | `{"success": false, "error": "invalid duration format"}` |
| API key required | Missing auth | `{"success": false, "error": "TSStore API error (status 401): ..."}` |

### Frontend Handling

```javascript
const { data, loading, error } = useData({...});

if (error) {
    return <div className="error">Error: {error.message}</div>;
}
```

---

## Performance Considerations

1. **Limit Parameter**: Always specify a limit to prevent fetching unbounded data
2. **Array Expansion**: Backend expands arrays into rows - 10 timestamp objects with 10 records each = 100 rows
3. **Client-side Transforms**: Filtering/aggregation happens client-side after fetch
4. **Refresh Interval**: Default 30s for dashboard views; adjust based on data update frequency

---

## Related Files

| File | Purpose |
|------|---------|
| `server-go/internal/datasource/tsstore.go` | TSStore adapter implementation |
| `server-go/internal/models/datasource.go` | TSStoreConfig model definition |
| `server-go/internal/service/datasource_service.go` | Query routing and validation |
| `client/src/components/ComponentEditor.jsx` | TSStore query configuration UI |
| `client/src/hooks/useData.js` | Data fetching hook |
| `client/src/api/dataClient.js` | API client wrapper |
| `client/src/utils/chartCodeGenerator.js` | Generated chart code templates |
| `client/src/utils/dataTransforms.js` | Client-side data transformation |

---

*Last Updated: 2026-01-09*
*Build: 417*
