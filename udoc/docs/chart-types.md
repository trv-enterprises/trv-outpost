---
sidebar_position: 11
---

# Chart Types

Charts are data visualization components that query a connection and render results using ECharts.

## Available Chart Types

| Type | Description |
|------|-------------|
| **Bar** | Vertical or horizontal bar chart for comparing categories |
| **Line** | Line chart for trends over time, supports smooth curves |
| **Area** | Filled area chart, supports stacking |
| **Banded Bar** | Levey-Jennings-style control chart with mean ± 1/2 SD bands. Time-series or column variants. |
| **Pie** | Pie or donut chart for proportions |
| **Scatter** | Scatter plot for correlation between two variables |
| **Gauge** | Gauge dial for single values with thresholds (warning, danger) |
| **Data Table** | Tabular display with sortable columns and search |
| **Number** | Large single-value display |
| **Custom** | Fully custom ECharts configuration via component code |

## Chart Configuration

### Data Connection
Select a connection to query data from. Supported connection types: SQL Database, REST API, CSV File, WebSocket, TS-Store, Prometheus, EdgeLake, MQTT.

### Query Configuration
Configure how data is fetched from the connection:
- **SQL**: Write SQL queries with parameter binding
- **Prometheus**: PromQL with visual query builder
- **EdgeLake**: Distributed queries across database nodes
- **API**: HTTP request configuration with auth
- **MQTT**: Topic subscription with field extraction

### Data Mapping
Map query result fields to chart axes and series:
- **X Axis**: Category or time field
- **Y Axis**: Value field(s)
- **Filters**: Include/exclude specific values
- **Aggregation**: Sum, average, count, min, max

### Chart Options
| Option | Applicable Types |
|--------|-----------------|
| **Axis labels** (X/Y) | Bar, Line, Area, Scatter |
| **X-axis timestamp format** | Time-series charts — defaults to **auto** (the chart picks time-only vs date+time from the data's actual span) |
| **Number value size** | Number — value font size in px; defaults to the admin setting [Default Number Chart Value Size](system-settings.md) (56 px out of the box) |
| **Smooth curves** | Line, Area |
| **Stacked series** | Bar, Line, Area |
| **Show data labels** | All chart types |
| **Gauge min/max** | Gauge |
| **Gauge thresholds** | Gauge (warning at 70, danger at 90 by default) |
| **Gauge unit** | Gauge |
| **Pie inner radius** | Pie (0 for pie, >0 for donut) |
| **Pie show labels** | Pie |

## Auto-Refresh

When placed in a dashboard with auto-refresh enabled, charts automatically re-query their data source at the configured interval. Streaming connections (WebSocket, MQTT, streaming ts-store) update in real-time without polling.

If the dashboard defines a [time-range variable](dashboard-variables.md#range-options), time-series charts re-scope to the picked window — including streaming ts-store charts, which re-backfill their history to the window and hold that span as live records arrive. An absolute (from/to) range renders a streaming chart as a static historical view until a relative preset is picked again. Instantaneous charts (gauge, number, pie) always show the latest value and ignore the range.

---
