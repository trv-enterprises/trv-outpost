# Chart Spec-Driven Editor

**Status:** design, ready to start Stage 1
**Date:** 2026-05-28
**Owner:** tom
**Branch:** `chart-spec-driven-editor`
**Supersedes:** parts of `chart-config-cleanup-and-editor-split.md`
(the structural ComponentEditor.jsx split + per-chart-type
whitelist remain valid; the per-type JSX blocks and per-type
codegen branches are replaced by the spec-driven approach
described here)

## Goal

Replace the hand-coded per-chart-type JSX blocks and per-type
codegen `switch` branches with a **JSON schema** that describes
each chart type. The schema drives:

- **Editor UI**: which configuration sections exist for this
  chart type, which fields appear in each, their types and
  defaults, validation rules, and conditional visibility.
- **Codegen**: enough metadata for a generic-as-possible code
  generator to emit the runtime chart component without a
  per-type case statement in source.
- **AI tool surface (eventually)**: the chat agent's
  `update_*` tools should be derivable from the same spec so
  the agent and the editor can't drift apart.

The spec is stored as a static `.json` file in the dashboard
client for v1. A later phase moves it to MongoDB and adds a
standalone schema editor as a separate executable; the contract
between schema and consumers is designed for that move from day
one.

## Why

Today's state — concrete pain points the spec fixes:

1. **Adding a chart type touches 5+ files.**
   `models/component.go` (Go constant), `controls/controlTypes.js`,
   per-type JSX block in `ComponentEditor.jsx`, per-type codegen
   branch in `getDataDrivenChartCode`, AI tool descriptions,
   CLAUDE.md. The spec collapses 3 of those into one JSON entry.

2. **Stored-but-ignored cruft on every chart record** (see
   `chart-config-cleanup-and-editor-split.md` matrix). The
   per-chart-type `allowedFields` whitelist becomes literally
   the spec's field list — same data, one source of truth.

3. **Gap fillers always require code changes.** Y-axis min/max,
   log scale, tooltip formatter — each one today needs editor
   JSX + codegen + AI tool. With the spec, adding a field is a
   schema entry plus a codegen template binding.

4. **The chat agent's tool schemas drift from the editor's
   field schemas.** Agent thinks it can "set y-axis range" but
   no editor field nor codegen consumes that; agent gives wrong
   answers. Single spec eliminates the drift surface.

5. **No path to user-extensible chart types.** If chart types
   were JSON, an admin could add one without a code deploy.
   Useful for org-specific chart variants and the standalone
   chart-spec editor later.

## Library independence

Today every chart renders via ECharts. The future will include
specialty libraries (e.g. d3 for force-directed graphs,
Three.js for 3D, react-vis-network for graph databases). The
spec declares the library per chart type so the codegen knows
which template family to emit and the editor knows which
options panels apply.

```jsonc
{
  "chart_type": "line",
  "library": "echarts",        // "echarts" | "d3" | "vis-network" | ...
  ...
}
```

Library-specific options live under a `library_options` block
so the spec's library-agnostic fields (data mapping, filters,
aggregation) stay stable across libraries. Two charts of
different types but the same library can share template
fragments; two of the same name but different libraries cannot.

In v1 only `library: "echarts"` exists. The dispatch lives in
the codegen layer so new libraries plug in without touching
the schema or editor — just a new template module + a new
options panel for the library-specific block.

## Non-goals

- **Don't model the editor shell in the spec.** Connection
  picker, tab navigation, Preview pane, Code viewer, Save/
  Cancel actions are the same for every chart type. They stay
  in source.
- **Don't try for a layout DSL.** A small set of layout
  primitives (`single-column`, `row-2`, `row-3`, `full-width`,
  `inset-card`) covers ~95% of editor needs. Don't build
  Figma.
- **Don't auto-generate the AI agent's tool schemas in this
  refactor.** It's the eventual payoff but it's a refactor on
  top of a refactor. Land editor + codegen on the spec first;
  agent tools next phase.
- **Don't move the spec to MongoDB in v1.** Static `.json` in
  the client is enough to validate the schema. Server storage
  + standalone editor is phase 2.

## Schema sketch

A `ChartTypeSpec` is a JSON object. One file per chart type
under `client/src/chart-spec/specs/` (e.g. `gauge.json`,
`line.json`, `bar.json`, ...). An index file aggregates them
for the registry.

```jsonc
{
  "schema_version": "1",
  "chart_type": "gauge",
  "library": "echarts",
  "display": {
    "label": "Gauge",
    "icon": "Meter",              // Carbon icon-react name
    "description": "Single-value dial. Binds one numeric value."
  },
  "capabilities": {
    "requires_x_axis": false,
    "requires_y_axis": true,
    "multiple_y_axis": false,
    "has_series_column": false,
    "has_axis_labels": false,
    "has_x_axis_format": false,
    "has_time_bucket": true,
    "has_sort_limit": false,
    "has_visible_columns": false,
    "has_filters": false,
    "has_aggregation": true
  },
  "sections": [
    {
      "id": "data_mapping",
      "label": "Data Mapping",
      "layout": "row-2",
      "fields": [
        {
          "id": "y_axis_0",
          "binds": "data_mapping.y_axis[0]",
          "type": "column_select",
          "label": "Value Column",
          "required": true,
          "helperText": "Numeric column to render on the dial."
        },
        {
          "id": "aggregation_type",
          "binds": "data_mapping.aggregation.type",
          "type": "enum",
          "label": "Aggregation",
          "default": "last",
          "options": [
            { "value": "last", "label": "Last value" },
            { "value": "first", "label": "First value" },
            { "value": "avg", "label": "Average" },
            { "value": "min", "label": "Minimum" },
            { "value": "max", "label": "Maximum" }
          ]
        }
      ]
    },
    {
      "id": "chart_options",
      "label": "Chart Options",
      "layout": "row-2",
      "fields": [
        {
          "id": "gauge_min",
          "binds": "options.gauge_min",
          "type": "number",
          "label": "Min",
          "default": 0
        },
        {
          "id": "gauge_max",
          "binds": "options.gauge_max",
          "type": "number",
          "label": "Max",
          "default": 100
        },
        {
          "id": "gauge_warning_threshold",
          "binds": "options.gauge_warning_threshold",
          "type": "number",
          "label": "Warning at",
          "default": 70,
          "helperText": "Value above which the dial colors yellow."
        },
        {
          "id": "gauge_danger_threshold",
          "binds": "options.gauge_danger_threshold",
          "type": "number",
          "label": "Danger at",
          "default": 90
        },
        {
          "id": "gauge_unit",
          "binds": "options.gauge_unit",
          "type": "text",
          "label": "Unit",
          "default": "",
          "placeholder": "e.g. %, °C, MB/s"
        }
      ]
    }
  ],
  "codegen": {
    "library": "echarts",
    "template_id": "gauge_v1",
    "template_bindings": {
      "value_expression": "getValue(data, 'value') || 0",
      "min": "options.gauge_min",
      "max": "options.gauge_max",
      "color_segments": [
        { "stop": "(options.gauge_warning_threshold - options.gauge_min) / (options.gauge_max - options.gauge_min)", "color": "#24a148" },
        { "stop": "(options.gauge_danger_threshold - options.gauge_min) / (options.gauge_max - options.gauge_min)", "color": "#f1c21b" },
        { "stop": "1", "color": "#da1e28" }
      ],
      "unit": "options.gauge_unit"
    }
  }
}
```

### Field types (v1)

- `column_select` — dropdown of available data columns
- `column_multi_select` — multi-select up to N columns
- `enum` — Carbon Select from `options[]`
- `text` — TextInput
- `number` — NumberInput
- `boolean` — Toggle
- `slider` — Slider with min/max/step
- `code` — TextArea (escape hatch for custom formatters etc.)

Adding a new type means a small renderer entry — the renderer is
a switch over `field.type`, not over `chart_type`.

### Layout primitives (v1)

- `single-column` — fields stacked, one per row
- `row-2` — two fields per row, 50/50
- `row-3` — three fields per row, 33/33/33
- `row-4` — four fields per row, 25/25/25/25
- `full-width` — single field at full section width
- `inset-card` — nested card for sub-groups (e.g. axis_config
  wrapping y_left/y_right/x)

Carbon Grid handles responsive collapse; the layout primitive
maps to a flex helper class (already exists for some — see
`.metadata-row--split` / `.metadata-col--half` in
`ComponentEditor.scss`).

### Conditional fields

Some fields only appear under conditions (e.g. y-right range
fields only when dual-axis is on). Expressed as a
`visibleWhen` clause:

```jsonc
{
  "id": "gauge_unit_position",
  "type": "enum",
  "visibleWhen": { "field": "gauge_unit", "operator": "not_empty" },
  ...
}
```

Operators: `eq`, `neq`, `in`, `not_in`, `truthy`, `falsy`,
`not_empty`. Evaluated client-side against the current form
state. Server-side validation is the same predicate set.

### Library options block (library-specific extension)

Library-specific fields go under a section with
`"library_specific": true`:

```jsonc
{
  "id": "echarts_options",
  "label": "ECharts Options",
  "library_specific": true,
  "fields": [
    {
      "id": "smooth",
      "binds": "options.chart_smooth",
      "type": "boolean",
      "label": "Smooth curves",
      "default": false
    },
    ...
  ]
}
```

The editor renders these for the chart's declared library;
the codegen reads them via the template's library-specific
slot. A future d3-based line chart would have its own
`d3_options` section.

## Architecture

```
client/src/chart-spec/
├── index.js                 — registry: chart_type → spec
├── specs/
│   ├── gauge.json
│   ├── line.json
│   ├── bar.json
│   ├── area.json
│   ├── pie.json
│   ├── scatter.json
│   ├── number.json
│   ├── dataview.json
│   └── banded_bar.json
├── schema-validator.js      — JSON Schema for the spec itself
├── field-types/             — one renderer per field type
│   ├── ColumnSelect.jsx
│   ├── EnumSelect.jsx
│   ├── ...
└── render-section.jsx       — generic section renderer

client/src/components/component-editor/
├── ComponentEditor.jsx      — shell (existing, partially refactored)
└── SpecDrivenSections.jsx   — NEW: replaces the per-type JSX blocks

client/src/chart-codegen/
├── index.js                 — registry: library → codegen
├── echarts/
│   ├── templates/
│   │   ├── gauge_v1.js
│   │   ├── line_v1.js
│   │   └── ...
│   ├── render.js            — combines template + bindings
│   └── helpers.js
└── (future: d3/, vis-network/)
```

## Feature switch

Server-side admin setting `chart_editor_spec_driven` (default
`false` in v0.21.x, flipping to `true` once stable):

- `false` → editor renders the legacy per-type JSX blocks; the
  spec exists but is unused. Codegen unchanged. Save/load
  unchanged.
- `true` → editor renders from spec; legacy JSX paths skipped.
  Codegen still uses legacy `getDataDrivenChartCode` (changes
  in Stage 3, not Stage 1).

`true` can be set globally OR per-user (via the existing
user-prefs system) so we can dogfood the spec-driven path on
specific accounts before flipping the default. Once both paths
have rendered identically for every chart type in real-world
use for a release cycle, the feature switch is removed and
the legacy paths deleted.

## Working model

This refactor runs as commits on the `chart-spec-driven-editor`
branch, not as separate PRs. The "Stage 1 / 2 / 3" headings
below describe **logical milestones** on the branch — each
should be a coherent checkpoint where the branch builds, both
flags can be flipped without regression, and the work to date
can be paused. They are not separate review units.

When the branch finally lands on `main`, it can land as one
merge or as a string of squashed merges along the stage
boundaries; that's a decision for merge time, not for
sequencing the work.

## End-state shape (what we're aiming at)

Two source-of-truth files per chart type, no third indirection:

```
client/src/chart-spec/specs/
├── gauge.json     declarative — form, capabilities, save bindings
├── gauge.js       small pure render function → ECharts option object
├── line.json
├── line.js
└── ...
```

- The **JSON** owns everything declarative: section layout,
  field types, save-time bindings, capability flags. This is
  what a future standalone editor edits. Tom can hand-edit
  it for a new chart type without re-reading 1000 lines of
  JSX.
- The **JS module** owns the per-chart ECharts shape. One
  exported `buildOption(values, data)` function, returning the
  ECharts `option` object. Roughly 40 lines per chart type
  (vs. the current ~900 in `getDataDrivenChartCode`).
- A **generic shell** wraps every chart: ResizeObserver,
  loading/error states, `useData` integration, theme. One
  copy, not per-type.
- The JSON does NOT contain a `render_module` pointer to the
  `.js`. Co-location by filename is the registry. Adding
  `"render_module": "./gauge.js"` would be ceremony — the JSON
  pretending to be configuration when it's really a stable
  boilerplate line that mirrors the file next to it. Adding
  a new chart type means writing both files; both files are
  required; the wiring between them is a one-line entry in a
  central registry alongside the field-type renderer registry
  pattern that already exists.
- The string-templated codegen path (today's "emit a code
  string that DynamicComponentLoader evaluates at runtime")
  goes away entirely. Charts become a normal React component
  that imports `buildOption` and renders. The static-vs-data-
  driven generator split also goes away — same `buildOption`
  is called with sample data for previews and real data for
  live charts.

This end-state is the destination. The stages below are the
path to get there incrementally without breaking everything
at once.

## Sequencing — three stages on the branch

### Stage 1 — schema + dual-render + dual-codegen for ONE chart type

**Why Stage 1 includes a generator:** The schema's
`codegen.template_id` + `template_bindings` blocks are part of
the schema's shape, not bolted on later. If we land the editor
side without exercising the codegen side, we may end up with
a schema that's elegant for forms but broken for code
generation — and not discover that until Stage 3 when the cost
of fixing it is much higher. The generator in Stage 1 is a
forcing function: if the schema can't drive codegen for gauge,
the schema is wrong, and we'd rather know in Stage 1 than in
Stage 3.

Stage 1 ships **two feature flags**, **gauge end-to-end** under
both, leaving every other chart type on the legacy paths:

- `chart_editor_spec_driven` (admin setting): editor renders
  the spec-driven sections when on.
- `chart_codegen_spec_driven` (admin setting): codegen uses
  the spec's template + bindings when on. Independent flag so
  we can flip editor first, codegen second, and catch divergence
  with a side-by-side check.

**Scope:**
- Write the `ChartTypeSpec` v1 JSON Schema + a TypeScript-ish
  JSDoc shape (no TS compiler dependency yet — descriptive
  types only).
- Write the `gauge.json` spec (gauge is small, contained,
  representative — see "Why gauge first" below).
- Build the `SpecDrivenSections` React component + the field-
  type renderers (`ColumnSelect`, `EnumSelect`, `NumberInput`,
  `TextInput`, `BooleanToggle`).
- Build the layout primitives as CSS (or reuse the existing
  `.metadata-row--split` patterns).
- **Build the template runtime** at `chart-codegen/echarts/
  render.js` — takes a spec, the current form values, the
  available columns, and the query config, and emits the
  same JSX-string shape `getDataDrivenChartCode` returns
  today.
- **Write the `gauge_v1` template** at `chart-codegen/echarts/
  templates/gauge_v1.js` — port the gauge branch of
  `getDataDrivenChartCode` into a function that consumes the
  spec's `template_bindings` and returns the code string.
- Wire both feature switches (admin settings under
  `/manage/settings`).
- Editor: spec-driven sections render when
  `chart_editor_spec_driven === true` AND
  `chart_type === 'gauge'`. Otherwise legacy JSX.
- Codegen: template renderer runs when
  `chart_codegen_spec_driven === true` AND
  `chart_type === 'gauge'`. Otherwise legacy
  `getDataDrivenChartCode`.
- **Side-by-side test:** with both flags off, save a gauge,
  capture the resulting component_code. Turn editor flag on,
  save again — code should be byte-identical (codegen still
  legacy). Turn codegen flag on, save again — code should be
  byte-identical (now generated from template). Any drift is
  a schema bug to fix before Stage 2.

**Acceptance:**
- Gauge editor renders from spec when its flag is on, from
  JSX when off. Identical save output.
- Gauge codegen output from template is byte-identical to the
  legacy `getDataDrivenChartCode` gauge branch output for the
  same input chart record. Verified via direct string diff on
  representative gauge configs.
- Schema validator catches malformed specs at module load.
- Both feature flags can be toggled independently in
  `/manage/settings`; UI confirms which path is active.
- One field type per category exercised (column_select, enum,
  number, text, boolean — gauge uses all but boolean; add a
  throwaway boolean field to the gauge spec for the test, or
  defer the boolean-renderer test to Stage 2).

**Why gauge first:**
- Small fields set (~6 options).
- No multi-column complexity, no series column, no axis
  config — the "easy" chart type.
- Already has the long-standing gauge UI sketched in the
  current editor, so we can A/B compare quickly.
- Stresses the conditional visibility (warning threshold
  visible only when threshold-style gauge is configured).
- Library options block is small (`echarts` only) so Stage 1
  doesn't accidentally drift into library abstraction work.

### Stage 2 — migrate the remaining chart types end-to-end

**Scope:**
- Write specs + templates for line, bar, area, pie, scatter,
  number, dataview, banded_bar.
- Migrate each chart type's editor UI AND codegen from the
  per-type JSX block + per-type codegen branch to the spec +
  template.
- Per-type whitelists (from
  `chart-config-cleanup-and-editor-split.md` Stage 2) become
  literally the spec's field list — no separate whitelist
  needed.
- Cruft-strip migration in `server-go/internal/database/
  migrations.go` runs against the spec rather than a separate
  whitelist file.
- Begin shifting per-type templates from "string emitter"
  toward `buildOption(values, data) → option` pure functions,
  per the end-state shape above. Each chart type migrated in
  Stage 2 should land closer to that shape, even if not all
  the way — the goal is to know what the final per-chart-type
  surface looks like by the end of Stage 2.
- AI tool descriptions reference the spec by name (e.g.
  `update_data_mapping` describes its fields as "see the
  current chart's spec").

**Acceptance:**
- All chart types render their editor + emit their code from
  spec/template when both flags are on.
- Side-by-side test (legacy off vs new on) produces
  byte-identical component_code for representative records of
  each chart type.
- Flag-off path still works end-to-end (deletion of the
  legacy paths is in Stage 3, not here).
- Every existing chart in dev / homelab continues to save
  and render correctly under both flag states.

### Stage 3 — flip defaults, delete legacy paths, reach end-state

**Scope:**
- Flip both feature flags' defaults to `true` in
  `server-go/config/user-configurable.yaml`.
- After at least one release cycle on the new defaults with no
  regressions reported, remove the legacy per-type JSX blocks
  from ComponentEditor and the legacy `getDataDrivenChartCode`
  + `getStaticChartCode` switches.
- Complete the migration of per-chart templates from string-
  emitters to `buildOption(values, data) → option` pure
  functions. The static-vs-data-driven generator split
  collapses into one call site that feeds either sample data
  or `useData` rows into the same function.
- Remove the feature flags themselves in a follow-up commit
  once the legacy code is gone.

**Acceptance:**
- ComponentEditor.jsx drops below 1000 lines (from current
  4813).
- No remaining `case 'gauge':` / `case 'line':` / etc.
  branches in the editor or codegen source. Adding chart
  type N+1 is one `.json` + one `.js` file under
  `chart-spec/specs/`, plus one registry entry.
- `chart_editor_spec_driven` and `chart_codegen_spec_driven`
  no longer exist as settings.
- The string-template codegen path (the thing that produced
  JSX strings for `DynamicComponentLoader` to evaluate at
  runtime) is gone for spec-driven chart types. Charts are
  normal React components that import `buildOption` from
  their spec's `.js` module.

## Per-type field audit — what each spec must capture

Before migrating a chart type to the spec, audit it against:

1. **The legacy JSX block in `ComponentEditor.jsx`** — every
   Carbon input visible there is a per-type field that must
   appear in `sections[*].fields`.
2. **The `CHART_TYPE_CONFIG.<type>` capability flags** — those
   become the spec's `capabilities` block. Drift between the
   two breaks the cross-chart "Data Mapping" panel (which gates
   aggregation / time-bucket / sort-limit / filters on these
   flags).
3. **The codegen branch in `getDataDrivenChartCode`** — every
   `chartOptions?.foo` reference is a per-type knob the
   editor must surface (or has surfaced and stripped from UI).
4. **The gap-filler list** (y-axis range, log scale, tooltip
   formatter, N-columns single-y, legend — see
   [[chart-config-cleanup-and-editor-split]]). Each gap that
   applies to the chart type lands as a new spec field during
   the migration, not as a separate follow-up.

Stage 1 audit results (gauge):

- **Per-type fields captured.** min, max, warning_threshold,
  danger_threshold, unit, arc_thickness, value_column — every
  legacy chartOptions key for gauge is in the spec.
- **Gap-filler list doesn't apply.** Gauge has no axes, no
  tooltip, no legend, no multi-column. Y-axis min/max already
  covered by gauge_min/gauge_max. Skip.
- **Capabilities reflect actual fit.** Gauge consumes one
  value — the first row of the (post-transform) result set.
  The question for each client-side transform is "does this
  meaningfully collapse N rows into one?"
  - `has_aggregation: true` — kept on. "Show avg/max/min
    of the last N rows" is a real ask. The gauge consumes
    one row; aggregation produces one row from many.
    Composes naturally.
  - `has_filters: true` — kept on. "Show only rows where
    status='active'" is a real ask.
  - Sliding Window — kept on (no capability flag for it
    yet; today gauge inherits the always-on behavior). The
    "show the last 5 min averaged" smoothed-streaming case
    needs Sliding Window + Aggregation together to work.
    PR-2-scope work: add a `has_sliding_window` flag and
    have line/bar/area opt out for non-time-series queries
    where it's not useful.
  - `has_time_bucket: false` — corrected. Time bucketing
    produces M buckets and the gauge can only render one,
    so M-1 are thrown away. Legacy was `true` but the flag
    never actually gated the JSX; the Time Bucket panel
    render condition now also checks `hasTimeBucket !==
    false`.
  - `has_sort_limit: false` — already correct. Sort+limit
    picks N rows from a result set; gauge consumes row 0
    of whatever it's given, so sort doesn't change the
    rendered value.

  Server-side aggregation (SQL GROUP BY / EdgeLake / ts-store
  rolling) is a separate layer — for query languages that
  own aggregation, the editor already hides client-side
  transforms via `queryLanguageOwnsClientSideOps`. A
  "5-minute avg gauge" on SQL is written in the SQL; on MQTT
  it's client-side sliding-window + aggregation.

  **Gating principle: chart-type AND connection-type.**
  Every cross-chart panel (Filters, Aggregation+Sort+Limit,
  Sliding Window, Time Bucket) now has a uniform shape:
  ```jsx
  {chartTypeConfig.hasX !== false && !queryLanguageOwnsClientSideOps && (...)}
  ```
  Both conditions must hold for the section to render. Chart
  types opt out via `hasX: false` in `CHART_TYPE_CONFIG`;
  connection types opt out via `queryLanguageOwnsClientSideOps`
  (true for SQL, EdgeLake — anywhere the query language owns
  filtering/aggregation). Sort+Limit gets its own
  `hasSortLimit !== false` check nested inside the Aggregation
  panel so gauge can keep aggregation while hiding sort+limit.
  Stage 1 added `hasFilters`, `hasSlidingWindow` to the flag set
  alongside the existing `hasAggregation`, `hasTimeBucket`,
  `hasSortLimit`.

  Most chart types will leave every flag absent (= panel
  shows). The mechanism exists so that the unusual types
  (gauge, number) can opt out where their render semantics
  don't compose with the transform — not so every chart
  type has to declare every flag. Today only gauge and number
  set explicit `false` values, and they only set
  `hasSortLimit: false` and `hasTimeBucket: false` (single-
  value render contract makes those two meaningless).
- **The "single-value display" template applies to `number`
  too.** `CHART_TYPE_CONFIG.number` carried the same legacy
  flag drift and is fixed in the same pass (its comment
  explicitly says "everything downstream mirrors gauge
  exactly"). When Stage 2 writes `number.json`, the same
  capabilities apply.
- **Stored-but-ignored fields stripped on next save.** The
  cruft strip from Stage 2 of the chart-config-cleanup design
  applies here too: when gauge saves through the spec path,
  data_mapping fields not in the spec's `binds` paths should
  be projected out. Currently NOT in Stage 1 scope; Stage 1 round-
  trips the full chart record verbatim, deferring the strip
  to a PR-3-level pass. Track via [[chart-config-cleanup-and-editor-split]].

## Open questions to resolve before Stage 1

1. **Spec versioning when fields are added.** If the spec
   ships v1 with five gauge fields and v2 adds `gauge_unit`,
   how do v1-saved gauges load under v2? Easy default: missing
   fields use spec defaults; new fields don't apply to
   existing records until the user opens + saves the chart.
   Document this explicitly so we don't bikeshed it per
   migration.

2. **Where the spec runtime sits in the bundle.** As JSON
   imports they're inlined at build time; as `import()`s
   they're code-split. Inline is fine for v1 — 9 chart types
   × ~3KB each = 27KB. Negligible.

3. **Schema validator: AJV or hand-rolled?** AJV is the
   industry-standard JSON Schema validator (~30KB) and gives
   us free spec-file validation at runtime in dev. Worth the
   dep; production builds can drop the validator (validation
   already passed at PR-merge time).

4. **Field id collisions.** A spec field's `id` is its key
   in the form-state map. If two chart types both define an
   `id: "y_axis"` field, do they share state across chart-
   type changes? Today's editor resets a bunch of state in
   `handleChartTypeChange` — codify that explicitly: each
   chart type's spec is a fresh form state; switching types
   resets to the new type's defaults.

5. **`column_select` data source.** The field renderer needs
   access to `availableColumns` (the query's columns). Pass
   it via React context so renderers don't need to be threaded
   through props.

6. **How does this interact with custom-code mode?** Custom
   code bypasses the spec entirely — `use_custom_code: true`
   means "I'm writing the JSX myself, the spec doesn't
   apply." The Details tab is already hidden in custom-code
   mode (v0.20.1); the spec-driven editor inherits that.

## Risks

- **Codegen is harder to fully declarativize than the
  editor.** Per-type ECharts options have intricate
  per-visualization behavior (gauge color segments,
  banded_bar's per-row envelope, pie's inner radius
  centering). The templates stay in JS, not JSON — the spec
  declares which template and what bindings; the template
  itself is procedural code. This is the right ratio.

- **Schema migration risk.** Each chart save can pick up
  new fields silently. Plan the additive-only rule
  explicitly: spec versions only ADD fields, never remove or
  rename. Field removal is a separate deprecation cycle.

- **The standalone editor goal pulls in a direction that
  competes with shipping fast.** Resist the urge to design
  for the standalone editor in Stage 1. Ship the schema +
  in-app renderer first; the standalone tool is a thin
  wrapper later.

- **Old chart records that have cruft fields.** The cruft-
  strip migration in Stage 2 removes them on the next save, but
  records that don't get re-saved keep their cruft until
  someone opens + saves. Acceptable; flagged in chart-config-
  cleanup-and-editor-split.md too.

## What this supersedes / leaves intact

**Supersedes** from `chart-config-cleanup-and-editor-split.md`:
- Per-chart-type JSX blocks → spec-driven.
- Per-chart-type codegen branches → templates.
- The "extend CHART_TYPE_CONFIG with allowedFields whitelist"
  becomes literally the spec's field list.

**Leaves intact** from `chart-config-cleanup-and-editor-split.md`:
- The structural split (move codegen / state / tabs into
  `client/src/components/component-editor/`). Stage 1 should
  land the file-organization scaffold even before the spec
  has migrated all chart types.
- The gap-filler list (axis ranges, log scale, tooltip,
  N columns, legend). These become spec entries instead of
  hand-coded fields; Stage 3 surfaces them in the schema.
- The migration to strip cruft on save.

## What stays in source forever (not in spec)

- The editor shell: tab navigation, Save/Cancel, dirty
  detection, preview pane, code viewer.
- Connection picker (shared across all chart types).
- AI agent infrastructure (the tools, the streaming, the
  result store). Agent tool *schemas* are eventually
  derivable from specs, but the dispatch + execution is
  code.
- DynamicComponentLoader (evaluates emitted code strings).
- Carbon component renderers.

## Definition of done (full series)

When Stage 3 commits land:

- `client/src/components/ComponentEditor.jsx` is <1000 lines
  (from 4813).
- No `case 'gauge':` / `case 'line':` / per-chart-type
  branches in editor or codegen source.
- Adding chart type N+1 = one `specs/foo.json` + one
  `specs/foo.js` (exporting `buildOption`) + (if needed) one
  new field-type renderer. Zero edits to ComponentEditor /
  getDataDrivenChartCode / the AI agent.
- Schema validator catches malformed specs at build time.
- `chart_editor_spec_driven` feature switch removed; only
  the spec-driven path exists.

## Definition of done (Stage 1 only)

- Branch `chart-spec-driven-editor`, two feature flags wired
  (`chart_editor_spec_driven`, `chart_codegen_spec_driven`).
- Gauge spec drives the editor's chart-options section when
  the editor flag is on; legacy JSX otherwise.
- Gauge template emits the component code when the codegen
  flag is on; legacy `getDataDrivenChartCode` otherwise.
- Save round-trip is byte-identical between legacy + new for
  representative gauge configs (with each flag independently
  on/off — four combinations).
- Schema validator runs on spec load (dev mode).
- Field-type renderers exist for column_select, enum, number,
  text, and at least one boolean (for the boolean toggle).
- Test plan added to `docs/TEST_PLAN.md` Section Q
  ("Spec-driven chart editor — gauge under feature flag").
- Memory note updated: `chart-codegen-consolidation-todo`
  is superseded (both editor and codegen sides are now
  spec-driven once Stage 3 lands).

---

## TL;DR

Stop hand-coding per-type JSX and per-type codegen. Move both
behind a JSON schema. Stage 1 ships **gauge end-to-end** (editor
+ codegen, both behind feature flags) — proves the schema can
drive both sides. Stage 2 migrates the remaining 8 chart types
end-to-end. Stage 3 flips the defaults, removes the legacy paths,
deletes the feature flags. The schema is forward-compatible
with a future standalone editor; the codegen is forward-
compatible with non-ECharts libraries via a `library:` field
on each spec.
