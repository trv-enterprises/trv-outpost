---
sidebar_position: 7
---

# Dashboard Variables

A **dashboard variable** lets one dashboard serve many sites, systems, or
hosts. Instead of building a near-identical board for every server, you build
one and add a variable; a dropdown after the dashboard name then re-scopes
every panel to the selected value.

There are three kinds of variable, and a dashboard can combine them:

- **Connection swap** — selecting a value repoints every panel to a different
  *connection*. Use this when each site/system is its own connection (e.g. a
  ts-store per machine).
- **Filter value** — selecting a value substitutes it into each component's
  *query or filter*. Use this when all sites share one connection and are
  distinguished by a column (e.g. a `location` field).
- **Time range** — the viewer picks a time window (a relative preset like
  *Last 24h*, or absolute from/to instants) and every time-series panel
  re-queries to that window. At most one range variable per dashboard.

> Where this lives in the app: you **define** variables while editing a
> dashboard (the **Variables** button), and you **use** them from the header
> dropdown while viewing. This page is referenced from both
> [Viewing Dashboards](viewing-dashboards.md) and the
> [Live Dashboard Editor](dashboard-editor.md).

## Using variables (View Mode)

When a dashboard has variables enabled, the viewer shows a control after the
dashboard name — one per variable:

- A **connection-swap** variable shows a dropdown of candidate connections.
  Picking one repoints every panel that follows the variable. The selection is
  remembered per-user-per-dashboard and is encoded in the URL
  (`?var_<name>=<value>`), so a scoped board is shareable and bookmarkable.
- A **filter** variable shows a dropdown (or a free-text box) of values.
  Picking one re-runs the query for query-based panels and re-filters the live
  data for streaming panels.
- A **range** variable shows a time-window picker: relative presets plus
  (when enabled) **Custom…** absolute from/to inputs. For connection types
  that downsample server-side (ts-store, Prometheus) a **step** dropdown
  appears next to it — the offered steps are sized to the chosen window,
  and the server additionally clamps the step to a point budget so a wide
  window at a fine step can't overload the source. Series charts under a
  stepped range also relax their refresh to roughly half the step (the
  data only advances once per step).
  Picking a window re-queries polled panels and re-backfills streaming
  panels to that span; an **absolute** range freezes a streaming panel into
  a static historical view (there is no "live" for a closed past window),
  and live updates resume when you return to a relative preset. The picker
  only appears when at least one panel actually consumes the range.

In [Kiosk Mode](modes.md#kiosk-mode), a kiosk entry can set a connection-swap
variable from the URL (`<id>:connection=<connectionId>`), so one layout rotates
across hosts without a human at the keyboard.

## Defining variables (Edit Mode)

1. Open the dashboard in the [editor](dashboard-editor.md).
2. Click **Variables** (next to the dashboard name).
3. Turn the variable on and choose a **type**.

### Connection-swap options

| Field | What it does |
|-------|--------------|
| **Variable label** | The label shown next to the dashboard name in the header. |
| **Connection tags** | Candidate connections are discovered by tag — connections carrying **all** of these tags appear in the dropdown. |
| **Compatibility check** | How strictly a candidate must match the dashboard's reference connection. *Type only* (recommended) accepts any connection of the same type; stricter modes compare columns. |
| **Same namespace only** | Restrict discovery to the dashboard's own namespace. Off by default, so connections in another namespace can still be found by tag. |
| **Label tag prefix** *(optional)* | Show a short label in the dropdown instead of the (often long) connection name. With prefix `host`, a connection tagged `host:trv-srv-001` shows **`trv-srv-001`**; connections without a matching tag fall back to their name. |

Every panel follows a connection-swap variable by default. To keep a specific
panel on its own connection, **pin** it from the panel's edit menu (see
[Panel Management](panel-management.md)).

### Filter options

A filter variable substitutes its value wherever a component uses the
`{{dashboard-variable}}` token — in a SQL/EdgeLake `WHERE` clause (bound or
escaped safely server-side) or in a client-side filter value. See
[Creating Components](creating-components.md) for how to place the token.

| Field | What it does |
|-------|--------------|
| **Variable label** | The header label. |
| **Value source** | Where the dropdown gets its choices: a **list** you type, **free text** (type any value), or **from connection** (discovered live — see below). |
| **Options** | The list of values (for *list* source; also the fallback list for *from connection*). |
| **Default value** | Pre-selected on first load. |

### Range options

| Field | What it does |
|-------|--------------|
| **Variable label** | The header label. |
| **Presets** | The relative windows offered (e.g. `1h`, `6h`, `24h`, `7d`, `30d`). |
| **Default preset** | Pre-selected on first load. |
| **Allow absolute** | Adds **Custom…** with absolute from/to date-time inputs. |

How the window reaches each panel depends on its connection type:

- **SQL / EdgeLake** — opt-in per component: write the time column followed by
  the `{{range-variable}}` token in the `WHERE` clause (e.g.
  `WHERE ts {{range-variable}}`); the server expands it into a bounded
  predicate. Panels without the token ignore the range.
- **ts-store / Prometheus** — time-series panels pick the window up
  automatically, no token needed. This includes **streaming** ts-store charts:
  the range drives the backfilled history and holds the span as live records
  arrive.
- **Instantaneous tiles** (gauge / number / pie) always show the latest value —
  the range deliberately does not hijack them into a historical query.

## Value discovery (from connection)

With value source **From connection**, the dropdown is populated from the
connection itself, so you don't have to type the list by hand. How the values
are gathered depends on the connection type:

| Connection type | How values are discovered |
|-----------------|---------------------------|
| **SQL / EdgeLake** | A `DISTINCT` query on the bound column. |
| **API** | One fetch of recent records; the column's distinct values are collected. |
| **ts-store** | The most recent ~1000 records over HTTP (works even for streaming-transport ts-store). |
| **Raw socket / MQTT** | A **live capture** — these have no query API, so the dashboard listens to the stream and collects distinct values as they arrive. |

For the live-capture types, a modal shows the values **accumulating in real
time** with a **Stop** button — stop it once the list stops growing. In the
editor this list is saved onto the connection so the viewer can use it later
without re-capturing; on the dashboard, a **refresh** control next to the
dropdown re-captures for your current session (a permanent update is made by an
author in the editor).

> A captured list from a live stream is necessarily a **sample** of what has
> recently come through — a value that hasn't appeared lately may be missing
> until it does. The list is labeled as partial when that's the case.

## Using a variable in a text panel

A [text panel](panel-management.md) can show a variable's current value inline
with a `{{variable:NAME}}` token — for example, a title that reads
`Host: {{variable:host}}` updates as you change the selection. Insert the token
from the pill in the text-panel editor; it resolves to the variable's display
value (the tag-prefix label for connection-swap, or the chosen value for a
filter).

## Tagging matters: real-time vs. query connections

> **Important.** If you have **both** a real-time (WebSocket / streaming) and a
> SQL/API connection to the **same source**, distinguish them with tags and use
> the right one on each component.

A connection-swap variable offers connections by tag, so tagging is how you keep
the streaming and query worlds separate:

- Tag your **real-time / WebSocket** connections (e.g. `ts-store`, `websocket`,
  `realtime`) and use them on your **live charts** — the ones that stream and
  update continuously.
- Tag your **SQL / API** connections (e.g. `sql`, `api`, `history`) and use them
  on components that do **time-range / point-in-time lookups**.

If both point at the same underlying system but aren't distinguished, the
variable can hand a live chart an API connection (or vice versa), and it won't
get the data shape it expects. Consistent, intentional tagging — and choosing
the matching connection on each component — is what makes scoping work cleanly.
See [Connections](connections-overview.md) for tagging.
