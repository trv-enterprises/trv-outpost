# Chart Spec-Driven Editor

**Status:** design, ready to start PR 1
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
  in PR 3, not PR 1).

`true` can be set globally OR per-user (via the existing
user-prefs system) so we can dogfood the spec-driven path on
specific accounts before flipping the default. Once both paths
have rendered identically for every chart type in real-world
use for a release cycle, the feature switch is removed and
the legacy paths deleted.

## Sequencing — three PRs

### PR 1 — schema + dual-render + dual-codegen for ONE chart type

**Why PR 1 includes a generator:** The schema's
`codegen.template_id` + `template_bindings` blocks are part of
the schema's shape, not bolted on later. If we ship the editor
side of the schema without exercising the codegen side, we may
ship a schema that's elegant for forms but broken for code
generation — and not discover that until PR 3 when the cost of
fixing it is much higher. The generator in PR 1 is a forcing
function: if the schema can't drive codegen for gauge, the
schema is wrong, and we'd rather know in PR 1 than in PR 3.

So PR 1 ships **two feature flags**, **gauge end-to-end** under
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
  a schema bug to fix before PR 2.

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
  defer the boolean-renderer test to PR 2).

**Why gauge first:**
- Small fields set (~6 options).
- No multi-column complexity, no series column, no axis
  config — the "easy" chart type.
- Already has the long-standing gauge UI sketched in the
  current editor, so we can A/B compare quickly.
- Stresses the conditional visibility (warning threshold
  visible only when threshold-style gauge is configured).
- Library options block is small (`echarts` only) so PR 1
  doesn't accidentally drift into library abstraction work.

### PR 2 — migrate the remaining chart types end-to-end

**Scope:**
- Write specs + templates for line, bar, area, pie, scatter,
  number, dataview, banded_bar.
- Migrate each chart type's editor UI AND codegen from the
  per-type JSX block + per-type codegen branch to the spec +
  template.
- Per-type whitelists (from
  `chart-config-cleanup-and-editor-split.md` PR 2) become
  literally the spec's field list — no separate whitelist
  needed.
- Cruft-strip migration in `server-go/internal/database/
  migrations.go` runs against the spec rather than a separate
  whitelist file.
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
  legacy paths is in PR 3, not here).
- Every existing chart in dev / homelab continues to save
  and render correctly under both flag states.

### PR 3 — flip defaults, delete legacy paths

**Scope:**
- Flip both feature flags' defaults to `true` in
  `server-go/config/user-configurable.yaml`.
- After a release cycle on the new defaults with no
  regressions reported, remove the legacy per-type JSX
  blocks from ComponentEditor and the legacy
  `getDataDrivenChartCode` switch.
- Remove the feature flags themselves in a follow-up patch
  once the legacy code is gone.

**Acceptance:**
- ComponentEditor.jsx drops below 1000 lines (from current
  4813).
- No remaining `case 'gauge':` / `case 'line':` / etc.
  branches in the editor or codegen source. Adding chart
  type N+1 is one .json file and one template.
- `chart_editor_spec_driven` and `chart_codegen_spec_driven`
  no longer exist as settings.

## Open questions to resolve before PR 1

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
  for the standalone editor in PR 1. Ship the schema +
  in-app renderer first; the standalone tool is a thin
  wrapper later.

- **Old chart records that have cruft fields.** The cruft-
  strip migration in PR 2 removes them on the next save, but
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
  `client/src/components/component-editor/`). PR 1 should
  land the file-organization scaffold even before the spec
  has migrated all chart types.
- The gap-filler list (axis ranges, log scale, tooltip,
  N columns, legend). These become spec entries instead of
  hand-coded fields; PR 3 surfaces them in the schema.
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

When PR 3 lands:

- `client/src/components/ComponentEditor.jsx` is <1000 lines
  (from 4813).
- No `case 'gauge':` / `case 'line':` / per-chart-type
  branches in editor or codegen source.
- Adding chart type N+1 = one `specs/foo.json` + one
  `chart-codegen/echarts/templates/foo_v1.js` + (if needed)
  one new field-type renderer. Zero edits to
  ComponentEditor / getDataDrivenChartCode / the AI agent.
- Schema validator catches malformed specs at build time.
- `chart_editor_spec_driven` feature switch removed; only
  the spec-driven path exists.

## Definition of done (PR 1 only)

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
  spec-driven once PR 3 lands).

---

## TL;DR

Stop hand-coding per-type JSX and per-type codegen. Move both
behind a JSON schema. PR 1 ships **gauge end-to-end** (editor
+ codegen, both behind feature flags) — proves the schema can
drive both sides. PR 2 migrates the remaining 8 chart types
end-to-end. PR 3 flips the defaults, removes the legacy paths,
deletes the feature flags. The schema is forward-compatible
with a future standalone editor; the codegen is forward-
compatible with non-ECharts libraries via a `library:` field
on each spec.
