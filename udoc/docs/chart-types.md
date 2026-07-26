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
| **Value** | Large single-value display — the value can be a number *or* text |
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
- **Series**: Value column(s) to plot — each series gets an optional **series label** that names it in the legend (falls back to the column name)
- **Y-axis label**: Text rendered vertically along the Y axis (single-axis mode). With **Dual Y-axis** on there is no axis label — the legend and the left/right axis colors identify each side
- **Filters**: Include/exclude specific values
- **Aggregation**: Sum, average, count, min, max

### Chart Options
| Option | Applicable Types |
|--------|-----------------|
| **Axis labels** (X/Y) | Bar, Line, Area, Scatter |
| **X-axis timestamp format** | Time-series charts — defaults to **auto** (the chart picks time-only vs date+time from the data's actual span) |
| **Value size** | Value — value font size in px; defaults to the admin setting [Default Value Chart Size](system-settings.md) (56 px out of the box) |
| **Value format / decimals / unit** | Value — see [Value formatting](#value-formatting) below |
| **Smooth curves** | Line, Area |
| **Stacked series** | Bar, Line, Area |
| **Orientation** (vertical / horizontal) | Bar — horizontal runs the bars left-to-right with categories down the side axis; best for long category names. Dual-Y-axis bars stay vertical |
| **Bar width (%)** | Bar — each bar's width as a percent of its category slot; blank = automatic sizing |
| **Show data labels** | All chart types |
| **Gauge min/max** | Gauge |
| **Gauge thresholds** | Gauge (warning at 70, danger at 90 by default) |
| **Gauge unit** | Gauge |
| **Pie inner radius** | Pie (0 for pie, >0 for donut) |
| **Pie show labels** | Pie |

### Value formatting

The **Value** type shows one cell — the first row's value for the chosen
column, after any aggregation — at a large font size.

The value may be a **number or text**. A text value (a status string like
`ONLINE`, a device state, a name) renders as-is — no custom code needed.

**Value type** decides which options you get. It defaults to **Auto**, which
reads the type from your data and is right nearly always. Set it to **Number**
or **Text** explicitly when detection can't work — an empty sample, a column
with mixed values, or a live stream that hasn't produced a record yet — so you
can still reach the options you need.

The options follow that choice:

| Value type | Options shown |
|---|---|
| **Number** | Format, Value size, Decimal places, Unit suffix |
| **Text** | Text case, Value size |

Decimal places and Unit suffix aren't offered for text, because neither
applies to a string.

### Text case

For text values, **Text case** re-cases the displayed string. It is
display-only — your source data is untouched.

| Setting | `device offline` renders as |
|---|---|
| **As-is (source)** (default) | `device offline` |
| **ALL CAPS** | `DEVICE OFFLINE` |
| **lowercase** | `device offline` |
| **Capitalize First Letter** | `Device offline` |
| **Title Case** | `Device Offline` |

### Numeric formats

For numeric values, pick the **Format** that matches what the raw column
actually holds. The format *implies* the unit, so map the raw column and
choose a format rather than converting in your query:

| Format | Renders |
|--------|---------|
| **Auto** (default) | Source precision, locale-formatted |
| **Plain number** | `1,234.5` — never abbreviated |
| **Compact (SI)** | `1200000` → `1.2M` (same abbreviation as chart axes and data tables) |
| **Duration from seconds** | `183840` → `2d 3h 4m` |
| **Duration clock** | Seconds → `HH:MM:SS` |
| **Date / time** | The value is a timestamp; a **Date/time style** sub-option picks the presentation |

**Decimal places** forces a fixed number of decimals (or **Auto** to keep
the source precision, up to two places). **Unit suffix** appends a
cosmetic label after the value (`%`, `°C`, `GB`) — it does not scale the
value.

:::note
Auto treats a numeric *string* as a number. JSON, MQTT, and CSV sources
routinely deliver numbers quoted as text (`"42"`), and a tile pointed at one
should still format it as a number. If you genuinely want such a value shown
as text — an ID or a version code that shouldn't be locale-formatted — set
**Value type** to **Text**.
:::

:::tip
Give every Value tile on a dashboard the same panel height and the same
value size. Uniform sizing is what makes a row of tiles read as a set.
:::

### Data Table Columns

The Data Table type has a per-column **Columns** editor: check a column to
include it, reorder with the ↕ arrows (rows move as you click — the table
matches what you see), and optionally set a **display name**, a fixed
**width** in pixels (blank = auto-size; viewers can still drag headers to
override for their own session), and a **value format**:

| Format | Renders |
|--------|---------|
| **Auto** (default) | Locale number / timestamp detection |
| **Compact (SI)** | `136365211648` → `127.0G` (same abbreviation as value tiles and chart axes) |
| **Duration** | Seconds → `2d 3h 4m` |
| **Duration (HH:MM:SS)** | Seconds → clock form |
| **Plain number** | Locale number, never abbreviated |

## Auto-Refresh

When placed in a dashboard with auto-refresh enabled, charts automatically re-query their data source at the configured interval. Streaming connections (WebSocket, MQTT, streaming ts-store) update in real-time without polling.

If the dashboard defines a [time-range variable](dashboard-variables.md#range-options), time-series charts re-scope to the picked window — including streaming ts-store charts, which re-backfill their history to the window and hold that span as live records arrive. An absolute (from/to) range renders a streaming chart as a static historical view until a relative preset is picked again. Instantaneous charts (gauge, value, pie) always show the latest value and ignore the range.

---
