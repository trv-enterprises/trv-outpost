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

On the single-value types — **Gauge** and **Value** — an aggregation reduces
the rows to the one number shown, so picking **Average** displays the average
rather than the newest reading. The **Field** it aggregates is fixed to the
Value Column (there's only one column on display, so there's nothing to
choose) and is shown greyed out to make that clear. What the average is taken
*over* is whatever rows the query returned, narrowed by any filters and by the
sliding window if one is set — so on a live chart, "average over the last 5
minutes, ignoring spikes" is a sliding window of 5 minutes plus **Average**.

### Current State Per Series

Streaming data arrives as a running history: every disk reports over and over,
so a live table fills with hundreds of rows covering the same handful of disks.
**Current State Per Series** collapses that to one row per thing — the newest
reading for each disk, volume, container, or sensor.

Turn it on in the component editor and pick:

- **Series Column** — the column whose distinct values you want one row each
  for (`disk`, `volume`, `container`, `host`).
- **Timestamp Column** *(optional)* — which column decides "newest." Leave it
  blank on a live stream and the most recently received row wins, which is
  almost always what you want.

Available on **Data Table, Bar, Line, Area, and Scatter** — the types that show
several series at once.

It's deliberately **not** offered on **Value** or **Gauge**. Those show a single
number, so "the current value of disk1" is better expressed with a *filter* on
`disk1` plus an aggregation of **Last** — no per-series reduction needed.
**Banded Bar** doesn't offer it either: its related columns all share one
timestamp, so collapsing by series would reduce along the wrong axis.

:::tip
On a **non-streaming ts-store** connection, prefer the query type **Current
State (latest per series)** instead. It does the same reduction at the source,
so less data crosses the network. This editor setting exists for *streaming*
connections, which can't push the reduction down to the source. Setting both
does no harm, but only one of them is doing the work.
:::

#### Processing order

The editor's Data Mapping tab groups these settings and lists them in the order
they actually run — which matters, because they build on each other:

**Server-side processing** happens first, before the data reaches your browser:

1. **Time Bucket Aggregation** — combines readings into intervals (a reading
   per minute instead of per second)

**Client-side processing** then shapes what's already been fetched:

2. **Sliding Window** — discards anything older than the span you set
3. **Current State Per Series** — keeps the newest row per series
4. **Filters** — include/exclude specific values
5. **Aggregation & Sorting** — reduces to a number, sorts, limits rows

Reading it top to bottom tells you what a component does. A useful consequence:
the sliding window runs *before* Current State Per Series, so a disk that
stopped reporting longer ago than the window drops off the table instead of
lingering with a stale reading that looks current.

Note that **Sliding Window** and **Time Bucket** are different tools that pair
well. The window sets *how far back* you look; the bucket sets *how coarse* the
readings are within it. "Last 6 hours, averaged per minute" uses both.

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
| **Gauge style** | Gauge — a named preset for the dial's whole look; see [Gauge styles](#gauge-styles) below |
| **Gauge min/max** | Gauge |
| **Gauge thresholds** | Gauge (warning at 70, danger at 90 by default) |
| **Gauge unit** | Gauge |
| **Gauge dial appearance** | Gauge — start/end angle, dial size, arc coloring and thickness, split lines, dial numbers, pointer, value and caption placement |
| **Pie inner radius** | Pie (0 for pie, >0 for donut) |
| **Pie show labels** | Pie |

### Gauge styles

A gauge's look is a dozen interacting settings — where the dial starts and
ends, how thick the arc is, whether it has tick marks, where the number sits.
Setting those one at a time to reach something coherent is tedious, so the
**Gauge Style** dropdown at the top of Gauge Options applies a whole
coordinated set at once.

| Style | Look |
|---|---|
| **Modern** | One colored arc sweeping over a flat track, no tick marks or dial numbers, a slim needle, and the value set high in the dial with an optional caption beneath it. The arc takes the color of the threshold band the value is in. |
| **Classic** | The traditional dial: the whole track painted in green / yellow / red threshold bands, with tick marks, dial numbers, and a broad pointer over a center hub. |

**New gauges start on Modern.** Gauges you created before styles existed keep
rendering exactly as they always have — they show as **Classic** and nothing
about them changes until you choose otherwise.

A style is a *starting point*, not a mode. Every setting it applies stays
editable underneath, in the **Dial & Arc**, **Ticks & Pointer** and
**Readout** groups. Once you change any of them the dropdown reads
**Custom** — that's your cue that picking a style again will *overwrite* what
you've tuned.

Choosing a style only touches appearance. Min and max, the warning and danger
thresholds, the unit suffix, decimal places and SI abbreviation all survive a
style change, because they describe what the number *means* rather than how
the dial looks.

The **caption** is the small label under the value — a unit, a source name,
anything short. Leave it blank and it takes no space.

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
| **Number** | Format, Value size, Decimal places, Unit suffix, Color thresholds |
| **Text** | Text case, Value size, Color rules |

Decimal places and Unit suffix aren't offered for text, because neither
applies to a string.

### Coloring the value

Both types can color the value itself — useful for a status tile you want
readable at a glance from across a room. Leave the list empty and the value
uses the normal text color.

**Numeric — Color thresholds.** Each threshold's color applies from its value
*upward*, so the highest one the value has reached wins. You can add them in
any order.

| Thresholds | 50 renders | 85 renders | 95 renders |
|---|---|---|---|
| 0 green, 80 yellow, 90 red | green | yellow | red |

**Line, area and bar — Threshold bands.** Same rule, applied to a series
instead of a single number: each threshold's color runs from its value
*upward*, until the next threshold takes over.

The first row is the **Base**. It has a color but no value — it paints
everything below the first real threshold, which is why the editor shows it
without a number field. Every row after it is a *starts at* value: from there
up, that row's color applies, and a dashed boundary line is drawn at that
value. The base has no boundary line, because nothing changes there.

| Bands | a point at 10 | at 26 | at 33 |
|---|---|---|---|
| Base green, 24 amber, 30 red | green | amber | red |

The band strip above the rows previews the colors in order. Rows re-sort
themselves by value, so you can type them in any order.

**Threshold lines / Value color / Both** chooses what the bands do: draw the
boundary lines only, recolor the data line only, or both.

Thresholds are **single-axis only** — the settings disappear when *Dual
Y-axis* is on. A threshold value has no unambiguous meaning across two
axes: the boundary line can only be drawn against one of them, and the
band coloring applies to every series regardless of which axis it belongs
to, so a series in a different magnitude (bytes against a 0–100
percentage) would be painted one flat color.

**Text — Color rules.** Add a rule per state you care about; there's no limit.
Each rule is an operator (**equals** or **contains**), the text to match, and a
color. Matching **ignores case**, so a rule for `online` catches `ONLINE`.

Rules are checked **top to bottom and the first match wins**, so put specific
rules above broad ones — use the ↑ ↓ buttons to reorder:

| Rule | |
|---|---|
| **equals** `ONLINE` → green | `ONLINE` matches here |
| **contains** `fail` → red | `OFFLINE - FAILED` falls through to here |
| **contains** `warn` → yellow | |

Anything matching no rule keeps the default color.

Colors come from a palette of Carbon tokens — the alert ramp (danger, caution,
warning, ok, info) for numeric thresholds, and that same ramp plus the chart
line colors for text rules, since a text state like `Cooling` often isn't a
severity at all. Click a swatch to pick, or use the dashed well at the end of
the row for a custom color.

### Background color

**Background** fills the whole tile with a color — a status tile that reads as
a block of red across a room, rather than a red number on a dark panel.

You pick only the fill. The value's text color is **paired automatically** from
Carbon's matching light/dark sets, so the number stays readable on whatever you
choose; the preview under the swatches shows the pairing before you commit. The
title follows the same pairing.

The swatches lead with the same alert ramp the thresholds use, followed by the
Carbon chart colors. The dashed well at the end takes a custom color, and the
text is paired against that too.

Leave it unset (the default) and the tile stays transparent, showing the
panel's own background as before.

:::note Thresholds still win
If a color threshold or text rule matches, its color is used for the value —
setting a background doesn't switch threshold coloring off. The paired color
applies when no rule has matched.
:::

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

The Data Table type's **Columns** section shows the real table, with your own
data in it. You shape the layout by working on the table directly:

- **Width** — drag a column's edge. The pixel width appears in the header as
  you drag.
- **Order** — drag a column header sideways.
- **Hide** — click **✕** in the header. Hidden columns are listed as tags
  below the table; click a tag's **✕** to bring one back.
- **Auto-size** — click **⇔** in the header to size a column to its content,
  or **Auto-size all** in the toolbar to clear every width at once.

Turn on **Show hidden** to bring hidden columns back into the table, greyed
out, so you can un-hide them without leaving it. It's off by default — hiding
a column is usually how you get it out of the way while sizing the rest.

:::note Run the query first
The table sizes against your real data, so it appears once the query has
returned rows. Press **Fetch Data** if the section shows a prompt instead of a
table.
:::

Widths you set here are the chart default. A viewer can still drag headers in
the live dashboard to override them for their own session.

#### Per-column options

Click **⚙** in a column's header for the settings that aren't a drag gesture.

On the **Display** tab: a **display name** (the header label), an exact
**width** in pixels for when a drag won't do (matching a width across two
tables, say), and a **value format**:

| Format | Renders |
|--------|---------|
| **Auto** (default) | Locale number / timestamp detection |
| **Compact (SI)** | `136365211648` → `127.0G` (same abbreviation as value tiles and chart axes) |
| **Duration** | Seconds → `2d 3h 4m` |
| **Duration (HH:MM:SS)** | Seconds → clock form |
| **Plain number** | Locale number, never abbreviated |

#### Conditional formatting

The **Formatting rules** tab colors a column's cells by what they contain — a
`status` column showing green for running and red for stopped, say. The tab
label shows the rule count, so you can tell a formatted column from a plain
one at a glance.

Each rule is an operator, a value to match, and a color:

| Operator | Matches when the cell |
|---|---|
| **equals** | is exactly this text |
| **contains** | contains this text anywhere |
| **greater than** | is a number above this one |
| **less than** | is a number below this one |
| **is empty** | is blank or has no value |

Text matching **ignores case**, so a rule for `running` catches `Running`.
Numeric operators skip cells that aren't numbers, so a `>` rule on a text
column simply never fires.

Rules are checked **top to bottom and the first match wins** — put specific
rules above broad ones and use the ↑ ↓ buttons to reorder. A rule with no
value typed in yet is skipped rather than matching everything.

Per rule you also choose:

- **Apply to** — **Text** colors the text; **Text + background** fills the
  cell and picks a contrasting text color automatically.
- **Color the whole row** — paints the entire row instead of the single cell.
  If rules in more than one column claim the same row, the leftmost column
  wins.

A live preview beside each rule shows exactly how it will render.

## Auto-Refresh

When placed in a dashboard with auto-refresh enabled, charts automatically re-query their data source at the configured interval. Streaming connections (WebSocket, MQTT, streaming ts-store) update in real-time without polling.

If the dashboard defines a [time-range variable](dashboard-variables.md#range-options), time-series charts re-scope to the picked window — including streaming ts-store charts, which re-backfill their history to the window and hold that span as live records arrive. An absolute (from/to) range renders a streaming chart as a static historical view until a relative preset is picked again. Instantaneous charts (gauge, value, pie) always show the latest value and ignore the range.

---
