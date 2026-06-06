# Changelog

All notable changes to TRV Outpost. This file is started at v0.6.0;
prior releases are described in the git history (see `git tag`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.28.0] — 2026-06-05

Per-panel component-swap rules for dashboard variables, plus the container
image / Electron env-var rebrand and a crash-isolation hardening pass.

### Added

- **Per-panel component-swap rules.** A dashboard panel can now render a
  *different component* depending on the active dashboard-variable value.
  Each panel has a DEFAULT component plus an ordered list of rules; the
  first rule whose predicate matches the active variable wins. A predicate
  tests either the variable's **value** (subject `VARIABLE`) or one of the
  selected connection's prefixed-tag values (subject `TAG`), with operator
  `=` or `CONTAINS`. For a connection-swap variable the matched component
  also reads from the selected connection (component + connection swap
  together); for a filter variable only the component swaps. Authored from
  the panel edit menu's **"Connection-based components…"** item. This
  replaces the former per-panel "Pin connection" toggle.
- **Per-panel error boundary.** A render-time error in one panel's
  component now shows an inline error tile for that panel only, instead of
  blanking the entire dashboard.
- **Stream value-capture modal**: shows a live **records-processed** count
  next to the distinct-value count, and the editor's Fetch now shows
  captured values accumulating live (previously only after Stop). The Stop
  control is a primary button.

### Changed

- **Container images renamed** `dashboard-{server,client}` →
  `outpost-{server,client}` (`ghcr.io/trv-enterprises/outpost-*`),
  finishing the TRV Outpost rebrand. Tags published before this release
  keep the old image names; rollback to a pre-rename version still works.
- **Electron desktop**: the host-injected env vars
  `TRVE_DASHBOARD_{URL,KEY}` are renamed `OUTPOST_DASHBOARD_{URL,KEY}`.

### Migration

- `drop_panel_pin_connection_v1` removes the obsolete `pin_connection`
  field from dashboard panels automatically on first boot of the new
  server image.

## [0.27.2] — 2026-06-05

UI polish + docs. No functional or API changes.

### Added

- **Navigable count popovers** on the design-mode list pages. The
  Connections, Components, and Dashboards lists' count cells (which
  previously showed a read-only hover list of names) are now
  click-to-open popovers with a **clickable** list — pick an item to
  open its editor. The Dashboards count shows two columns (Components and
  Connections).
- Components guide: a **"Why versions exist (and their limits)"**
  subsection — versioning is primarily an AI safety net; manual edits
  don't create per-save snapshots.

### Changed

- **Viewer header refresh section** is more compact: the always-on "Last
  refresh" text is gone; the "Data refresh" pill's tooltip shows a live
  "Next refresh in" countdown.
- **App header namespace control**: a "Default Namespace" tooltip,
  bracketing dividers, and a wider dropdown so longer namespace names
  show in full (hover highlight spans the full row).

## [0.27.1] — 2026-06-05

Product rebrand + documentation + UI polish. No functional or API changes.

### Changed

- **Rebranded to TRV Outpost** across every user-facing surface — app
  header, browser title, About dialog, Swagger title, Electron window,
  AI prompts, docs, and the Postman collection. The JWT issuer default
  is now `trv-outpost` (a non-validated tag, so existing tokens keep
  working). The repository moved to `trv-enterprises/trv-outpost`.

### Added

- **Dashboard Variables** user-guide topic (under both View Mode and
  Editing Dashboards), plus new **System Users** and **AI API Usage**
  pages. The design pages' "Learn more" links now open the matching doc.

### Fixed

- **Component picker** — narrowed the "All Types" filter so the Sort
  control no longer wraps to a second line.
- **Viewer header tooltips** — the fit-mode and actions-menu tooltips now
  align to the bottom like the Export/Fullscreen tooltips, instead of
  opening to the left at a different height.

### Infrastructure

- Bumped the container-publish GitHub Actions to their Node 24 majors
  ahead of GitHub's 2026-06-16 forced migration.

## [0.27.0] — 2026-06-04

### Added

- **Dashboard variables.** One dashboard can serve many sites/systems via
  a dropdown after the dashboard name. Two binding modes: *connection-swap*
  repoints every panel to a chosen connection; *filter* substitutes the
  chosen value into a component's query (server-side, bound/escaped) or
  client-side filter via the `{{dashboard-variable}}` token. The active
  value persists per-user-per-dashboard and is shareable via a URL param;
  a per-panel `pin_connection` opts a panel out of connection-swap.
- **Value discovery for the filter dropdown**, dispatched by connection
  type: SQL/EdgeLake via `DISTINCT`/`GROUP BY`; API and ts-store via a
  one-shot query (ts-store uses HTTP `newest` even in streaming transport,
  so no live wait); raw socket/MQTT via a live SSE capture modal that
  accumulates distinct values in real time with a Stop button (manual stop
  + 1000-record cap + 5-minute safety cap).
- **Persisted discovered lists** on the connection (`discovered_values`,
  keyed by column) for raw stream types, written by an authoring-time
  capture (design capability required) so the dashboard reads them without
  a view-time capture. A session-only **Regenerate** re-captures live.
- **Tag-prefix dropdown labels** for connection-swap
  (`ConnectionSwapConfig.label_tag_prefix`): label each option from the
  connection's first `<prefix>:` tag (e.g. `host` → `trv-srv-001` from a
  `host:trv-srv-001` tag), falling back to the connection name.
- **`{{variable:NAME}}` tokens in text panels**, resolved at view time to
  the variable's display value, insertable from a pill. The text-panel
  editor is now an Apply/Cancel modal that dirties the dashboard.

### Changed

- **View → Design with a dashboard open** now opens *that* dashboard in
  the editor (design-originated) instead of the design list; switching
  back to View restores view-origin.

### Fixed

- **API connections with a bare `?limit=…` query string** now append it
  to the base URL (preserving the path), instead of treating it as a path
  segment — which produced an upstream 404.

## [0.26.1] — 2026-06-02

### Fixed

- **Kiosk timeouts/crashes when rotating through a slow connection.** The
  kiosk remounted the entire grid on every rotation, which crashed
  ECharts' resize cleanup and fired a burst of simultaneous per-panel
  requests that timed out against slow backends. The grid now updates in
  place (a different dashboard still remounts; the same dashboard with a
  different connection re-subscribes per panel). Concurrent
  `getConnection` calls for one connection are also coalesced + briefly
  cached, so N panels on one connection make one type-fetch, not N
  (benefits the viewer too).
- **Editor "Zoom to fit" undershoot.** It measured the extended grid
  (dimension boundary *or* panel extent) rather than the design canvas,
  so a panel placed past the boundary shrank the fit below what fit.
- **"Zoom to fit" used a stale canvas size.** It read cached container
  dimensions, so collapsing the left nav (to reclaim width) before
  clicking fit didn't use the new size; it now measures live.

### Changed

- **Editor zoom control** — replaced the `100% / Zoom to fit` dropdown
  with an inline `{zoom}%` readout (click to reset to 100%) plus a
  dedicated Fit button, grouped as one unit and separated from the Scale
  control.

## [0.26.0] — 2026-06-02

### Added

- **Kiosk status board (`/kiosk`).** A dedicated chromeless, display-only
  surface for wall monitors and unattended displays — no app header,
  toolbar, or controls, just the dashboard grid full-bleed. Configured
  entirely from the URL:
  - **Rotation** — `?dashboards=<entry>,<entry>,…` is an ordered list of
    entries; `?rotate=<seconds>` auto-advances through them (pausing when
    the browser tab is hidden). Manual when `rotate` is absent.
  - **Per-entry connection** — an entry can pin a connection
    (`id:connection=<connId>`), and the **same dashboard may repeat** with
    different connections, so one layout rotates across hosts
    (`stats@SRV-001 → @PI-001 → @SRV-002`). Reuses the dashboard-variable
    connection-swap. Back-compatible with a plain id list.
  - **Passive notifications** — `?show-notifications=T` pops incoming
    alerts as auto-dismissing toasts; `?show-pinned=T` keeps
    globally-pinned alerts visible. Both orthogonal and display-only
    (nothing is clickable, the board never navigates).

### Changed

- **Extracted a shared `<DashboardGrid>`** — the read-only panel grid (and
  its fit-mode math) is now a standalone component used by both the
  dashboard viewer and the kiosk, with its styling co-located in
  `DashboardGrid.scss` / `PanelText.scss` instead of scoped to the viewer
  page. No behavior change for the viewer.

## [0.25.0] — 2026-06-01

### Added

- **Dashboard Variable (connection-swap).** A dashboard can define a
  variable — a dropdown in the viewer header, next to the dashboard
  name — that re-scopes every panel to a selected connection at view
  time. One "system dashboard" can then serve many hosts/systems: pick
  a host and all panels read from that host's connection. Enabled per
  dashboard (Dashboard Settings → Dashboard Variable toggle) on top of a
  global admin switch (`dashboard_variable.enabled`).
- **Candidate discovery by tag.** The dropdown lists connections that
  carry *all* of the variable's configured tags (AND match), discovered
  across namespaces by default (a "Same namespace only" toggle restricts
  it). The connection the panels currently use is always offered. A
  schema-compatibility check annotates candidates (defaults to matching
  connection type).
- **Per-panel connection pin.** Every panel follows the variable by
  default; a panel can opt out via "Pin connection" in its edit menu
  (e.g. a shared overview panel that shouldn't swap).
- **"Dashboard Variable" text-panel content type** — a native text panel
  can display the currently-selected connection's name, updating live as
  the host changes.
- **Selection persistence** — the chosen host is remembered per user per
  dashboard, and is shareable via a `?var_…` URL parameter (URL wins).
- New endpoint `GET /api/dashboards/:id/variable-candidates`.

### Changed

- The default-dashboard lookup now goes through the authenticated API
  client instead of a bare `fetch` (the old path 401'd silently).

### Fixed

- **Dashboard name field in edit mode** no longer stretches its focus
  underline across the whole header or force-wraps the edit toolbar — the
  input now sizes to its content.

## [0.24.1] — 2026-06-01

### Added

- **Editor "Zoom to fit."** The edit-mode zoom `100%` control is now a
  dropdown (100% / Zoom to fit). "Zoom to fit" shrinks the design canvas
  so the whole dashboard fits the editor's visible area (shrink-only).
- **Scale control tooltip** explaining build-scale and how it differs
  from the editor's Zoom (Scale is saved and enlarges the rendered
  dashboard; Zoom only magnifies your editing view).

### Changed

- **Component title default lowered 16px → 14px** so titles sit in
  proportion with ECharts axis/legend text (which renders at 12px). The
  `title_font_size` admin setting still scales from this new base.
- **AI prefers tooltip mode `multi` for line/area/bar charts** — the
  agent was setting `single` (per-point hover) on area charts, which
  feels unresponsive on marker-less charts.

### Fixed

- Settings changes could appear not to take effect until a second
  reload — the settings API now sends `Cache-Control: no-store`, so a
  change applies on the next page load (surfaced via `title_font_size`).
- Stray focus box on the namespace `(i)` info button after clicking it.
- "Dashboard settings" gear tooltip clipping off the right edge of the
  screen.

## [0.24.0] — 2026-06-01

### Added

- **Dashboard build-scale.** Each dashboard can be designed at a scale
  (50–200%): you author against `target ÷ scale` and the viewer
  CSS-transforms the whole canvas back up to the target dimension, so
  every chart's text and lines enlarge uniformly with proportions
  preserved. Edit mode shows a live scale control and a single boundary
  line; at 100% you see actual size. The scale travels with the
  dashboard and the AI understands it.
- **Per-dimension default scale.** A new Manage → dimension setting lets
  admins say e.g. "4K boards default to 120%." New dashboards seed their
  scale from the dimension's default (then become independent); the
  designer and the AI can override. The AI catalog reports each preset's
  cols×rows *already at its default scale*, so the agent plans to the
  adjusted budget without doing fragile rate-math.
- **AI API Usage admin page** with a unified `ai.enabled` gate and a
  per-user budget override.
- **"Measure screen size" helper** in the viewer overflow menu —
  requests fullscreen and reports the real usable width/height, since
  published dimensions overstate the area the OS actually leaves for the
  dashboard.
- **`title_font_size` admin setting** — scales component title font and
  title-band height.
- **`stream_buffer_size` admin setting** (default 1000) — client-side
  streaming buffer depth.
- **Number chart value formatting** — duration / compact / datetime
  formats and a decimal-places option, exposed to both AI agents.
- **banded_bar band-scheme selector** (±SD / Min-Mean-Max / SPC).
- **Custom-code indicator** on the dashboard edit-mode panel header.

### Changed

- **Streaming time-series default to a 1h sliding window** with a
  higher backfill paint (1000 points); the zoom slider no longer resets
  on each incoming point.
- **Auto x-axis timestamp format** for line/area/bar — granularity
  resolves from the data; explicit formats are never overridden.
- **Grid chrome corrected 109→57px** so dashboards fill the fullscreen
  viewer (no app header above a displayed dashboard — only the toolbar
  is reserved). "Actual" size is now pixel-accurate.
- **Dashboard Assistant** updated to current Claude models, reads
  connection guidance before building queries, plans the full dashboard
  before creating components, tags what it creates, and packs rows
  contiguously. Catalog now returned as markdown (no extra round-trip).
- **Both AI agents share a chart-options schema** (toolops layer) and a
  config-first / custom-only template stance aligned with spec-driven
  charts.
- **The dashboard-agent CLI was removed** — superseded by the in-app
  Dashboard Assistant.

### Fixed

- Stray focus-box on the first item of every OverflowMenu (fit-mode,
  pencil, dashboard-actions, account) when opened with the mouse — it
  was our own `:focus` override painting a ring on Carbon's programmatic
  open-focus; now scoped to `:focus-visible` (keyboard only).
- Streaming "Invalid access token" — stable dev `jwt_secret` plus a
  token refresh on the first stream error before reconnecting.
- Dev session dying after ~15 min — proxy `/api` through Vite so the
  refresh cookie is same-origin.
- AI Builder spec-driven chart previews: number-chart blank preview,
  stuck-loading, and static single-series demo.
- Spec-driven chart create regression in server codegen.
- EdgeLake database param dropped on chart save in ComponentEditor.
- Stale default-dashboard pointer now cleared (and the user notified)
  when the referenced dashboard was deleted.
- Delete-component crash from an undefined chart in a dashboard cell.

## [0.23.0] — 2026-05-29

### Changed

- **Spec-driven chart refactor complete (Stage 3).** Every chart type
  now derives its editor and render from a JSON spec + a small render
  function; the legacy per-chart-type editor JSX and the
  string-templated `getDataDrivenChartCode` branches have been removed
  (~1,200 lines), along with the `chart_editor_spec_driven` /
  `chart_codegen_spec_driven` feature flags (the spec path is now the
  only path). No user-facing behavior change — an internal cleanup that
  makes adding/maintaining chart types substantially simpler. `custom`
  remains the escape hatch for hand-written code.

## [0.22.0] — 2026-05-29

### Added

- **Spec-driven migration complete for every chart type.** banded_bar
  (Levey-Jennings) now derives its editor + render from a spec +
  `buildOption`, including all four visual styles. The two non-ECharts
  types — **number** and **dataview** — migrate via a new tagged
  view-descriptor contract + view registry (`buildOption` returns
  `{render, props}` rendered by a registered React view instead of an
  ECharts option), so they're config-driven without being forced through
  ECharts.
- **Banded-bar legend panel** — show toggle + position (top/bottom/left/
  right), default on/top.
- **Per-component "show title" toggle** — hide a chart's title on the
  dashboard to reclaim its vertical space (uniform across all chart
  types). Pairs with a Text panel for custom/giant titles.
- **Text panel font sizes up to 400px** (was 48), matching the Number
  component's range so a Text-panel title can be sized to a giant Number.

### Changed

- **Client-side transform panels grouped** under one "Client Side
  Processing" section (Filters, Aggregation & Sorting, Sliding Window,
  Time Bucket as subsections).

## [0.21.0] — 2026-05-29

### Added

- **Spec-driven chart editor + renderer (Stage 2).** Line, area,
  bar, banded-bar, scatter, pie, and gauge charts now derive their
  editor fields and ECharts options from a JSON `ChartTypeSpec` plus
  a small per-type `buildOption(values, data)` render function,
  replacing the per-chart-type hand-written JSX and string-templated
  codegen. New chart options surfaced along the way: per-column stack
  + axis assignment, y-axis range (min/max/log scale), tooltip mode,
  y-axis thresholds (markLine / visualMap), and sampling.
- **Number chart type restored to the picker.** `chart.number` is
  now registered in the backend type registry; it had been missing
  since the registry was introduced, so the catalog filtered it out
  of the selector.

### Changed

- **Chart type selector** redesigned to a card grid of icon-above-
  label tiles (matching the control type selector), all types in one
  flowing grid.
- **Dual-axis is now an explicit choice.** Adding a second y-column
  no longer auto-engages a second axis — the dual-axis toggle defaults
  off and only turns on when the user flips it. (Pre-existing
  two-column charts that relied on the old "2 columns ⇒ dual-axis"
  convention render single-axis until the toggle is set.)

### Fixed

- **Inline chart editor closed silently while dirty.** The
  discard-changes confirmation in `ComponentEditorModal` was wired up
  but never triggered; cancelling/closing a dirty editor now prompts.
- **Saved dual-axis charts could render single-axis.** The dual-axis
  flag is persisted on `options.multipleYAxis` but the renderer only
  read `data_mapping.multiple_y_axis`; the renderer now reads both, so
  an explicit dual-axis toggle survives a save round-trip.
- **Live data streams died silently on access-token expiry.** SSE and
  WebSocket connections bake the token into their URL at open time and
  can't refresh it in flight, so streams (MQTT, ts-store push, Frigate
  alerts, AI chat) stopped ~15 min in. The API client now refreshes the
  token proactively before expiry and reconnects open streams onto the
  fresh token. (Regular requests already auto-refreshed and retried.)

## [0.20.1] — 2026-05-27

### Fixed

- **SQL / EdgeLake / Prometheus / API queries failed with
  "query is required."** ComponentEditor's `fetchPreviewData`
  was POSTing the Query object flat (`{raw, type, params}`)
  instead of wrapped in `{query: {raw, type, params}}` as the
  server expects. Gin's JSON binder accepted the flat shape
  with `Query=zero` and the adapter rejected. tsstore silently
  masked the bug by falling back to "newest" + default row cap
  when `raw` was empty.
- **EdgeLake Raw mode rejected every query with "database
  parameter is required for EdgeLake queries."** Visual mode
  collected the database via `EdgeLakeQueryBuilder` but Raw
  mode had no field. Raw mode now exposes a Database `<Select>`
  populated from `list_edgelake_databases`, half-width, above
  the SQL textarea.
- **tsstore custom-code charts rendered "No data available"
  in Preview.** The editor's chart-load logic only restored
  `tsstoreQueryType` / `tsstoreLimit` when
  `query_config.type === 'tsstore'`, but agent-built charts
  save `type: "api"` while still using the tsstore DSL on
  `raw`. Dispatch now reads the raw-string shape
  (`since:DURATION` / `newest` / `oldest`) instead.
- **Custom-code mode showed a misleading Details tab.** Hidden
  entirely when `use_custom_code` is on; tabs are Preview /
  Code only. The connection + query are already shown inline
  inside the custom code, and the Details tab's Fetch Data
  button doesn't drive custom code anyway.
- **ControlEditor UI Configuration columns rendered at 37.5%
  instead of 50%.** Carbon's modern Grid is 16-column at lg+,
  so `Column lg={6}` was 6/16 not 6/12. Override the grid
  container to 12 columns inside `.ui-config-section` so
  `lg={6}` = 50%, `lg={4}` = 33%, `lg={3}` = 25% — without
  rewriting 27 Column instances.
- **EdgeLake Raw mode showed a generic SQL placeholder** that
  didn't match the bare-SQL form the adapter wraps. Placeholder
  updated to bare SQL.

### Changed

- **DisplayEditor tile treatment** consistent with the chart
  side. Display Type tile + Frigate Alerts / Frigate Camera /
  Weather config tiles all use the shared `.mapping-section`
  bordered card. Tiles cap at 600px (half the editor
  reference width); form controls inside cap at 580px so
  they have a slight inset from the card padding.
- **ControlEditor tile treatment** matches DisplayEditor.
  Control Type, Connection, Command Configuration, UI
  Configuration all wrapped in `.mapping-section` at 600px.
- **ControlEditor Connection section** now mirrors the
  chart-page picker — H4 header + hover `(i)` Tooltip
  exposing the connection's description, hidden-label Select,
  tag chips beneath (type chip + user tags with a Toggletip
  "+N" overflow when more than 4 chips).
- **ControlEditor Command Configuration** replaced Carbon Grid
  + Column with a flex stack. Device Topic combobox no longer
  truncates inside the narrow tile.
- **ControlEditor Command Configuration empty-state.** Shows
  "Select a connection first." when no connection is
  selected — before, the legacy non-MQTT command form
  (Action / Target / Payload Template) was showing by default
  regardless of control type.

## [0.20.0] — 2026-05-27

### Added

- **Dashboard Assistant (chat agent).** A third AI agent surface, a
  persistent chat sidecard reachable from a header launcher.
  Where the existing Component AI agent lives inside the editor
  and is scoped to one component, the assistant operates across
  the deployment — connections, components, dashboards,
  namespaces. Tiered tool surface: Tier-A tools always loaded,
  Tier-B tools revealed via `describe_tool`. Large tool results
  stored server-side and summarized inline; the agent fetches
  the verbatim payload via `get_full_result` only when it needs
  it. Two-switch gate (`ANTHROPIC_API_KEY` env at deployment +
  the user's `design` capability); the `assistant.enabled`
  admin setting acts as a master kill-switch that defaults to
  on, flip it off to disable the feature deployment-wide.
- **Surface context.** The assistant sees the user's current
  mode (VIEW / EDIT), surface (DASHBOARD / COMPONENT /
  CONNECTION), panel list, and active edits. The agent refuses
  to `update_*` a surface the user is mid-editing.
- **Layout-planning workflow in the assistant's system prompt.**
  Probe data → pick canvas from `get_type_catalog` → outline
  sections → use text-header panels → size by role → create
  components THEN dashboard. Replaces the prior "build it"
  framing that produced sparse layouts.
- **Per-type connection guidance (shared).** The
  `connectionguidance` package now keys on the registry type
  ids (prior ts-store key was unreachable). ts-store guidance
  rewritten with the REST DSL reference (`newest` / `oldest` /
  `since:` / `range:`), default row caps, SQL silent-downgrade
  trap callout, and json / schema / text store-data-type
  variants.
- **Guidance bundled on `get_connection` /
  `get_connection_schema`** in `internal/ai/toolops`. External
  callers (MCP, dashboard-agent CLI, future surfaces) see the
  same cheat sheet alongside the connection or column data.
- **New `GET /api/registry/connections/{typeId}/guidance`
  endpoint.** Surfaces the same text to the human UI; legacy
  short types (`tsstore`, `mqtt`, `sql`) are normalized
  server-side to their registry ids so older callers keep
  working.
- **`ConnectionGuidanceHint` React component.** Renders the
  per-type cheat sheet beside the connection picker in the
  ComponentEditor and on the ConnectionDetailPage as a
  Tooltip-driven (i) hover hint.
- **Catalog exposes `layout_dimensions[]`.** Server computes the
  cell-grid budget for each preset (matching the viewer's fit
  math) so the assistant picks deployment-correct preset names
  instead of guessing canonical ones.
- **Server-side auto-codegen on `create_component`.** When an
  external caller creates a component with `use_custom_code=false`
  and a canonical `chart_type` but no `component_code`,
  `ComponentService.CreateComponent` writes the raw chart
  template server-side. Closes a footgun where agent-built
  charts rendered as "Add" buttons until manually opened + saved.
- **Conversation export (Markdown / JSON).** Cog popover on the
  assistant sidecard exports the active conversation locally.

### Changed

- **ComponentEditor restructured.** "Connection" tab renamed
  "Details". The connection picker and per-type guidance now
  share the Details tab inside `.mapping-section` cards. The
  connection description moves into an (i) hover Tooltip
  alongside the Connection label.
- **Header form pairs Chart Name + Title** (1/2 + 1/2) and
  **Namespace + Tags** (1/4 + 3/4); Description spans the full
  reference width. Frees several rows of vertical space.
- **Chart Type tile and Query / Data Mapping sections** all use
  the shared bordered-card treatment with consistent labeled H4
  headers.
- **Full-width yellow warning above DATA MAPPING** when no
  sample is loaded — clicking "Fetch Data" in the warning runs
  the same handler as the Query section's header button.
  Warning subtitle is connection-aware (SQL/EdgeLake lists only
  Data Mapping; other types list Data Mapping + Filters +
  Aggregation + Sliding Window).
- **Filters / Aggregation / Sliding Window hidden for SQL and
  EdgeLake.** The query language already expresses what those
  sections do; the redundant UI added cognitive load without
  earning its keep. Streaming + REST + Prometheus + MQTT keep
  them.
- **Unified "Fetch Data" button label** across every connection
  type (MQTT mid-capture keeps its dedicated "Stop Capture"
  affordance).
- **Pre-fetch + modify hints normalized** ("No filters
  configured." / "Fetch data to modify filters.") across Data
  Mapping / Filters / Aggregation / Time Bucket. Three
  duplicate `.run-query-hint` SCSS rules consolidated.

### Fixed

- **Drag-frame surface-registration storm** in the dashboard
  viewer. The assistant-surface memo's dep was the live panels
  array; every `setEditablePanels` during drag triggered a
  JSON.stringify + provider re-render at 30+ Hz. Fixed by
  keying the memo on a stable signature (geometry doesn't go
  into the payload, so the memo no-ops while only x/y/w/h
  change).
- **`Intl.DateTimeFormat` allocation hot path.** A chart that
  renders 100 timestamps per refresh tick was constructing 100
  fresh ICU formatters; `formatTimestamp` now caches formatter
  instances per (preset, locale, timezone). Hit ~7s out of 15s
  on the Pi sensehat dashboard's profile.
- **`useAssistantSidecardState` 401 on cold load.** Hook fired
  its `/api/config/user/:id` GET before the auth bootstrap
  completed. Now gates on `apiClient.getAccessToken()` and
  re-fires on `apiclient-authenticated` event.
- **`get_full_result` infinite cycle.** The chat agent's
  result-store re-summarized the meta-tool's payload, producing
  a new result_id the agent then chased. One-line exclusion in
  the agent loop.
- **Loop detector + raised maxTurns.** Builder workflows need
  10-15 turns; previous cap of 8 cut multi-component builds
  short. New cap is 50, with a duplicate-tool-call fingerprint
  detector as the structural defense.
- **NamespacePicker visibility.** Gated on Design capability
  so view-only users don't see authoring affordances.

### API

- New: `GET /api/ai/availability` — exposes `enabled`,
  `component_agent_enabled`, `chat_agent_enabled`.
- New: `POST /api/ai/sessions` (kind=chat),
  `GET /api/ai/sessions/:id/ws`,
  `POST /api/ai/sessions/:id/save`, etc. — chat-agent surface.
- New: `GET /api/registry/connections/{typeId}/guidance` —
  per-type query-config guidance.
- Changed: `GET /api/registry/catalog` (and `.md`) now include
  `layout_dimensions[]`.

### Migration

Existing components created by external callers with empty
`component_code` continue to render the raw template until they
are opened + saved in the editor (the per-column substitution
that `ComponentService.CreateComponent` doesn't do today). The
proper fix — share a single codegen between editor and server
— is captured in `chart-codegen-consolidation-todo` for a
future release.

## [0.19.6] — 2026-05-26

### Added

- **Snippets panel (generic, iTerm-style).** A right-hand
  saved-commands library inside the EdgeLake terminal page. User
  snippets are private; global snippets are visible to everyone and
  editable only by Manage-capable users. Single-click pastes the
  command into the terminal input; double-click pastes and runs.
  Tags become flat folders — a snippet with multiple tags appears
  under each.
- **Six EdgeLake starter snippets** seeded on first boot of any
  deployment that doesn't already have globals for the
  `edgelake-terminal` context: `GET STATUS`, `GET CONNECTIONS`,
  `GET SERVERS`, `TEST NETWORK`, `BLOCKCHAIN GET OPERATOR`,
  `SET DEBUG ON`. Admins who delete a starter keep it deleted.
- **iTerm-style snippet search.** `title:foo`, `text:foo`, `tag:foo`,
  `-foo` negation, `foo|bar` OR, AND-by-default across tokens. Help
  popover behind a `?` icon explains the operators.
- **Generic-by-design snippets API.** New collection + endpoints
  (`GET/POST/PUT/DELETE /api/snippets`) keyed off a `context` field
  so future surfaces (MQTT publisher, ad-hoc SQL tool) can mount the
  same panel without bleeding snippets across. Design in
  `docs/design-notes/snippets-panel.md`.
- **Colorized JSON response renderer in the EdgeLake terminal.**
  Response bodies that parse as JSON now render as a syntax-colored,
  collapsible tree. Carbon semantic tokens for colors so the palette
  tracks the active theme.
- **Five-button JSON action bar** (top-right of every JSON body
  with more than one container): collapse-all, collapse-one-level,
  expand-one-level, expand-all, reset. The level buttons act
  uniformly on every container at the matching depth, so one click
  reveals every operator record's fields on a `blockchain get *`
  payload.

### Changed

- **EdgeLake terminal layout.** Two-column flex when the snippets
  panel is open; transcript and input column shrink to make room.
  Panel toggle lives immediately to the right of the existing Clear
  button. Panel-open state persists per user across devices.

## [0.18.3] — 2026-05-23

### Added

- **AI agent availability gating.** New unauthenticated endpoint
  `GET /api/ai/availability` returns `{ enabled: bool }` derived
  from whether the server was started with `ANTHROPIC_API_KEY`.
  A new client-side `AIAvailabilityContext` reads it once at app
  boot. When AI is disabled, the "Edit with AI" / "New with AI"
  items in the dashboard panel edit menu, the "Create with AI"
  item in the Components-page create menu, and the per-row "Edit
  with AI" wand icon in the Components list (both list and tile
  views) are hidden entirely. The `/design/components/ai/:chartId`
  route redirects to `/design/components` so stale bookmarks
  short-circuit cleanly.
- **`AIBuilderPage` code-split via `React.lazy`.** The AI builder
  is no longer in the initial JS bundle — deployments without an
  API key never download it.

### Changed

- **Copy-id button on dashboard tiles.** Forced the Carbon Tooltip
  open while the "Copied!" label is visible so the click feedback
  is actually seen (the tooltip was closing on click before the
  swap could land).
- **Chart-data modal (AG Grid)**: long column headers wrap onto
  multiple lines instead of truncating, and the header row grows
  to fit. Cell tooltips remain truncation-only via
  `tooltipShowMode="whenTruncated"`.

### Docs

- New "Dashboard commands (MQTT)" section in
  `docs/architecture/frontend.md` covering message shape, current
  frigate-alert-only scope, and the global-topic / multi-instance
  broadcast caveat. The `CLAUDE.md` admin-settings table
  cross-references it.

## [0.18.2] — 2026-05-22

### Added

- **ts-store alert rule wizard reorganized**: Name → Type → Store →
  Send-to → Condition → Policy → Target, with Cancel / Save in the page
  header to match the Connection and Component editors.
- **MQTT alert sink**. New "Type" radio (Webhook or MQTT). MQTT sink
  picks an MQTT-type connection for broker credentials; topic
  auto-prefills to `trve/alerts/<rule-name-slug>` and is overridable;
  QoS 0/1/2 selectable. WebSocket sink intentionally omitted (alerts
  and telemetry would mix on the same socket).
- **Restart-policy radios** on alert rules with an optional max-replay
  window. Defaults preserve old behavior ("start from now, no replay").
- **View-only alert-rule details page** (eye icon on the list) renders
  the editor layout with every field read-only — replaces the previous
  in-place modal.
- **`control` capability**. Independent of `view`; gates the
  control-execution endpoints (button presses, toggles, sliders,
  Frigate "Mark Reviewed"). Existing humans are backfilled to preserve
  behavior; system users default to read-only with an opt-in "Control"
  checkbox for interactive kiosks. View-mode controls render disabled
  with a tooltip when the user lacks `control`; the server enforces
  with a route rule on `POST /api/controls/:id/execute`.
- **Kiosk mode via URL payload**. `?dashboards=id1,id2,id3` locks a
  session to a specific dashboard set in a specific order. URL is
  cleaned after read; cached in sessionStorage so reloads keep the
  lock. Tile picker shows only the locked set with a purple
  "Kiosk mode" badge; the viewer's prev/next arrows walk only the
  locked set. `?clearKiosk=1` resets.
- **Dashboard ID copy** icon next to the dashboard name on every tile
  (Design list, View tile grid, picker modal). Tooltip shows the full
  UUID; click copies to clipboard.
- **Shared `<DashboardTile>` component** with `badge` and `actions`
  slots, drag-and-drop props, descriptionMode, and onClick /
  onDoubleClick. Replaces three separate tile implementations across
  the View grid, Design grid, and the alert-rule dashboard picker
  modal. Uniform tile height regardless of description or tag count;
  reserved meta-row area with anchored bottom row for the comps + conns
  chips.

### Changed

- **Manual sort on the Design dashboards page** ("Manual (drag to
  reorder)") shares the per-user order keys with View mode — change
  order in one place, the other sees it.
- **Tile-page filters persist across navigation** (namespace, tags,
  connection, search) via sessionStorage. The viewer's prev/next
  arrows honor the filtered set.
- **DataView (table chart)** components render newest rows first by
  default.
- **Refresh affordance only when refreshable**: the toolbar Refresh
  button and "Data refresh: Ns" pill hide on streaming-only
  dashboards.
- **Prev / Next dashboard tooltips** show the keyboard shortcut
  (`⌥←` / `⌥→` on macOS, `Alt←` / `Alt→` elsewhere).
- **Connection-list display** collapsed from inline connection names
  to a "N conns" chip with a tooltip listing names (matches the
  alert-rules dedupe pattern). Component count on tiles only counts
  panels with a `component_id`, not total panel slots.

### Fixed

- Notification panel rendering in fullscreen, and several System Users
  page copy fixes.

## [0.18.1] — 2026-05-20

### Added

- **ts-store schema discovery from any tsstore connection** (WS or
  API, json or schema data type). Server samples the 10 newest records
  and unions their keys so the alert-rule editor can render field
  pills with drag-and-drop and click-to-insert above the condition
  textarea.
- **Zoom Slider toggle** on the line/area/bar component editor, with
  reserved `grid.bottom` room for axis labels and the slider stack.

### Changed

- **Alert-rule list collapses by backend**, so WS+API connections
  pointing at the same ts-store backend no longer show duplicate rows.
  Aggregated rule type carries a `tsstore_connection_ref` for the deep
  link.
- **`chartOptions` participates in dirty tracking** so chart-option
  toggles enable Save.
- **Sliding-window**: always renders the duration + timestamp Select
  when enabled; non-empty timestamp column is validated on save.
- **Dashboard-agent stamps the runtime namespace** on
  `create_component` / `create_dashboard` / `create_connection`, so
  `--namespace` is honored.
- **Agent prompt** adds the canonical time-axis pattern (prevents
  `formatTimestamp(NaN)` tooltips).
- **Connections list "Charts" column renamed to "Components"** to
  match the v0.11 rename.

### Fixed

- Duplicate `chartOptions` key in the dirty-state diff snapshot (lint
  caught a no-dupe-keys violation).
- Dashboards-list panel-count tooltip omits empty panels.
- Components-list namespace filter no longer treats an empty namespace
  selection as "matches every namespace."

## [0.18.0] — 2026-05-19

### Added

- **TLS skip-verify extended to every TLS-capable connection type**
  (was REST-only in v0.16.0). Same two-gate model: per-connection
  `insecure_skip_verify` flag AND server-level
  `api.allow_insecure_tls`. Now applies to MQTT, WebSocket, Socket,
  Prometheus, EdgeLake, and ts-store. Both gates must be true for
  verification to be skipped.
- **Generic primitive setting editor**. Settings without a bespoke
  modal (e.g. `auth.access_token_ttl_seconds`,
  `extensions.tsstore_alerts.enabled`) now auto-detect
  boolean/number/string from `typeof setting.value` and render the
  appropriate Carbon input. Future primitive settings added to
  `user-configurable.yaml` become editable without UI follow-up.

### Changed

- **Manage → Settings table-body scroll**. TableContainer is height-
  bounded with a sticky `thead`; the body scrolls inside the page
  shell instead of pushing the page past the viewport.
- **AI agent prompt rendering rules tightened**: titles render as an
  HTML div outside `<ReactECharts>` (not via `option.title`), and the
  canonical `grid.top` guidance tightens from 60 to
  `${legend ? 35 : 10}`. AI codegen also restored — `title` was
  missing from the chart-code useMemo deps, so title edits weren't
  regenerating the component code.
- **AI configure-first hallucination guard**. Configure-first rule
  now names its limits explicitly ("no tool for y-axis min/max, no
  tool for log scale, no tool for custom tooltip formatters"). New
  tool-call self-check requires the agent to verify each call's
  params actually addressed the user's request, with three PASS/FAIL
  examples. `set_custom_code` rule loosened for the no-tool-exists
  case.

### Fixed

- **AI draft create dropped fields**. `AISessionService.CreateSession`
  built a new draft from the latest final but only copied a hand-listed
  subset, so Title, Namespace, ComponentType, ControlConfig, and
  DisplayConfig all landed as zero values. Now copies every
  user-visible field.
- **AI editor 409-loop**. When an orphan draft existed,
  `POST /api/ai/sessions` returned 409 and the page's start-on-mount
  effect kept retrying forever. `useAISession` now keeps `startingRef`
  set on 409 specifically so the effect can't redrive.

## [0.17.8] — 2026-05-16

### Security

- **docker-compose.prod.yml / docker-compose.deploy.yml** now set
  `ENV=production` and `DASHBOARD_AUTH_ALLOW_LEGACY_GUID=false` on the
  server service. Previously they inherited the dev config-merge
  fallback because neither set those vars — anyone running them from a
  fresh clone got a server that accepted `X-User-ID` auth at
  `/api/auth/session`. `docker-compose.yml` (local dev) is unchanged.

### Added

- **`BUILDING.md`** at repo root: source-build instructions for
  evaluators / customers / contributors. Covers prereqs, one-shot
  local-platform build, multi-arch build matching the published
  images, image contents, sha256 verification against the published
  image, building only the Go binary without Docker, reproducible-
  build notes, and troubleshooting.

## [0.17.7] — 2026-05-16

### Changed

- **Favicon swapped to Carbon `ChartMultitype` glyph** (Apache 2.0)
  from `@carbon/icons-react`. The previous `brain.svg` was purchased
  with personal-use rights only — not redistributable under Apache
  2.0. Same icon Carbon already uses in the in-app header logo, so the
  favicon and header now match. Unused sourced SVGs removed from
  `images/`.

### Fixed

- **ComponentEditor Connection dropdown empty on hard refresh.**
  `fetchDatasources` and the preview-query path used raw `fetch()`
  without auth headers; under session-token middleware those 401'd.
  Swapped to `apiClient.getConnections()` and
  `apiClient.queryConnection()` so the access JWT (or API key)
  attaches automatically.

## [0.17.6] — 2026-05-16

### Security

- **`LegacyGUIDIdP` gated behind `auth.allow_legacy_guid`** (default
  `false`). Previously the X-User-ID / `?user_id=` IdP was registered
  unconditionally. Override channels: base `config.yaml` is false (the
  secure default); `config.development.yaml` sets true for local dev;
  `DASHBOARD_AUTH_ALLOW_LEGACY_GUID` env var overrides per-deployment.
  Server logs the posture on boot.

## [0.17.5] — 2026-05-16

### Fixed

- **Bootstrap race on hard refresh of design pages**. `App.jsx` did
  `getUsers()` BEFORE `createSession()`, so the directory call 401'd
  during the brief window before the access token was minted. Moved
  `getUsers()` to AFTER `createSession()`. Also fixed
  `EnabledTypesProvider`'s initial `getRegistryCatalog()` firing above
  the route tree — it now skips when no credential is set and listens
  for `apiclient-authenticated` (dispatched by `apiClient.setAccessToken`
  / `setApiKey` on no-cred → has-cred transitions).

### Changed

- **`docs/architecture/auth-modes.md` fully rewritten** for the
  v0.17.x model: two-layer architecture diagram, bootstrap funnel +
  IdP registry, session service (issue / refresh / revoke / admin
  TTLs), authentication middleware shape-dispatch, authorization with
  `DoesUserHavePriv` + view-as-floor + route-rules table + path-param
  authz pattern, client-side credential precedence, Adding-a-new-IdP
  template against the new `IdentityProvider` interface.

## [0.17.4] — 2026-05-15

### Security

- **Bundle export and editor GET now use distinct sanitizers.**
  `SanitizeForAPI` passes the `SecretMaskedValue` sentinel (editor
  round-trip: empty=no secret, `********`=keep, anything else=replace).
  `SanitizeForExport` passes `""` — bundles never carry secrets in any
  form.
- **Import-create path now strips placeholder secrets**
  (`stripPlaceholderSecrets()`) before insert, so leftover `********`
  literals from old bundles don't land in the DB and produce confusing
  upstream errors like ts-store's "invalid API key format."
- **Import-update path now preserves every secret from the existing
  record** (`preserveAllSecretsFromExisting()` instead of
  `preserveSecrets()`) — bundles can never clobber existing credentials,
  even when an explicit `""` is in the bundle.
- **New migration `strip_literal_secret_sentinels_v1`** walks every
  connection record and clears any secret field that literally equals
  `********`. Cleans up wreckage from prior buggy imports on next boot.

## [0.17.3] — 2026-05-15

### Fixed

- **Clerk Sign-Out menu item restored.** After the v0.17.0 bootstrap
  collapse, `ClerkLegacyIDBridge` stopped firing the
  `clerk-user-resolved` event because it tried to call `/api/auth/me`
  BEFORE the access token existed → 401 → `synced=true` → no event →
  `clerkActive` stayed false → `AccountMenu` received
  `onSignOut=undefined`. The bridge was redundant after the refactor
  and now broken — dropped. `App.jsx` snapshots `tokenProvider` before
  `createSession` runs and flips `clerkActive=true` after success.

## [0.17.2] — 2026-05-15

### Changed

- **API key takes precedence over JWT on every request.** Kiosks
  authenticate with an API key in localStorage; the v0.17.0 JWT-pair
  lifecycle (15-min access, 7-day refresh) was the wrong mechanism for
  a never-die display — a >7-day network outage would expire the
  refresh and kill the kiosk. Now `apiClient.request()`,
  `streamAuthQuery()`, and the 401-retry-with-refresh path all prefer
  `this.apiKey` over `this.accessToken` when set. Browser users
  without a personal API key are unchanged.

## [0.17.1] — 2026-05-15

### Fixed

- **API-key bearers no longer rejected.** The v0.17.0 middleware only
  accepted access JWTs, so ts-store webhooks, dashboard-agent, and any
  caller using a `trve_…` API key as a Bearer were rejected.
  Middleware now shape-dispatches on the bearer: `trve_…` validates
  against `api_keys`, anything else verifies as our access JWT. Both
  human-minted keys and admin-minted system-user keys take this path
  identically.
- **Malformed bearer no longer panics.** `jwt.VerifyToken` was
  unconditionally dereferencing `parsed.Claims` and panicked on garbage
  input. Guarded both that site and the `parsed.Valid` check below;
  failures return 401 instead of 500.

## [0.17.0] — 2026-05-15

### Added

- **Session-token unification.** Replaces the four-channel credential
  zoo (Bearer API key, Bearer JWT, X-User-ID, `?user_id=`) with a
  signed access+refresh JWT pair, issued at bootstrap and accepted by
  every transport (REST, SSE, WS). Every authz check is a synchronous
  claim check via `DoesUserHavePriv(claims, needed)` — no DB roundtrip
  on the hot path.
- **Pluggable `IdentityProvider` registry** at the bootstrap endpoint
  (`apikey`, `clerk`, `legacy-guid`). New IdPs are one-file additions.
- **New auth endpoints**: `/api/auth/session` (bootstrap),
  `/api/auth/refresh` (rotation with family-replay detection),
  `/api/auth/logout` (revoke family). Refresh tokens ride an httpOnly
  cookie scoped to `/api/auth`.
- **Admin-settable TTLs**: `auth.access_token_ttl_seconds` (default
  900 / 15min) and `auth.refresh_token_ttl_seconds` (default 604800 /
  7days).
- **SSE / WebSocket transports carry `?st=<accessToken>`** since
  EventSource and WebSocket can't set headers. Single helper formats
  the fragment.

### Changed

- **`view`-as-floor authz default.** Routes without an explicit
  capability rule now require `CapabilityView`. Webhook-only system
  users (`capabilities=[webhook]`) cannot snoop the read surface; they
  hit `/api/webhooks/*` only. `CreateSystemUser` no longer force-injects
  `view`.
- **View mode in the ModeToggle gated on `can_view`** (previously
  hidden for view-only users on the theory they couldn't switch
  anywhere — wrong).
- **`/` default route cascades by permitted capability**: view first,
  then manage, then design.

## [0.16.10] — 2026-05-15

### Fixed

- **Bell panel "Clear all" now clears connection/server notifications.**
  `clearAll` was routing through `HYDRATE` with only pinned rows in the
  payload, which intentionally preserves local-only rows
  (those without `alertId`). Connection-unreachable and server-
  unreachable notifications never acquire an `alertId` — so they stuck
  forever. New `CLEAR_UNPINNED` reducer action drops every unpinned
  row regardless of origin.

## [0.16.9] — 2026-05-14

### Added

- **Bell-row alert deep link.** When an alert carries a `dashboard_id`
  (decoded server-side from the rule's `external_ref` in v0.16.5's
  Phase 2 step 1), the bell row renders an "Open dashboard" button
  (Launch icon) that closes the panel and navigates to
  `/view/dashboards/<id>`. Does NOT auto-mark the alert seen — dismiss
  stays explicit.

### Changed

- **"Connection unreachable" notifications identify the connection.**
  When the name cache misses, the subtitle now reads
  "Connection abc12345 did not respond..." (UUID prefix) instead of the
  generic copy, and fires `getConnection()` in the background to
  populate the cache.

## [0.16.8] — 2026-05-14

### Fixed

- **Kiosk SSE auth.** API-key-only kiosks (no GUID in URL, no Clerk
  session) lost their default-dashboard redirect, star, and weather /
  garage tiles after v0.16.5's auth-required default. Two fixes:
  `App.jsx` Tier-0 bootstrap now calls `apiClient.setCurrentUser`
  after `/auth/me` resolves; `streamConnectionManager` and
  `ComponentEditor` (MQTT capture) prefer `?token=<apiKey>` over
  `?user_id=<guid>` when building SSE URLs. Pattern points at the
  session-token unification work that landed in v0.17.0.

## [0.16.7] — 2026-05-14

### Security

- **`/api/config/user/:user_id` now self-only.** New `requireSelf`
  guard at the handler enforces `caller.GUID == path user_id` for GET
  and PUT. Admin cleanup on user delete flows through
  `UserService.DeleteUser`, which cascades to
  `ConfigRepository.DeleteUserConfig` directly (not via this HTTP
  surface).

### Fixed

- **`ViewDashboardsPage` and `ViewModeNav` raw fetches**. Both pages
  called `fetch()` directly against `/api/dashboards`; raw fetch sends
  no `Authorization` / `X-User-ID`, so under the auth-required default
  the kiosk silently got 401 → empty list → no tiles → no place to
  render the star. Swapped both to `apiClient.getDashboards()`.

## [0.16.6] — 2026-05-14

### Fixed

- **Bootstrap Tier-3 lookup**. The SPA reads
  `/api/settings/default_browser_user_guid` before identity is
  resolved, so kiosk-style `?key=trve_…` deployments could
  auto-identify as the admin-configured default. Per-key settings
  GETs are now explicitly `Public:true`. Bonus: closed a latent
  write-escalation — `PUT /api/settings/<key>` was passing the
  auth-required default with no capability check. Now Manage-only.
- **Frigate camera widgets**. `<img src=…>` and `<video src=…>` fetch
  without an `Authorization` header, so the auth-required default
  returned 401 every second in the widget retry loop. Explicit
  `Public:true` for the whole `/api/frigate/` GET surface. POST stays
  gated. Trade-off: knowing a `connection_id` UUID is sufficient to
  read media, so deployments must rely on perimeter access control
  (tailnet, LAN, VPN).

## [0.16.5] — 2026-05-13

### Security

- **`/api` routes now require authentication by default.** Routes
  without an explicit `RouteCapability` rule were allowing
  unauthenticated callers — `/api/dashboards`, `/api/connections`,
  `/api/alerts`, `/api/components`, `/api/devices`, `/api/namespaces`,
  `/api/registry`, `/api/tags`, `/api/events/stream` and ~10 more
  reads were open to anyone who could reach the port. `Authorize` now
  treats "no rule" as "authenticated user required, no specific
  capability." Public exemptions are explicit and limited to the
  bootstrap chain (`/api/health`, `/api/auth/me`,
  `GET /api/config/system`).

### Fixed

- **Bootstrap default-dashboard redirect** now waits for identity to
  resolve, so kiosk-style `?key=trve_…` auth loads the user's own
  configured default rather than racing to the alphabetical-first
  dashboard.

### Added

- **`external_ref` pass-through on ts-store alerts** (Phase 2 step 1).
  Dashboard ingests the field verbatim and opportunistically decodes
  the JSON dashboard convention (`{"dashboard_id":"<uuid>"}`) so
  future bell-row deep links have the data ready.

## [0.16.4] — 2026-05-13

### Added

- **Alert persistence.** ts-store webhook alerts now persist to a new
  `alerts` collection. The bell hydrates from there on app load so
  alerts fired while nobody was watching aren't lost. Visibility is
  "first reader clears it for everyone" with a per-record pin
  override — anyone can pin to keep an alert visible for other users,
  anyone can unpin. Records expire 30 days after receipt via a
  MongoDB TTL index. New routes: `GET /api/alerts`,
  `POST /api/alerts/:id/seen`, `POST + DELETE /api/alerts/:id/pin`.
- **Notification bell in fullscreen.** The App-level header is hidden
  in fullscreen, which used to hide the bell too. The bell now also
  renders in the viewer toolbar when fullscreen is on (and only then).

### Fixed

- **Copy-to-clipboard fallback** (`utils/clipboard.js`).
  `navigator.clipboard.writeText` is only available on secure contexts
  (HTTPS / localhost); the homelab runs over plain HTTP so the system-
  user API-key copy button (and the Prometheus / SQL query-builder
  copy buttons) silently failed in deployed use. New helper wraps the
  modern API with a hidden-textarea + `execCommand` fallback.

## [0.16.3] — 2026-05-12

### Changed

- **`Mint` renamed to `Generate`** in the system-user key flow to
  match the rest of the dashboard's API-key UI surface. UI copy,
  doc-comments, and Swagger summaries.

## [0.16.2] — 2026-05-12

### Added

- **Capability selector on the New System User modal.** Operators can
  mint a tighter-scoped key when an integration doesn't need to
  receive inbound webhooks. `view` is locked on; `webhook` is a
  checkbox defaulting on; `design` and `manage` stay hidden in the
  modal but are accepted on `POST /api/system-users` for the rare
  legitimate case. System-user cards now show capability chips (the
  webhook chip is blue).

## [0.16.1] — 2026-05-12

### Added

- **ts-store alert webhook receiver (Phase 1).** External services
  `POST /api/webhooks/tsstore/:connection_id` with a Bearer token
  issued to a system user; the dashboard validates routing, publishes
  to an in-process event hub, and fans the event out to every logged-
  in browser via SSE for surfacing in the notification bell.
- **System users** — new non-interactive `User.Kind`. Admins create
  them to own API keys for inbound integrations. No interactive
  sign-in path; IdP/Clerk and X-User-ID both reject. Manage → System
  Users page exposes the full lifecycle (create, delete, mint key,
  revoke key) with a one-time-reveal token modal.
- **Explicit `webhook` capability.** Humans don't get it by default;
  system users do at creation time. `/api/webhooks/*` is gated on it
  so the contract is self-documenting.
- **Event hub + SSE** — in-process pub/sub; each browser opens
  `/api/events/stream` once and dispatches `alert` events onto the
  existing `NotificationContext.addNotification` (bell panel only —
  no corner toast in Phase 1).

## [0.16.0] — 2026-05-11

### Added

- **REST API adapter TLS skip-verify** with a strict two-gate opt-in.
  Deployment-wide kill switch (`api.allow_insecure_tls` in
  `config.yaml` or `DASHBOARD_API_ALLOW_INSECURE_TLS` env, default
  false), AND a per-connection `insecure_skip_verify` toggle on the
  api.rest config (default false, surfaced in the UI only when the URL
  begins with `https://`). Both gates must be true. Single
  `BuildAPIHTTPClient` helper centralizes `http.Client` construction
  so the registry-path adapter, the legacy `APIDataSource`, and the
  connection-test service all honor the same TLS posture.

## [0.15.2] — 2026-05-11

### Security

- **`/api/users/*` Manage-only.** Every method on `/api/users/*` now
  requires the Manage capability. There is no self-management UI
  today, so no reason for non-admin callers to ever hit those routes.
  Knowing a GUID or Mongo `_id` is not a permission to read another
  user's record.

### Changed

- **`/api/auth/me` carries self-identity.** Response gains `id`, `guid`,
  and `active` alongside capabilities — a single call, no follow-up
  directory lookup. App bootstrap refactored to `resolveSelf()` on
  every identity tier. Stale admin-default GUIDs that no longer
  resolve are cleared from localStorage instead of being persisted as
  dead `X-User-ID` headers.

## [0.15.1] — 2026-05-11

### Security

- **`/api/config/system` returns only whitelisted public keys** (today:
  `current_layout_dimension`). Other keys, including any future
  admin-set values, are dropped from the response.
- **`/api/users` (list-all) requires Manage.** Single-user reads
  (`/:id` and `/by-guid/:guid`) stay open to any authenticated caller
  but redact email / Clerk linkage / capabilities for non-Manage.
- **New `GET /api/users/by-guid/:guid`** lets the SPA bootstrap resolve
  a localStorage or admin-default GUID claim into a User record
  without going through the Manage-only list endpoint.
- **`/api/settings` (list-all) requires Manage.** Per-key reads
  (`/api/settings/:key`) stay open because View/Design code reads
  individual runtime values on every page load.

## [0.15.0] — 2026-05-11

### Added

- **AI builder configure-first rendering.** When the agent finishes a
  session without calling `set_custom_code`, the preview pane and save
  handler now materialize the same React component code that the
  manual `ComponentEditor` would emit. AI-built and human-built
  components render identically.
  `generateComponentCodeFromConfig` builds runnable component code
  from `query_config`, `data_mapping`, `options`, `parser`, and the
  sliding window — including ts-store streaming variants — and
  persists it on save.

### Changed

- **`ComponentEditor` custom-code mode keeps the Connection tab
  visible** (connection still governs runtime data shape), with the
  no-longer-load-bearing data-mapping and chart-options subsections
  hidden inside that tab.
- **App shell handles off-mode routes** (`/account/*`) correctly: the
  mode pill is unlit and the side-nav is hidden.

## [0.14.9] — 2026-05-10

### Added

- **Connection filter on the Select Component modal** — mirrors the
  Design-mode component-list page's filter so picking a component for
  a dashboard panel can scope by data source. Fans out across
  `connection_id` / `display_config.frigate_connection_id` /
  `mqtt_connection_id`.

## [0.14.8] — 2026-05-09

### Added

- **Tile views show a `NamespaceChip` on every entity card.** Added
  to Design-mode dashboards / connections / components tile views,
  the View-mode dashboard tile grid, and the Select Component modal.
- **Type-filter dedup**: `ComponentsListPage` now consumes the shared
  `TypeHierarchyFilter` widget instead of reimplementing it inline
  (~250 lines removed). `frigate_alerts` and `banded_bar` were
  missing from the inline copy — both now flow through automatically
  since the catalog lives in one place.

### Changed

- **`UserService.DeleteUser` cascades to API keys and per-user
  `app_config` rows**, so deleted users can't leave live API tokens
  resolving to a missing `user_id`. Admin UI confirmation spells out
  the consequences up front.
- MCP `create_dashboard` / `update_dashboard` tool descriptions now
  document the native `text_config` panel schema (content,
  display_content, size, align).

### Fixed

- Type-filter trigger styled to match Carbon MultiSelect neighbors
  (`--cds-field` fill + 1px border).
- Dashboard rename inline input grows up to 720px wide on the viewer
  toolbar.
- `ComponentEditorModal` pins `scrollTop` on `focusin` so Carbon's
  implicit focus-scroll doesn't re-center buttons under the cursor.

## [0.14.7] — 2026-05-07

### Added

- **Banded bar (Levey-Jennings) chart type** with four visual styles
  (`time_series` + three column variants) and a per-row mean / ±1/±2
  SD data contract.
- **AI agent shifted to configure-first**; `set_custom_code` is
  last-resort. Guardrails: `chart_type` validation,
  `update_component_type` refuses changes on populated components,
  `formatTimestamp` enum validated. `update_data_mapping` accepts
  `band_columns`. Y-axis cap exempted for `banded_bar` / `dataview`.
- **ts-store streaming default backfill = newest 100 records.**
- **New aggregation-and-filtering architecture doc.**

### Fixed

- **PNG export composites ECharts canvas with native Canvas 2D
  `fillText` for the title** — html2canvas's text shaper was
  stretching titles.
- **Data-table modal**: AG Grid `valueGetter` for dot-key columns,
  timestamp hoisted to first column, time format honors chart's
  `x_axis_format`, gauges now get the data-table action.
- **`useData` column-union**: streaming records can grow the column
  set without dropping prior rows.
- **`DynamicComponentLoader` translates parser keys** snake_case →
  camelCase.

## [0.14.6] — 2026-05-05

### Changed

- **AI guardrails.** Refuse `update_component_type` changes on
  already-populated components (the most common failure mode is the AI
  silently converting the user's chart into a control or display on an
  ambiguous prompt). Refuse `chart_type` writes when the value isn't a
  known chart subtype, or when the component isn't a chart. New enum
  on `update_data_mapping.x_axis_format` so the AI can't ship invented
  presets through the API. System prompt expanded with
  "Refining vs. converting existing components" and explicit
  callouts that the three component-type subtype namespaces don't
  cross over.
- **`useData` injects a default backfill** (`{raw:'newest', limit:100}`)
  for ts-store streaming connections when the caller doesn't pass one.
  Fills the chart immediately instead of leaving it blank until the
  next push arrives. Caller can opt out with `backfill: false` or
  override with explicit value.
- **Removed the dashboard switch-indicator overlay popup.** Predates
  the toolbar prev/next/home arrows.

### Fixed

- **`formatTimestamp` default branch falls back to `chart_time`** (time
  only) instead of `toLocaleString` (date + time), and emits a one-time
  `console.warn` naming the bad preset.

## [0.14.5] — 2026-05-04

### Added

- **Hoverable list-page counts.** Panels column on dashboards / Charts
  column on connections / Dashboards column on components all show
  named-item lists in their tooltips (with `(empty panel)` /
  `(missing component)` placeholders so the count stays honest). New
  global `.tooltip-multiline` class preserves embedded `\n` line breaks
  via `white-space: pre-line`.

### Changed

- **Column reorder for at-a-glance scanning.** Dashboards: Tags before
  Description. Components: Description after Type; Dashboards before
  Connection. Connections: Charts after Description.

## [0.14.4] — 2026-05-04

### Changed

- **`drop_mask_secrets` migration moved to the in-process framework.**
  v0.14.3 shipped it as a standalone `cmd/migrate-*` binary which
  forced an out-of-band `scp + ssh + exec` on prod — wrong choice for
  a simple `$unset` against one collection. New `Database Migrations`
  section in CLAUDE.md establishes the in-process framework as the
  default and documents when a standalone binary is justified
  (structural rewrites, pre-boot data conversion, multi-hour sweeps).

## [0.14.3] — 2026-05-03

### Security

- **Removed the `mask_secrets` per-connection flag.** API never returns
  unmasked credentials; secrets remain write-only over POST/PUT with
  the existing `preserveSecrets` round-trip semantics. One-shot
  migration `cmd/migrate-drop-mask-secrets` `$unset`s the legacy field
  from existing connection documents (idempotent; recorded as
  `drop_mask_secrets_v1`). (See v0.14.4 for the move into the in-process
  framework.)
- **Go toolchain bumped 1.24 → 1.26**, closing 10 reachable Go stdlib
  vulnerabilities reported by govulncheck. Dockerfile + CLAUDE.md
  prereqs updated.
- **Frontend deps**: removed unused `@antv/g2plot` + `@antv/g2`, ran
  `npm audit fix` — 15 vulns (10 high, 5 moderate) → 0.

### Added

- **`SECURITY.md` at repo root** with vulnerability reporting,
  scanning tools (`npm audit`, `govulncheck`, `gitleaks`), the
  2026-05-03 scan result, and the 3 acknowledged-unreachable Go
  advisories.

### Fixed

- **Viewer prev/next list now respects the saved sort key + direction**
  from the View Mode tile page (not just the manual drag order).
  Reloads on visibility/focus change so a sort change on the tile page
  propagates back to an already-open viewer.

## [0.14.2] — 2026-05-03

### Added

- **Referential-integrity guards on delete.**
  `DELETE /api/connections/:id` returns 409 Conflict if any components
  or devices still reference the connection. `DELETE /api/components/:id`
  returns 409 Conflict if any dashboards have a panel pointing at the
  component. Both 409 bodies include a `usage` object enumerating
  blockers so the UI can show "cannot delete — still used by N items"
  inline.

## [0.14.1] — 2026-05-03

### Changed

- **`panel.chart_id` renamed to `panel.component_id`**, completing the
  v0.11.x charts → components rename. Same data, more honest name.
  Standalone migration `cmd/migrate-panel-component-id` rewrites
  existing data; must run BEFORE deploying the new server because the
  binary won't find anything under the old field name. Also drops the
  unused `chart_id` indexes on the `ai_sessions` collection.

## [0.14.0] — 2026-05-03

### Changed

- **Connections now use UUID `_id`** instead of MongoDB ObjectID-hex,
  matching the convention used by dashboards / namespaces / users.
  Component → connection references are rewritten to UUIDs. Orphan
  refs (connection deleted) are nulled out. Bundle export/import works
  on UUIDs going forward; v0.13.x bundles do not round-trip into
  v0.14.x. Migration: standalone
  `server-go/cmd/migrate-uuid-ids/main.go` runs BEFORE the new server
  can start cleanly. Local + prod migrated 26 connections + 142
  component references.

## [0.13.3] — 2026-05-03

### Fixed

- **Refetch-without-remount for streaming-safe dashboard refresh.**
  The toolbar Refresh button and dashboard-to-dashboard navigation no
  longer force a full panel remount. Streaming charts keep their
  rolling buffer through navigation (`StreamConnectionManager`
  grace-period reconnect now works as intended), polling charts do an
  out-of-band refetch via `useData`.
- **Component expand modal**: download dropdown items no longer
  clipped; oversized charts still can't blow out the modal (overflow
  moved off the modal body onto inner panel/display wrappers).

## [0.13.2] — 2026-05-02

### Added

- **Double-click expand modal in view mode.** Double-click any chart,
  weather display, or frigate camera to open it in a large expand
  modal. The modal renders an independent live instance (streaming
  keeps streaming, polling keeps polling) and carries the panel's
  data-table + download (PNG/CSV/JSON) actions. Scales with the
  viewport on large displays.

### Fixed

- **View-mode toolbar**: refresh icon moved before the download icon
  so it groups with the refresh-pill + last-refresh text.
- **Mode toggle**: switching to View from a design-origin preview no
  longer flickers and snaps back to Design.
- **30 legacy components with empty `component_type`** backfilled to
  `chart` on local + prod databases; defensive fallback added in the
  viewer.

## [0.13.1] — 2026-05-01

### Added

- **AI builder `config` prop.** Components now receive a `config`
  prop with `{ title, name, description }`. AI-generated code reads
  `config.title` so charts track user renames automatically. `useData`
  also returns `config` as a fallback so existing AI charts that
  destructured `config` keep working without per-chart fixes. System
  prompt + tool descriptions updated to require `config`-prop usage
  and `tooltip.appendToBody` on every chart.

### Fixed

- **Frigate connection count on the Connections list** (display
  components reference connections via
  `display_config.frigate_connection_id` and `mqtt_connection_id`,
  which the previous count missed).
- **Saving a new component after picking a connection / editing data
  mapping no longer drops those edits** — fixed a stale-closure bug in
  `useImperativeHandle`'s deps array.
- **Dirty tracking covers every field `handleSave` writes** (title,
  namespace, componentType, controlConfig, displayConfig, queryType,
  tsstore/edgelake, sliding window, time bucket, parser config,
  columnAliases, visibleColumns, componentCode).
- **ECharts tooltips no longer clip at panel borders** (theme +
  template changes set `tooltip.appendToBody`).
- **Background "connection unreachable" alerts now go to the bell
  only**, not toast + bell.

### Changed

- Connection-picker double-click commits the selection.
- View-mode tile list: Reset Order button repositioned next to the
  sort dropdown.
- Dashboards list page renamed "Data Sources" header column to
  "Connections" and added a connection filter on both Design-mode
  list and View-mode tile pages.
- `ComponentEditor` "Display Title" field renamed to "Title" so the
  UI label matches the backing field name.

## [0.13.0] — 2026-05-01

### Added

- **Reset Filters icon** on all list pages + dashboard tile view +
  Select Existing Component modal.
- **Tile-mode SortMenu** (Name / Last modified / Namespace) on three
  Design list pages + the View-mode dashboard tile page (with a
  Manual option that toggles drag-reorder back on).
- **`ComponentPickerModal`** gains namespace filter, sort menu, and a
  toolbar that wraps on narrow widths.
- **Custom-code editor mode polish.** Connection tab and Chart Type
  card hidden; Code tab pre-selected; component-type selector locks
  Display/Control as disabled; banner with "Switch to Generated Code"
  action button replaces the on-entry warning modal.

### Changed

- **`TypeHierarchyFilter` groups start collapsed** — Chart's subtype
  list was long enough to push the others off-screen.
- **Save button gated on `hasChanges`** in `ComponentEditor`,
  `ComponentEditorModal`, `ComponentDetailPage`, and
  `ConnectionDetailPage` (was active on first load).
- **Embedded-component edits no longer mark the parent dashboard
  dirty** — only panel-level changes (chart_id swap, w/h growth) flip
  `editHasChanges`.

### Fixed

- **Rename-sweep stragglers cleaned up.** `ListConnections` JSON key
  `datasources` → `connections`. `TagHandler` aggregations:
  collection names `datasources` / `charts` → `connections` /
  `components` (these were nonexistent collections, so tag counts
  were always 0). `DashboardRepository` `$lookup` from `datasources`
  → `connections` (incidentally fixes the `include_connections`
  `panel_count = 0` bug).

## [0.12.0] — 2026-04-30

### Changed

- **`datasource` → `connection` rename completed across the stack.**
  The umbrella entity for an external data/device endpoint is
  **Connection** everywhere — collection, BSON field, Go identifier,
  JSON wire format, route, runtime adapter interface. The dual-tag
  hack (`bson:"datasource_id" json:"connection_id"`) that bridged
  old storage to new wire is gone. Renames span: `models.Datasource`
  → `models.Connection`; `DatasourceID` → `ConnectionID`;
  `DataSource` runtime adapter interface → `ConnectionAdapter`;
  repository, service, handler, factory, directory
  (`internal/datasource/` → `internal/connection/`),
  `IncludeDatasources` → `IncludeConnections`,
  `/api/streams/inbound/:datasourceId` → `:connectionId`,
  `BucketConfig.DatasourceID` → `ConnectionID`, etc.
- **Collection `datasources` → `connections`.** Field
  `datasource_id` → `connection_id` on every component document.
  Stored chart code (`component_code`) rewritten to use
  `connectionId:` instead of `datasourceId:` in the `useData` hook
  prop.
- **`POST/GET/PUT/DELETE /api/datasources/*` removed.**
  `/api/connections/*` is the only path. The deprecated alias was
  removed in this release.

### Migrations

- `rename_datasources_to_connections_v1` (collection rename via admin
  `renameCollection`).
- `rename_datasource_id_field_v1` (aggregation-pipeline `UpdateMany`
  copies `datasource_id` → `connection_id` and unsets the old key).
- `rename_datasourceId_in_component_code_v1` (regex-narrow scan over
  stored component code, replaces `datasourceId:` with
  `connectionId:`).

## [0.11.0] — 2026-04-29

### Changed

- **`Chart` → `Component` umbrella rename across the entire stack.**
  Component is now the generic term; chart, control, and display are
  the three sub-types via `component_type`. The word "chart" is
  reserved for ECharts visualizations going forward.
  - `models.Chart` → `models.Component` (and every `Create*` /
    `Update*` / `*ListResponse` / `*QueryParams` / `*Summary` /
    `*VersionInfo` companion type).
  - `repository.ChartRepository` → `ComponentRepository`,
    `service.ChartService` → `ComponentService`,
    `handlers.ChartHandler` → `ComponentHandler`,
    `hub.ChartHub` → `ComponentHub`.
  - `AISessionResponse.Chart` → `.Component`;
    `AIChartUpdateEvent` → `AIComponentUpdateEvent`.
  - HTTP routes `/api/charts/*` → `/api/components/*` (no alias).
  - MongoDB collection `charts` → `components`, via the new
    `rename_charts_to_components_v1` migration.
  - Frontend file/component renames mirror the server (file by file,
    api method by api method, CSS class by CSS class). Route
    `/design/charts` → `/design/components`.

### Added

- **Connection-failure notifications.** When a request fails in any
  of these shapes (TypeError from `fetch`, 15s timeout, HTTP 502 /
  503 / 504, HTTP 500 with body matching connection-failure hints),
  the user gets a toast + a persistent bell-panel notification,
  debounced per-connection to 30s so a 12-panel dashboard fires once,
  not 12 times. SSE/EventSource onerror routes through the same
  helper. Connection-aware: the toast renders the connection's human
  name when known.
- **`apiClient.request()` wraps `fetch()` in an `AbortController` with
  a 15s default timeout.**
- **`TagInput` suggestions list now portals to `document.body`** so
  the dropdown escapes modal-body overflow and stacking context. The
  silent backspace-deletes-last-chip shortcut is gone.
- **`ComponentDetailPage` gates Cancel on `hasUnsavedChanges`** and
  shows a Discard-changes confirmation modal when dirty.

## [0.10.1] — 2026-04-28

### Fixed

- **Viewer prev/next arrows** now walk dashboards in the same
  sequence the user arranged via drag-and-drop on the View Mode tile
  page. Previously used name-alphabetical, ignoring the user's
  reordering. Both surfaces share one ordering implementation in
  `utils/dashboardOrder.js`.

### Removed

- **Dead "Preview" placeholder section** from the control editor.
  Never populated; added visual noise to the form.

## [0.10.0] — 2026-04-27

### Added

- **Optional Clerk-backed browser sign-in.** Soft switch via
  `CLERK_SECRET_KEY` + `CLERK_PUBLISHABLE_KEY`: when both are set, the
  SPA renders Clerk's hosted sign-in widget (email + Google + Apple)
  and the server validates Clerk's session JWTs on every request.
  When unset, the v0.9.x bootstrap chain is in effect — zero behavior
  change for existing deployments.
- **`IdentityVerifier` interface** (`internal/auth/`) that decouples
  the auth middleware from any specific IdP. Clerk is the first
  implementation; future generic OIDC and trusted reverse-proxy
  become drop-in additions.
- **Bearer dispatch by shape**: `trve_…` → API key (v0.9 path);
  anything else → `IdentityVerifier` (Clerk JWT today). Both paths
  coexist; API keys keep working unchanged.
- **Hybrid user resolution**: try `ClerkUserID` lookup first; on
  miss, match by verified email and JIT-persist the Clerk subject
  onto the user record. No auto-create — admins pre-provision users.
- **New Clerk user-ID field on the user edit page** lets admins
  manually re-link or break a stale link.
- **Sign-out item in the account menu** (only when Clerk is the
  active auth path).

## [0.9.1] — 2026-04-27

### Fixed

- **Component-list `name=` filter** now uses `regexp.QuoteMeta` + a
  `\b` word-prefix anchor. Searching "ts" matches "TS-Store…" but no
  longer "Lights" / "Alerts"; searching "." returns nothing instead
  of everything; case-insensitive behavior preserved.

### Added

- **"Versions and drafts" section** in user-guide AI builder docs
  explains how AI sessions checkpoint as draft versions and promote
  to final on Save / discard on Discard. Manual-edit vs AI-builder
  versioning contrast in `creating-components.md`. Corrected
  `data-model.md` — manual PUT updates the latest version in place;
  only AI sessions create new draft versions.

## [0.9.0] — 2026-04-27

### Added

- **API keys.** New `/api/api-keys` (bcrypt-hashed `trve_…` tokens
  with prefix-indexed lookup). Per-user CRUD plus admin list-all.
  Auth middleware now accepts `Authorization: Bearer trve_…`;
  precedence is Bearer → X-User-ID → `?user_id=` → unauthenticated.
- **`/mcp/sse` and `/mcp/message` now require authentication**,
  matching the rest of `/api`. mcp-proxy / Claude Desktop must pass
  the Bearer header.
- **Account menu** (avatar dropdown) shows name + email + API Keys
  link. API Keys page moved out of Manage Mode → `/account/api-keys`.
  Dev-only `DevUserSwitcher` pill replaces the impersonation
  dropdown that previously lived in the avatar.
- **`dashboard-agent --api-key` flag** (or `DASHBOARD_API_KEY` env
  var). MCP client + prompt builder send Bearer auth when set.
  `--user` is now legacy.
- **`docs/postman/` tooling**: Swagger→Postman v2.1 converter with
  collection-level Bearer auth. `make api-docs` (`swag init` +
  builder) is wired into `make release`.

### Changed

- **Chart thumbnail field removed** (captured on every save but never
  read). Idempotent migration strips it from existing rows on first
  boot.
- **Production header shows the user's name inline** next to the
  avatar (was tooltip-only).

## [0.8.5] — 2026-04-26

### Added

- **Browser-mode identity bootstrap.** Production browsers resolve
  identity via a four-tier chain: `?user_id=<guid>` in URL →
  localStorage → admin setting `default_browser_user_guid` →
  "Sign-in not configured" stub. URL parameter is consumed and
  stripped after first read. Admin setting + editor modal for the
  deployment-wide default identity, with an explicit "identity
  assertion, not authentication" warning.
- **Dashboard config refresh.** New deployment-wide
  `dashboard_config_refresh_interval` (default 300s) drives a
  slow-poll re-fetch of the dashboard record so kiosks pick up edits
  made by another author without a manual reload. Visibility-gated;
  paused while editing; only triggers re-render on real diffs.

### Changed

- **Dev-time user-switching dropdown hidden in production bundles**
  (gated on `import.meta.env.DEV`).
- **Orphan cleanup**: removed the dead
  `dashboard.config_refresh_interval` base-config key.

## [0.8.4] — 2026-04-25

### Removed

- **Four fields from the Dashboard Settings modal** that didn't do
  anything at runtime (Theme — app hardcoded to g100 dark; Make
  dashboard public — no access-control consumer; Allow export — no
  export-permission consumer; Title Scale — only affected a legacy
  chart type the editor no longer creates). Fields persist on the
  model as no-ops so existing records round-trip without data loss.

### Fixed

- **Auto Refresh actually works.** Chart code generator no longer
  hardcodes `refreshInterval=30000`; the dashboard's
  `settings.refresh_interval` now drives every chart's polling cadence
  via `DynamicComponentLoader`. `useData` polling pauses on
  `document.visibilitychange` and refetches immediately when the tab
  returns to visible. Toolbar's Refresh button now forces a real
  chart-data refetch (was reloading the dashboard record itself).
  New dashboards default to a 30s refresh; legacy dashboards with no
  value default to 30s on load. Set to 0 to disable entirely.
  Streaming sources (MQTT, ts-store push, bidirectional WebSocket)
  are unaffected.

## [0.8.3] — 2026-04-25

### Fixed

- **Tile-view click-after-drop.** After drag-and-drop, the source
  tile became un-clickable until the user clicked some other tile
  first. Scoped suppression to source tile + 250ms window.
- **Mode pill on VIEW switch.** Clicking VIEW from a clean design
  preview used to leave the header pill on DESIGN until a second
  click forced a remount. Viewer's mode guard now clears `fromDesign`
  when accepting a switch into view mode.

### Changed

- **User-facing documentation sync.** The udoc/ Docusaurus site had
  drifted from running app behavior across several v0.7 / v0.8
  releases. Full rewrites of `viewing-dashboards.md`,
  `viewer-controls.md`, `grid-layout.md`, `system-settings.md`,
  `modes.md`, `getting-started.md`, `keyboard-shortcuts.md`, and the
  user-guide landing README. Added new `mcp.md` and
  `dashboard-agent.md` user-facing pages.

## [0.8.2] — 2026-04-25

> Tagged as a planned interim cut for the v0.8.1 follow-up fixes; no
> images were published. Rolled forward into v0.8.3 along with the
> user-guide sync.

## [0.8.1] — 2026-04-25

### Added

- **View-mode tile drag-and-drop reorder.** Whole-tile drag with
  native HTML5 DnD (no library). Drop target's left or right half
  decides insertion side; a 4px blue bar previews insertion. Order
  persists per-user at `app_config.settings.dashboard_tile_order`.
  Partial coverage — only explicitly-placed tiles are pinned; the
  rest fall through to the default sort. New dashboards prepend to
  the front so unseen tiles surface naturally. "Reset order" header
  button wipes the manual sequence. Touch reorder intentionally
  unsupported for now.
- **`/view/dashboards` default tile order** matches design-mode
  (most-recently-updated first).

## [0.8.0] — 2026-04-24

### Added

- **`cmd/dashboard-agent` CLI.** A reference MCP client (shipped in
  the repo) that drives the same `/mcp/sse` surface external clients
  use, producing complete dashboards from natural-language prompts.
  See `examples/dashboard-agent/` for an end-to-end walkthrough of a
  14-panel Prometheus monitoring dashboard built in 12 turns.
- **Dashboard tile-view filters.** Namespace + tag dropdowns on
  `/view/dashboards` matching the design-mode list, while keeping
  view-mode-only tile UI (default-star, "Set as Default" overflow,
  no edit/delete).
- **`default_dashboard_fit_mode` admin setting** controls the
  deployment-wide default for any dashboard a user has not
  explicitly set. Per-user, per-dashboard preferences are now
  strictly scoped — fit-mode picks no longer bleed across users or
  untouched dashboards.

### Changed

- **MCP "Grid contract" preamble corrected** to match what the
  viewer actually does (32×32 px cells, 4px gaps, fixed chrome
  budget; `cols = floor(w / 36)`, `rows = floor((h - 105) / 36)`).
  A 2560×1440 canvas is 71×37 cells, not the 12×45 some docs
  implied.
- **Prometheus adapter accepts bare durations** (`-1h`, `-30m`, `1h`)
  for `start`/`end` values, in addition to the existing `now-1h`
  form.
- **Compact ack envelope on `create_component` / `update_component`**
  removes ~85% of bytes the LLM was re-shipping in subsequent turns.
  `get_connection_schema` gains `metric_prefix` / `metric_contains` /
  `max_metrics` filters so a schema fetch on a busy Prometheus
  doesn't return 2000+ metrics.
- **Agent retry logic** treats transient network errors (DNS
  failure, connection reset) the same way it treats 429s.

## [0.7.9] — 2026-04-22

### Fixed

- **Dashboard tile-view selection page** (`/view/dashboards`) now
  scrolls on mobile and narrow viewports. Previously tiles past the
  fold were clipped with no scroll capability.

### Security

- **Hardened datasource sanitizer rollout** (from v0.7.8 — see below
  for full detail).

## [0.7.8] — 2026-04-22

### Security

- **Closed seven credential-leak gaps in the export path.** The
  export bundle was honoring a per-connection `MaskSecrets` flag —
  connections created with `MaskSecrets=false` (allowed for any
  Designer role) would ship credentials in cleartext inside the
  exported bundle. The sanitizer also had type-specific holes that
  leaked even with `MaskSecrets=true`. Fixed:
  - `PrometheusConfig.Password` had no sanitize branch.
  - `TSStoreConfig.Headers` were never masked.
  - Auth-header allowlist expanded and made case-insensitive
    (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`,
    `X-API-Key`, `X-Auth-Token`, `X-Access-Token`).
  - URL userinfo (`user:pass@`) stripped from API, Socket,
    Prometheus, and MQTT URL fields.
  - `SQLConfig.Options` now redacts `password=` / `sslpassword=`
    segments.
  - `APIConfig.Body` and `APIConfig.QueryParams` masked whole on
    non-empty values.
- **New `SanitizeForExport()` method** always masks regardless of the
  `MaskSecrets` flag. (`SanitizeForAPI` unchanged for the edit-form
  round-trip path.)

## [0.7.7] — 2026-04-21

### Changed

- **Documentation and diagrams only — no code changes.** New layered
  architecture diagram at
  `docs/architecture/dashboard-architecture-layered.drawio`. README
  and `ARCHITECTURE.md` now show the MCP surface as a first-class
  external-client channel (Claude Desktop via mcp-proxy →
  `/mcp/sse`). Reconciled stale references to a removed stdio binary
  (`cmd/mcp-server`) — the backend exposes a single MCP surface over
  SSE at `/mcp/sse` + `/mcp/message`. Linked `docs/mcp.md` from the
  README. Internal LAN/Tailscale IPs and hostnames scrubbed from
  CLAUDE.md per the "no IPs in artifacts" rule.

## [0.7.6] — 2026-04-21

### Fixed

- **Caddy directive ordering for `/docs`.** v0.7.5's `handle /docs`
  blocks were defeated by Caddy's directive ordering: when `root`,
  `file_server`, and `try_files` sit at the server level next to
  sibling `handle` blocks, `try_files` is hoisted ahead of the
  `handle` evaluation, so the SPA rewrite fired first. Fix: wrap the
  SPA fallback (root + try_files + file_server + asset-header
  matchers) in its own terminal `handle {}` block.

## [0.7.5] — 2026-04-20

### Fixed

- **Wire `/docs` through Caddy.** v0.7.4 bundled the Docusaurus docs
  into the server image, but the `/docs` route was still unreachable
  in deployed environments because the client Caddy config had no
  handler for it. Added `handle /docs` and `handle /docs/*` blocks
  that reverse-proxy to `server:3001`.

## [0.7.4] — 2026-04-20

### Added

- **Bundled docs.** The `/docs` site is now built into the server
  container image, so the Help button in the header resolves on
  homelab deploys (previously 404'd outside of local dev). Server
  Dockerfile gains a Node 20 docs-build stage that runs the
  Docusaurus build and copies the output next to the binary.

### Changed

- **Namespace picker in the app header is hidden for users without
  Design or Admin privileges** — it's an authoring-only control and
  has no meaning for view-only users.

## [0.7.3] — 2026-04-20

### Added

- **Dataview chart defaults + per-user overrides.** Column order and
  widths are first-class on dataview charts. Authors pick the order /
  default widths in the editor; each user's resize + reorder actions
  persist per-chart under `app_config`.
- **Long-mask placeholder for populated secret fields.** Password /
  API-key / token fields on every connection type render a long mask
  when the backend returned "a secret is set." Click to edit clears
  for fresh input; leave without typing to preserve.
- **Component picker hierarchical type filter** extracted to shared
  `TypeHierarchyFilter` component.
- **Stream connection debounce.** MQTT / streaming connections now
  coalesce a burst of topic-change reconnects (dashboard mount wiring
  N controls) into one reconnect. Eliminates `N-1` canceled-SSE
  "CORS request did not succeed" noise in dev consoles.
- **Safe-subnet `DASHBOARD_HOST` autodiscovery** for ts-store push
  connections. Server autodiscovers a reachable IP from a safe
  subnet allowlist (Tailscale overlay + LAN, excluding Docker
  ranges); an explicit env still wins.

### Changed

- **Chart title + plot alignment**: line / area / bar titles now
  render in React above the ECharts canvas, and the plot area uses a
  fixed left gutter so different charts on the same dashboard line
  up regardless of y-axis label width. **Re-save existing charts to
  pick up the new alignment.**
- **Mode toggle no longer jumps.** Clicking a row or eye icon in the
  Design-mode dashboard list opens the editor / preview at
  `/view/...` but keeps the header pill on DESIGN via a new
  `ModeGuardContext` signal. Cancelling routes back to the design
  list; saving flips to VIEW.

### Fixed

- **`FrigateCameraViewer` no longer throws
  `streamConnectionManager is undefined`** when subscribing to MQTT
  alerts.
- List-page toolbar order now mirrors column order:
  `Search → Namespace → Type → Tags → Connection → View switcher`.

## [0.7.2] — 2026-04-19

### Added

- **Full user-facing docs coverage for namespaces + export/import.**
  New Namespaces and Export & Import pages in the user guide; new
  "Sharing & Organization" sidebar category.
- **Persistent toast system.** Errors stay until dismissed;
  success/info/warning auto-dismiss after 5s. Separate from the
  bell-panel queue.

### Changed

- **Header namespace pill** gains chevron caret + tooltip so it
  reads as a dropdown.
- **Boolean "Current/All namespaces" toggle on list pages becomes a
  multi-select `NamespaceFilter`** (mirrors `TagFilter` shape).
- **Default namespace's slug is locked in the management UI** with
  helper text explaining why.
- **Import target namespace defaults to active namespace**; inline
  notices offer one-click "Use" or "Create" actions for the source
  namespace.
- **Switching to View while editing dashboard X lands on X
  specifically** (not the user's default).
- **Save+switch failure** (e.g., duplicate name) now blocks the mode
  switch instead of silently swallowing.

### Fixed

- **Inline name-error badge on dashboard editor** with a custom red-
  on-dark tooltip, portaled to escape the toolbar's clipping.

## [0.7.1] — 2026-04-19

### Added

- **View icon (eye)** on both tile actions and list actions column.
  Clicking jumps straight to `/view/dashboards/:id`.

### Changed

- **Tile clicks in export mode now toggle selection** instead of
  opening the editor — matches the list view's existing behavior.
  Selected tiles get a blue border + shadow and a visible checkbox
  overlay. Action row hides in export mode.
- **Tile grid viewport gains a small top padding** so the tile hover
  lift doesn't clip under the toolbar / export-mode bar.

## [0.7.0] — 2026-04-19

### Added

- **First-class `Namespace` entity.** Every connection, component,
  and dashboard belongs to a namespace; uniqueness becomes
  `(namespace, name)` instead of bare name, so two namespaces can
  each have a dashboard called "Home" without colliding. CRUD at
  `/api/namespaces`; delete guard returns 409 with per-type usage
  counts when records still reference the namespace. Rename cascades
  into every connection / component / dashboard row.
- **Active namespace is per-user preference** (`active_namespace` in
  `app_config`). Header picker shows the current namespace as a
  colored chip; picking another namespace swaps context for create
  forms and list-page filters.
- **List pages (dashboards, components, connections) gain a
  namespace column** with a colored chip and a "Current / All
  namespaces" toggle.
- **Namespaces management page** at `/manage/namespaces` with a
  swatch-palette color picker.
- **Dashboard export/import.**
  `POST /api/dashboards/export` builds a portable JSON bundle that
  walks the dashboard → component → connection dependency graph.
  Latest final chart version only; secrets ride out masked.
  `POST /api/dashboards/import/preflight` classifies every object
  as identical / conflict / new / blocked so the UI can narrate what
  would change before the user commits. Apply endpoint rewrites
  conflicting records in dependency order (connections first),
  refuses to apply when blocked items remain. Import UI:
  drop-to-upload, target-namespace cascade with inline "create this
  namespace" for non-local source namespaces, unified-diff review
  modal via jsdiff, per-conflict overwrite decisions.

### Migrations

- `namespacing_v1` backfills existing records into the new
  `default` namespace, resolves name collisions within the default
  bucket by auto-renaming younger duplicates, and swaps the legacy
  name-only unique indexes for compound `(namespace, name)` uniques.

## [0.6.3] — 2026-04-17

### Added

- **Per-column Y-axis label overrides** (`data_mapping.y_axis_labels`, a
  parallel array to `y_axis`). For single-y charts the override renames
  the axis `name`. For dual-y charts the override renames the series in
  the legend at the top of the chart (axis itself remains nameless so
  legend toggling hides the label with its line). Raw DB/MQTT column
  names are often terse — this gives users a place to rename them.
  Legacy `y_axis_label` (singular) is kept populated from index [0] for
  back-compat.

### Changed

- **Y-axis column count capped at 2** for chart types that render with
  axes (dataview/table unaffected). Enforced in three places: the
  ChartEditor MultiSelect clamps selection to 2, the `update_data_mapping`
  AI tool truncates any y_axis array longer than 2, and the AI system
  prompt now instructs splitting into separate charts when more than 2
  values need to be shown together.
- **Dual-y axis names removed from the sides**; colored tick labels and
  axis lines remain. Rationale: ECharts keeps an axis `name` visible
  when its series is legend-hidden, which looks broken. Legend at the
  top already carries series identity and toggles cleanly.
- **X-axis name is now opt-in** (rendered only when `x_axis_label` is
  explicitly set). Most dashboard charts are time-based and don't
  benefit from an x-axis name.
- **Single-y axis always gets a name** — the user's override if set,
  otherwise the column name as a default.

### Fixed

- **Axis labels were being clipped** because the grid had
  `left: 0, bottom: 0` while `containLabel: true` only reserves space
  for tick labels, not the axis `name`. Grid margins now expand
  dynamically to fit the label when one is present.
- **Legend rendering empty when overrides were set**. Legend `data`
  was hardcoded to the raw column names, but the series were renamed
  to the override strings — ECharts' legend-to-series matching failed.
  Legend now reads from the same `seriesNames` array that drives the
  series.

## [0.6.2] — 2026-04-17

### Fixed

- **Long "Connecting → Connected" delay on idle SSE streams.** The
  non-aggregated `/api/connections/:id/stream` handler didn't flush
  anything to the response until the first record or heartbeat, so
  the browser's `EventSource.onopen` callback didn't fire until ts-
  store or the upstream source pushed data — up to 30 seconds for
  quiet streams. Fix: emit an `event: connected` SSE frame + flush
  at the very top of the handler so `onopen` fires immediately.
  (The aggregated variant already flushed an initial `config` event
  and was unaffected.)

## [0.6.1] — 2026-04-17

### Fixed

- **SSE streams killed by 30s `WriteTimeout`**. The global HTTP
  `WriteTimeout` set on the Gin server was being enforced on
  long-lived `/api/connections/:id/stream` responses, terminating the
  stream after exactly 30 seconds. The browser auto-reconnected
  behind the scenes, but Firefox logged a "can't establish a
  connection" error on every reconnect cycle — visible as a flood of
  errors while viewing ts-store / WebSocket-backed charts. Fixed by
  calling `http.ResponseController.SetWriteDeadline(time.Time{})` at
  the top of both the standard and aggregated SSE handlers to
  disable the deadline for SSE responses only. Global `WriteTimeout`
  stays in place for every other handler.

## [0.6.0] — 2026-04-17

### Added

- **Type Availability gating**. Admins can enable or disable connection
  types, chart subtypes, control subtypes, display subtypes, and named
  integrations from a hierarchical Type Availability editor in
  Manage → Settings. Disabled items disappear from creation pickers,
  the AI agent's prompt and tool enums, and the MCP catalog. Existing
  dashboard components keep rendering regardless — gating is creation
  / suggestion only.
- **Integrations registry**. New `IntegrationInfo` metadata bundles
  related types under one toggle. Frigate (connection + camera viewer
  + alerts grid) and Weather (display) ship as integrations.
- **`enabled_types` / `known_types` settings** with seed-on-first-sight:
  new types added in a release auto-enable on first boot while
  admin-disabled items persist across upgrades.
- **WebSocket Bidirectional checkbox** in the connection editor. When
  set, the connection resolves to `stream.websocket-bidir` and gains
  write capability for control commands.
- **Connection-level parser** for WebSocket and TCP. Configure
  `data_path`, `timestamp_field`, and `timestamp_scale` once on the
  connection (point-to-point streams have one shape, so unwrap once
  on the server). Includes a ts-store preset that covers both MQTT
  and WebSocket push transports, plus a live test panel with side-by-
  side sample input and extracted output. MQTT keeps its existing
  per-component parser because broker multiplexing means each topic
  may carry a different shape.
- Dynamic AI agent prompt + tool enums — `BuildSystemPrompt(catalog)`
  and `GetAnthropicTools(catalog)` rebuild per message from the
  filtered catalog so admin toggles take effect on the next user turn.
- New MCP tool `list_integrations`.
- New REST endpoint `GET /api/registry/integrations` (with
  `?include_disabled=true` for the settings editor).
- Backend tests for WebSocket and TCP socket adapters
  (`internal/datasource/socket_streaming_test.go`), including the new
  TCP parser path.

### Changed

- Frigate connection type is now surfaced through the integrations
  registry's `OwnedConnectionType` rather than being a free-floating
  `DatasourceType` constant. The proxy handler is unchanged.
- ts-store parser preset renamed from `tsstore_mqtt` → `tsstore`. One
  preset covers both MQTT and WebSocket transports because both
  ts-store push paths use the same `{"timestamp": <ns int64>, "data":
  {...}}` envelope. Existing chart records that wrote `tsstore_mqtt`
  keep working.
- WebSocket / TCP `message_format` options reduced to `json` and
  `text`. Binary frames carrying JSON still parse transparently.
- `SocketParserConfig` gained a `TimestampScale` field (`ns` / `ms` /
  empty for auto-detect).

### Removed

- **UDP connection support**. The legacy `stream.udp` adapter,
  `udp.go`, the protocol option, and related model fields are gone.
  Realistic dashboard telemetry is overwhelmingly MQTT / WebSocket /
  REST, and the legacy connected-socket implementation couldn't
  receive unsolicited packets in any case.
- **Binary message_format** option for WebSocket and TCP. There was
  never a true binary mode for WebSocket, and TCP's binary mode had
  no consumers. Future binary protocols (MessagePack, protobuf)
  should be purpose-built typed adapters, not generic raw-bytes.

### Fixed

- Custom-mode parser preset on the connection editor briefly enabled
  inputs then re-derived the preset back to "none" before the user
  could type — fields are now sticky on explicit user selection.
- Component-type switcher (Chart / Display / Control) used to default
  new Display components to `frigate_camera` regardless of whether
  Frigate was enabled. Now picks the first enabled display type.
- Display tab in the component-type switcher now hides entirely when
  no display types are enabled (and same for the Control tab).
- Connection-type filter now correctly maps the bare legacy names
  (`sql`, `socket`, `mqtt`, ...) to the dotted registry families
  (`db.*`, `stream.*`, ...) so disabling a registry-side type
  collapses the matching dropdown options.

### Notes

- Internal Go signature changes (`BuildCatalog`, `GetAnthropicTools`,
  `NewAgent`, `NewToolRegistry`, `NewRegistryHandler`) are
  source-compatible only — any external Go consumers will need to
  pass the new parameters. There are no API-side breaking changes.
- The settings system migrates seamlessly: `SyncSettingsFromConfig`
  inserts the new `enabled_types` / `known_types` keys with empty
  defaults on first boot, then `SeedKnownAndEnabledTypes` populates
  them from the live registries — every type ends up enabled for
  existing deployments.
