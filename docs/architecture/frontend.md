# Frontend architecture

The frontend is a single-page React application built with Vite. It
uses Carbon Design System (g100 dark theme), ECharts for data
visualization, and React Router for client-side navigation. Data
comes from the Go backend via REST, SSE, and a few WebSocket
endpoints.

## Directory layout

```
client/src/
├── api/
│   └── client.js             apiClient singleton — every API call
│                             goes through this. Builds URLs,
│                             injects auth header, array-aware query
│                             serialization, typed helpers per domain.
├── components/
│   ├── controls/             Control renderers + registry
│   │   ├── ControlRenderer.jsx
│   │   ├── controlRegistry.js
│   │   ├── controlTypes.js
│   │   ├── ControlButton / ControlToggle / ...
│   │   ├── GarageDoorSVG / TileGarageDoor / ControlGarageDoor
│   │   ├── useControlState / useControlCommand
│   │   └── controls.scss
│   ├── frigate/              FrigateCameraViewer, FrigateAlertsGrid
│   ├── weather/              WeatherDisplay
│   ├── shared/               TagInput, TagFilter, tagsApi
│   ├── icons/                Custom SVG icon components
│   ├── mode/                 Mode toggle (Design / View / Manage)
│   ├── navigation/           Per-mode nav
│   ├── DynamicComponentLoader.jsx   Runtime React code evaluator
│   ├── ComponentEditor / ComponentEditorModal / ControlEditor / DisplayEditor
│   ├── SQLQueryBuilder / PrometheusQueryBuilder / EdgeLakeQueryBuilder
│   ├── MQTTTopicSelector / ComponentPickerModal / ...
│   └── ...                   editor modals, preview panes, pickers
├── config/
│   └── layoutConfig.js       MODES enum, layout-dimension defaults
├── context/                  React contexts (mode, theme)
├── hooks/
│   ├── useData.js            Data-fetching hook
│   ├── useComponents.js      Component list / refresh
│   ├── useDatasources.js     Datasource list / refresh
│   ├── useIsMobile.js        950px viewport breakpoint flag
│   ├── useDashboardData.js   Dashboard fetch/refresh (shared by both viewers)
│   ├── useRangeConnectionTypes.js   Range-type classification (step/consumer)
│   └── useFilterVariableDiscovery.js Filter-variable value discovery
├── pages/                    Route components — one per top-level view
├── theme/
│   └── carbonEchartsTheme.js ECharts theme wired to Carbon tokens
├── utils/
│   ├── streamConnectionManager.js   Shared SSE connections
│   ├── filterStore.js               Per-page list filter persistence
│   └── dataTransforms.js            Column/row transforms for charts
├── App.jsx                   Root router + auth boundary
└── main.jsx                  Vite entry point
```

## apiClient

`client/src/api/client.js` is a singleton. Every API call on the
frontend goes through it. The singleton holds the current user's
GUID (the value sent in the `X-User-ID` header), normalizes query
parameters (array-aware so tag filters send repeated params
correctly), and exposes typed methods per domain:
`getConnections`, `testConnection`, `getComponents`, `updateComponent`,
`getDashboard`, `getFrigateReviews`, `markFrigateReviewsViewed`,
`getAllTags`, etc.

Hooks and page components **should not** instantiate `fetch` or a
second client. If an endpoint isn't covered by the client, add a
method there.

## StreamConnectionManager

Real-time data uses a singleton `StreamConnectionManager` in
`client/src/utils/streamConnectionManager.js`. Multiple components
subscribing to the same datasource share one SSE connection — their
topic filters are combined into one subscription, and records are
dispatched to callbacks by client-side topic matching. See
[streaming.md](streaming.md) for the full protocol including the
30-second grace period on reconnects and the retained-state cache
that repopulates late subscribers.

## Pages

```
src/pages/
├── App-level routing lives in App.jsx
├── ConnectionsPage / ConnectionDetailPage
├── ChartsListPage / ChartDetailPage  (components list and editor)
├── DashboardsListPage / DashboardDetailPage
├── DashboardViewerPage          Main view-mode dashboard runner,
│                                 also hosts the edit-mode layout
│                                 editor now that DashboardDetailPage
│                                 has been folded in
├── DashboardTileViewPage        Tile-layout variant
├── ViewDashboardsPage            Sidebar-driven view-mode shell
├── KioskPage                     Chromeless status-board surface
│                                 (/kiosk) — rotates dashboards, no
│                                 app shell. See "Kiosk surface" below
├── Users / Settings / Devices / DeviceTypes   Manage mode
├── AIBuilderPage                 Standalone AI session page
└── LoginPage
```

`DashboardViewerPage` (view mode) and `KioskPage` both render the
shared presentational `components/DashboardGrid.jsx` — the read-only
panel grid + fit-mode transform, extracted from the viewer so the
kiosk reuses it without the editor chrome. Panel-grid styling lives in
`DashboardGrid.scss` and native text-panel styling in `PanelText.scss`
(co-located with their components, not the viewer page), so both
surfaces style identically.

Most pages call `apiClient` directly for their data, but a few
(dashboards, components) use shared hooks (`useData`, `useComponents`,
`useDatasources`) so list data can be shared across multiple
components on the same page.

## DynamicComponentLoader

Components (the chart sub-type, primarily) are stored in MongoDB as
strings of JavaScript source code. At render time,
`DynamicComponentLoader.jsx` evaluates that source inside a controlled
scope and returns the resulting React component. The scope contains:

- React hooks: `useState`, `useEffect`, `useMemo`, `useCallback`,
  `useRef`, `useContext`
- ECharts: `echarts`, `ReactECharts`
- Carbon themes: `carbonTheme`, `carbonDarkTheme`
- Data utilities: `toObjects`, `getValue`, `formatTimestamp`
- Data props: the component's query result as `{ columns, rows }`

This is how AI-generated component code makes it from the AI Builder
session into a live dashboard panel without a build/deploy cycle.

## Control renderer and registry

All controls — buttons, toggles, sliders, switches, dimmers, lights,
tiles, garage door, text labels — are rendered by `ControlRenderer.jsx`.
The renderer consults a global registry (`controlRegistry.js`) to
resolve `control.control_config.control_type` to a concrete React
component. Each concrete control module self-registers at import
time via `registerControl(type, Component)` so adding a new control
requires no manual wiring in the renderer.

Key rules:

- Controls that can't write (`canWrite: false`) are automatically
  passed `readOnly={true}` and don't need a command hook.
- `ControlRenderer` renders a `.control-title` panel header above the
  body for non-tile, non-text-label controls, using
  `control.title || control.name`. **Custom controls must not
  render their own title inside the body** — it creates a visible
  duplicate. The canonical layout is: panel title (from
  `ControlRenderer`) → icon/visual → state readout. See the "Custom
  Control Layout" section in the project `CLAUDE.md`.
- Tile controls (`tile_*`) skip the top title and manage their own
  inline label.

Metadata for each control type lives in `controlTypes.js`:
`CONTROL_TYPE_INFO[type] = { label, description, icon, category,
canWrite, canRead, defaultUIConfig, hidden? }`. The editor UI reads
from this map to populate its type picker and default config.

### State and commands

Controls talk to MQTT via two shared hooks:

- **`useControlState`** — subscribes to the control's state topic
  (derived from `target` by convention) and exposes the current
  value. Used by read-only status controls (garage door, sensors)
  and bidirectional controls (toggle, dimmer, switch) to keep the
  UI in sync with broker state.
- **`useControlCommand`** — sends commands through
  `POST /api/controls/:id/execute` with notification handling
  (success/error toasts). Write-capable controls use this.

### Composite-payload controls and color

Most controls send a scalar — a boolean, a number, a string — which the
device type's command template interpolates into a payload shape via
`{{value}}`. Color bulbs don't fit: a single write carries state,
brightness, and color together, and a key/value template can't express
that shape.

For these, `CommandDef.PassthroughValue` publishes the control's value
*as* the payload, bypassing template interpolation entirely
(`passthroughPayload` in `command_handler.go`). It only applies when the
value is actually an object; a scalar falls back to the template path
rather than publishing something malformed. The built-in
`zigbee-color-light` device type uses this for its `light` and
`tile_light` commands.

Color is asymmetric, which shapes the client code:

- **Write** — Zigbee2MQTT accepts hex directly and converts on the way
  in, so `ControlLight` / `TileLight` send `{"color": {"hex": "#..."}}`
  with **no conversion on the command path**. A wrong conversion there
  would be visible as the wrong color on the light.
- **Read** — every state publish reports `color: {x, y}` with
  `color_mode: "xy"`, whichever form was written. There is no hex echo,
  so `utils/colorXY.js` converts xy → hex for display.

`xyToHex` normalises by the **peak channel** rather than clamping after
fixing luminance. Clamping flattens the bright channels together and
washes saturated colors toward white — a mid blue round-tripped to a
pale cyan, right hue and no saturation, which is easy to miss because
the hue looks plausible. The homelab Homebridge codec this was ported
from clamps, but it reads only *hue* off the result and discards the
washed-out saturation, so the bug never surfaces there.

Because the xy round trip is lossy, the swatch would visibly shift the
instant a color is set. `holdWrittenHex` shows the written hex while
the device still reports something close to it, and yields once the
device's color moves outside tolerance — so an automation recoloring
the bulb is reflected rather than masked.

## Shared tag components

`components/shared/`:

- **`TagInput.jsx`** — creatable input with autocomplete against a
  shared tag pool. Used in every edit form (connection, component,
  dashboard).
- **`TagFilter.jsx`** — multi-select dropdown scoped to a specific
  entity type, shows usage counts. Used in every list page and the
  component picker modal.
- **`tagsApi.js`** — session-level cache of the merged tag pool plus
  an `invalidateTagsCache()` function called after saves to force a
  re-fetch.

The shared pool is backed by `GET /api/tags`, which aggregates
`tags` arrays across connections, components, and dashboards. Tag
normalization (lowercase + kebab + dedupe) happens on the backend
during save, and the frontend mirrors the same normalization in
`TagInput` so the chip preview matches what will actually be
stored.

## Dashboard viewer and fit modes

`DashboardViewerPage.jsx` is the central runner for view mode. It
handles:

- Fetching the dashboard and its referenced charts/controls/displays
- Rendering the grid
- Applying the user's fit mode (Actual / Fit to window / Fit to
  width / Stretch to fill) — see [grid-system.md](grid-system.md)
- Running the auto-refresh loop
- Entering and exiting edit mode (which overlays a drag/resize
  editor on the same grid)
- Saving layout changes, dashboard settings, and tags

Because dashboards can contain a mix of charts (ECharts), controls
(device-facing), displays (Frigate camera, weather, alerts grid),
and native text panels, the viewer has a small dispatcher that
renders each panel's content type accordingly:

```jsx
chart.component_type === 'control'   → <ControlRenderer control={chart} />
chart.component_type === 'display'   → one of:
  display_type === 'weather'         → <WeatherDisplay />
  display_type === 'frigate_camera'  → <FrigateCameraViewer />
  display_type === 'frigate_alerts'  → <FrigateAlertsGrid />
chart                                 → <DynamicComponentLoader />
panel.text_config                    → <PanelText />
```

## Kiosk surface (`/kiosk`)

A dedicated **chromeless, display-only** status board. Unlike the
viewer, `KioskPage.jsx` bypasses the app shell entirely (an early
return in `App.jsx`'s `AppContent` renders only `<KioskPage>` — no
Header, SideNav, or Content wrapper), and renders the shared
`<DashboardGrid>` full-bleed.

Configured entirely from the URL (parsed + cached to sessionStorage by
`utils/kioskMode.js`):

```
/kiosk?dashboards=<entry>,<entry>,…&rotate=<sec>&show-notifications=T&show-pinned=T
```

- **`dashboards`** — an ordered list of **entries**. Each entry is a
  dashboard id with an optional variable: `id` (plain) or
  `id:connection=<connId>` (pre-selects the connection-swap variable —
  see the dashboard-variable feature). The **same dashboard may repeat**
  with different connections, so a single board can rotate one layout
  across hosts (`stats@SRV-001 → @PI-001 → @SRV-002`). Back-compatible
  with the legacy flat id list.
- **`rotate=<seconds>`** — auto-advance interval; the timer pauses when
  the tab is hidden. Absent/0 = manual (no rotation).
- **`show-notifications` / `show-pinned`** — two orthogonal flags for a
  passive notification layer (`KioskNotifications.jsx`): incoming alerts
  toast and age out; globally-pinned alerts persist. Display-only —
  nothing is clickable and it never navigates. `show-notifications=F &
  show-pinned=T` is intentional (a quiet board that still surfaces an
  operator-pinned unresolved issue).

`KioskPage` owns the entry list, the current entry index, and the
rotation; for the active entry it loads the dashboard via
`useDashboardData(id)` and forces that entry's connection onto every
variable-driven panel. It defaults to **stretch** fit (fill the whole
screen) because the dashboard is laid out against the viewer's toolbar
budget that the kiosk doesn't have — see the kiosk caveat in
[grid-system.md](grid-system.md).

> **Auth:** `/kiosk` works under a normal authenticated session today.
> A truly unattended board (system user / secret URL, no human) depends
> on the kiosk-auth strategy — see [auth-modes.md](auth-modes.md).

## Mobile viewer (phone viewport)

The desktop viewer lays panels on a fixed 32×32-px cell grid scaled to
fit by a single CSS `transform`. On a phone that's an illegible shrunk
or squashed desktop layout, so a narrow viewport gets a different render
path instead: **`pages/MobileDashboardViewer.jsx`**, a **view-only,
vertically-stacked** surface.

- **Detection + routing.** `hooks/useIsMobile.js` (a `matchMedia(
  '(max-width: 950px)')` hook — the app's single mobile breakpoint;
  950px so larger phones in landscape still get mobile, not a shrunk
  desktop grid) drives an `isMobile` flag in `App.jsx`'s `AppContent`.
  The mobile-only SCSS media queries (tile-picker Filters collapse,
  notification-panel re-anchor) are kept at the same 950px so CSS and JS
  agree on when mobile is active. When set, the `/view/dashboards/:id` route
  renders `MobileDashboardViewer` instead of `DashboardViewerPage`, and
  the header sheds its authoring/admin affordances (ModeToggle,
  Assistant launcher, NamespacePicker, side nav) — leaving logo, Help,
  Notifications, and the account menu. Same origin/port/build serves
  both; the choice is purely runtime viewport width.
  `MobileDashboardViewer` is a **`lazy()` import behind `Suspense`**, so
  it code-splits into its own chunk — desktop sessions never download or
  evaluate the mobile-only page. The dashboard **picker**
  (`/view/dashboards`) is the existing `DashboardTileViewPage`; its
  mobile CSS collapses the filter/sort controls behind a **Filters**
  toggle (search stays visible) so tiles aren't pushed below a tall
  toolbar, and constrains the tile grid so it can't overflow the
  viewport width. Desktop tile layout is unchanged (the collapse wrapper
  is `display: contents` above the breakpoint).
- **Render model.** The author's `x/w/h` grid geometry is **discarded**.
  Panels are sorted by `(y, x)` and rendered full-width, one per row,
  scrolling down — so any existing dashboard is readable on a phone with
  no re-authoring. There is no fit-mode transform.
- **Reuse (streaming-safe).** It renders the same leaf the grid does —
  `components/PanelContent.jsx` — so a streaming chart keeps its
  `StreamConnectionManager` subscription (streams open lazily per-panel
  deep inside `PanelContent → useData`; rendering the same component
  type is all that's needed). Data and resolver wiring come from the
  shared `useDashboardData` + `useDashboardVariable` hooks, and the
  per-panel derivation from `utils/derivePanelProps.js` — the same pure
  helper `DashboardGrid` uses, so the three render paths (grid, kiosk,
  mobile) stay in sync. It wraps the stack in
  `RefreshableComponentsProvider` and closes streams on unmount, exactly
  like the viewer.
- **Row sizing.** Without the grid transform to borrow a size from, each
  row gets a deterministic height by content kind (charts a landscape
  box, tiles/controls compact) in `MobileDashboardViewer.scss`. Heights
  use `min(<vw>, <vh>)` as the preferred clamp term so a **short
  landscape** viewport clamps the row down instead of overflowing (a
  plain `vw` box made a gauge taller than the whole landscape screen).
  The one component that needed a code fix is the value tile:
  `ValueView` renders its value at a fixed inline `px` size that only
  reads correctly when the grid is transform-scaled, so the mobile row
  (a CSS *size container*) caps it container-relative via the
  `.value-view__value` hook — desktop rendering is unchanged.
- **Per-panel fullscreen.** Each chart/display row carries an expand
  button; tapping it opens an **edge-to-edge overlay** (`position:
  fixed; inset: 0`, above the header) showing that one panel. There is
  no overlay header bar — the component renders its own title and a
  close (×) button floats over the top-right corner (Esc also closes).
  The overlay renders a **separate** `PanelContent` instance for the
  panel (via the shared `renderPanelBody` helper, so props match the
  inline row exactly); because streams are shared per-connection through
  the `StreamConnectionManager`, the fullscreen copy streams alongside
  the inline one — the same approach the desktop `ComponentExpandModal`
  takes. Rotating to landscape gives a wide chart the full width.
- **Variable pickers.** A **Variables** toggle in the title bar (shown
  only when the dashboard defines a variable) expands a collapsible panel
  with the connection-swap / filter / range controls. These are the SAME
  controls the desktop toolbar uses — `ConnectionSwapPicker`,
  `FilterVariablePicker` (over the shared `useFilterVariableDiscovery`
  hook), and `DashboardRangePicker` were extracted so both viewers render
  one implementation. Range classification is shared the same way:
  `useRangeConnectionTypes` resolves the range-scoped connection type set
  and derives `rangeConnType` / `rangeSupportsStep` / `rangeHasConsumer`,
  so the step dropdown and the hide-when-no-consumer gate behave
  identically on desktop and mobile. The filter picker keeps full parity, including
  connection-discovered values (DISTINCT / one-shot / newest) and the
  live-recapture modal for raw socket/mqtt.
- **Phase 1 scope.** No `dashboardCommand` MQTT subscription and no
  per-dashboard mobile layout yet — those are follow-ups.

## Component title sizing and chart text (the `textStyle` gotcha)

There are **two independent font systems** in a rendered chart panel, and
they don't share a size — a recurring source of confusion, so it's worth
being explicit.

**1. The component title band — HTML, scalable.** Every spec-driven
component renders its title in an HTML band *outside* the ECharts canvas:
`ChartShell.jsx` (line/bar/area/pie/gauge/scatter), `ValueView.jsx`
(value tiles), `DataViewGrid.jsx` (data views), and the
`.chart-name`/`.chart-header` path in `DashboardViewerPage.scss`
(datatable). The font size is:

```
fontSize: calc(0.875rem * var(--title-scale, 1))
```

- **Base = `0.875rem` = 14px.** Hardcoded in those four places (kept in
  sync deliberately). This is the *default* title size.
- **`--title-scale`** is set on `:root` by `App.jsx` from the admin
  setting **`title_font_size`** (50–200%, default 100 → multiplier 1.0).
  One variable scales every component title consistently. It applies on
  next page load (read once when identity resolves).

So a title renders at `14px × (title_font_size / 100)` — 14px at 100%,
12.6px at 90%, 28px at 200%. The band *height* (`2.5rem` ≈ 40px) scales
by the same `--title-scale` so the band always fits the text.

**2. ECharts in-canvas text (axis labels, legend, tooltip) — fixed 12px,
NOT theme-controlled.** This is the gotcha. The `carbon-dark` theme
(`theme/carbonEchartsTheme.js`) sets a global `textStyle.fontSize: 14`,
which *reads* like "all chart text is 14px." **It is not.** ECharts does
**not** cascade the global `textStyle.fontSize` into `axisLabel`,
`legend.textStyle`, or `tooltip.textStyle` — each of those carries its
own built-in default of **12px** (see `echarts/lib/coord/axisDefault.js`,
`lib/component/legend/LegendModel.js`, `lib/model/globalDefault.js`), and
the component-level default wins. The theme only changes a font size
where it sets one *explicitly* — which is just the ECharts `title` (16px,
**unused** because we render the title in HTML) and the gauge detail
(set in `chart-spec/specs/gauge.js` from the `gaugeValueFontSize` option:
24px on the Classic gauge style, 22px on Modern, and author-editable in
either). So the theme's
`textStyle.fontSize: 14` is effectively inert for the text you actually
see on a chart.

**Net rendered sizes:**

| Text | Renders at | Set by |
|------|-----------|--------|
| Component title band (HTML) | 14px × `title_font_size`% | `0.875rem` base + `--title-scale` |
| ECharts axis labels | **12px** | ECharts default (theme's 14 ignored) |
| ECharts legend | **12px** | ECharts default (theme's 14 ignored) |
| ECharts tooltip | 12px | ECharts default |
| ECharts `title` | 16px | theme — but unused (HTML band instead) |
| Gauge detail value | 24px Classic / 22px Modern, author-editable | `specs/gauge.js` ← `gaugeValueFontSize` |

The 14px title base was chosen to sit proportionately with the 12px
in-canvas text. If you ever want the chart's axis/legend text to honor
the theme's stated 14, you must set `axisLabel.fontSize` /
`legend.textStyle.fontSize` **explicitly** in *both* theme blocks
(`carbonLightTheme` and `carbonDarkTheme`) — the global `textStyle`
won't do it. That's a visual change to every chart in every deployment
(denser tick labels, possible rotation/skip), so it's a deliberate
product decision, not an inheritance fix.

## Dashboard commands (MQTT)

The viewer subscribes to a single MQTT topic for "dashboard
commands" — JSON messages that drive UI actions (advance an alert,
dismiss a modal, etc.) from a voice assistant or kiosk controller.
The connection and topic are admin settings
(`dashboard_command_connection`, `dashboard_command_topic`); when
either is unset the subscription is skipped.

Message shape:

```json
{ "target": "frigate-alert", "action": "next" }
```

The viewer stores the latest command in state and passes it as a
prop to panel components. Each component compares
`dashboardCommand.target` to its own target string and switches on
`action`. Unknown targets and actions are ignored.

**Current scope — frigate-alert only.** As of v0.18.2 the only
component that consumes dashboard commands is `FrigateAlertsGrid`
(`target: "frigate-alert"`). Supported actions: `show` /
`show_alert`, `reviewed` / `dismiss`, `next`, `previous`, `close`.
No other component (charts, weather, controls, other displays) acts
on these messages today.

**Operational note — safe to leave unset.** The sole purpose of
this channel today is letting a **voice assistant / kiosk** drive the
Frigate alerts viewer hands-free ("show alert", "next", "mark
reviewed"). If a deployment does **not** use the Frigate alert
module from a kiosk, **leave `dashboard_command_connection` (and/or
`dashboard_command_topic`) blank in Manage → Settings.** Both keys
are seeded with empty-friendly defaults; when either is empty the
viewer's `setupCommandSubscription` effect returns early — no MQTT
connection is opened, **no error is logged, and nothing else is
affected** (chart data, streaming, refresh all run normally). When
both *are* set, **every** open viewer subscribes — opening the MQTT
connection and its ~5 paho goroutines — **regardless of whether the
dashboard contains a Frigate alerts panel.** So on a server with the
command settings populated but no kiosk in use, clearing the
connection setting removes an always-on MQTT cost with zero
functional regression (you only lose voice/kiosk control of Frigate
alerts).

> **Why a side-channel and not the component's own stream?** Frigate
> is a **REST passthrough**, not a streaming connection
> (`FrigateAlertsGrid` self-polls `getFrigateReviews` on a timer; there
> is no `internal/connection` Frigate adapter and no
> `StreamConnectionManager` subscription to ride a command in on). A
> streaming component *could* receive commands inline on its own
> connection by topic; Frigate can't, so the global command bus fills
> that gap. Consolidation (inline-on-stream for streamable components,
> retire/scope the global bus, per-instance topic routing) is tracked
> in trv-outpost#134.

**No per-instance routing.** The topic is a single global setting,
so every connected viewer subscribes to the same topic and acts on
every command whose `target` matches a component it happens to be
rendering. In practice this is fine because the feature is only
used on the home kiosk, but if multiple viewer sessions are open
with a Frigate alerts panel loaded, a single command will fire on
all of them. A future per-instance scheme (treating the configured
topic as a prefix and appending a client id, e.g.
`dashboard/cmd/<client_id>`, so each viewer subscribes only to its
own subtopic) is possible but unimplemented.

## Styling

SCSS co-located with components (`Foo.jsx` + `Foo.scss`). The g100
dark Carbon theme is enforced globally in `App.scss`. Components
should use Carbon CSS custom properties (`var(--cds-text-primary)`,
`var(--cds-background)`) and Carbon spacing tokens rather than
hard-coded colors or pixel values. Exceptions are unavoidable when
dealing with ECharts options, which take concrete colors.

## Build tracking

`client/build.json` holds an integer build number that's
incremented on every functional change. The value shows up in the
Manage-mode footer and in logs so kiosk displays can confirm which
build they're running.

## Related docs

- [Backend architecture](backend.md) — what the frontend talks to
- [Streaming](streaming.md) — SSE mechanics
- [Grid system](grid-system.md) — cell geometry, fit modes,
  layout presets
- [API reference](api-reference.md) — endpoint tables
- [Data model](data-model.md) — the shapes coming from the API
- [Dashboard rendering](../design-notes/dashboard_rendering.md) —
  deep dive on thumbnail capture and chart preview rendering
