# Chart configuration cleanup + ComponentEditor split

**Status:** design complete, ready to start PR 1
**Date:** 2026-05-26
**Owner:** tom
**Related memory:** `chart-options-storage-cleanup-todo`, `multiple-yaxis-series-same-range-todo`, `component-editor-stale-codegen`

> **Implementation readiness:** PR 1 (structural split) and PR 2 (cruft strip + whitelist) are fully specified — whitelist map, migration name/shape, AI tool validation, acceptance criteria all locked. PR 3 (gap fillers) has per-sub-feature schemas and codegen hooks, but the exact ECharts-options merge for `axis_config` will need a small spike inside `getDataDrivenChartCode` to confirm the merge points; not blocking, just a known unknown.

## Motivation

Two paired problems, both surfaced via the AI agent hallucinating "I set the y-axis range" when no such tool exists, and via the editor file ballooning to 4659 lines.

1. **Config storage is sloppy.** Every chart record stores every field, even ones its `chart_type` will never consume (pie records carry `series_col`, gauge records carry `chart_stacked`, etc.). The agent reads these fields back and assumes they're meaningful. The user has to drop into custom code for things that *should* be first-class (y-axis min/max, log scale, tooltip formatter).
2. **`ComponentEditor.jsx` is unmaintainable.** 4659 lines, 80+ `useState` hooks, codegen and UI shell intermixed, well past the 400-line guideline in `CLAUDE.md`.

This note proposes the cleanup and split as three sequenced PRs.

## Current state — per-chart-type field usage

For each chart type, this is what the editor shows, what codegen consumes, and what gets persisted-but-ignored:

| Field | bar / line / area | pie | scatter | gauge | number | dataview | banded_bar |
|---|---|---|---|---|---|---|---|
| `x_axis` | shown + used | shown + used | shown + used | hidden | hidden | hidden | shown + used |
| `y_axis` (multi up to 2) | shown + used | single only | single only | single only | single only | hidden | hidden (uses `band_columns`) |
| `x_axis_label` | shown + used | stored, ignored | shown + used | hidden | hidden | hidden | stored, ignored |
| `y_axis_label(s)` | shown + used | stored, ignored | shown + used | hidden | hidden | hidden | stored, ignored |
| `x_axis_format` | partial use | shown + used | stored, ignored | hidden | hidden | hidden | shown + used |
| `series_col` | shown + used (mutually exclusive with 2-column dual-axis) | stored, ignored | stored, ignored | stored, ignored | stored, ignored | stored, ignored | stored, ignored |
| `time_bucket` | stored, ignored | hidden | hidden | shown + used | shown + used | hidden | hidden |
| `aggregation` / `sort` / `limit` | shown + used | shown + used | shown + used | hidden | hidden | shown + used | hidden |
| `filters` | shown + used | shown + used | shown + used | hidden | hidden | shown + used | hidden |
| `sliding_window` | shown + used | hidden | hidden | hidden | hidden | hidden | hidden |
| `chart_stacked` / `chart_smooth` / `chart_show_zoom_slider` | shown + used | stored, ignored | stored, ignored | stored, ignored | stored, ignored | hidden | stored, ignored |
| `chart_show_data_labels` | shown + used | shown + used | hidden | hidden | hidden | hidden | hidden |
| `pie_inner_radius` / `pie_show_labels` | stored, ignored | shown + used | stored, ignored | stored, ignored | stored, ignored | hidden | stored, ignored |
| `gauge_min` / `gauge_max` / `gauge_*_threshold` / `gauge_unit` / `gauge_line_thickness` | stored, ignored | stored, ignored | stored, ignored | shown + used | stored, ignored | hidden | stored, ignored |
| `number_size` / `number_unit` | stored, ignored | stored, ignored | stored, ignored | stored, ignored | shown + used | hidden | stored, ignored |
| `visible_columns` / `column_aliases` | hidden | hidden | hidden | hidden | hidden | shown + used | hidden |
| `band_columns` / `banded_bar_style` | hidden | hidden | hidden | hidden | hidden | hidden | shown + used |

"Stored, ignored" cells are the cruft to strip.

## Dual-axis support — already exists, intentionally capped at 2

`getDataDrivenChartCode` in `client/src/components/ComponentEditor.jsx` (lines 3909, 4613) emits a dual-axis ECharts options block when `yAxisCols.length === 2`. The editor helper text on line 2461 says: *"Up to 2 values. Two uses dual-axis (left/right, color-coded); for more, split into separate charts."*

Series column and multi-y are mutually exclusive in practice — they target the same visual slot.

**The 2-column cap is intentional in dual-axis mode.** The UI uses *color* to bind each series to its axis (line color matches axis-label color). If three series shared two axes, two of them would share both an axis and a color — and the user can't tell which line maps to which axis anymore. The visual contract breaks down.

**But the cap is artificial in single-axis mode.** When there's only one y-axis, there's no axis-color binding to preserve — each column can get its own color and live happily on the same axis. The path described in `multiple-yaxis-series-same-range-todo` (split the modes: `multipleYAxis` off → N columns one axis; `multipleYAxis` on → capped at 2 with the existing color binding) cleanly threads this. CPU/MEM/disk all 0-100% is the canonical example — three columns, one axis, no ambiguity.

So PR 3 picks up the single-axis-N-columns slice, and the dual-axis ≥3 columns case stays explicitly out of scope (would need a separate disambiguation scheme — line style? axis-label numbering?). The "Series Column" rename pairs with this since it clarifies how the third route (pivot column) is different from multi-column.

## Gaps (custom code required today)

| Missing structured field | Applies to | Notes |
|---|---|---|
| **Y-axis min/max** | bar, line, area, scatter | The big one. Forces custom code for nearly every "fix the autoscale" request. |
| **Y-axis log scale** | bar, line, area, scatter | One-line ECharts option (`yAxis: { type: 'log' }`). |
| **X-axis min/max** | scatter, time-axis bar/line | Lower priority but cheap. |
| **Tooltip formatter** | all axis charts | Units, decimals, sci notation. Most-requested customization after y-range. |
| **N columns on single y-axis** | bar, line, area | When `multipleYAxis` is off, allow N columns (each a series, all on the left axis). Today capped at 2. Color binding is fine because there's only one axis. |
| **Legend** (position, hidden, scroll) | multi-series bar/line/area/pie | Lower priority; codegen hardcodes default legend. |
| **"Series Column" rename** | bar, line, area | Field name is misleading — it's a pivot column, not a series count knob. Cheap copy fix; pairs with the multi-column work. |

The dual-axis case (`multipleYAxis` on) stays capped at 2 — that's the intentional color/axis binding, not in scope to lift.

## Proposed structural changes (minimal)

Keep `data_mapping` flat to avoid migrations. Add three small first-class objects under `chart.data_mapping`:

```jsonc
"axis_config": {
  "y_left":  { "min": null, "max": null, "scale": "linear" },  // "linear" | "log"
  "y_right": { "min": null, "max": null, "scale": "linear" },
  "x":       { "min": null, "max": null }
},
"tooltip_config": {
  "format": "auto",          // "auto" | "custom"
  "decimals": null,
  "units": "",
  "custom_formatter": ""     // only when format === "custom"
},
"legend_config": {
  "show": true,
  "position": "bottom"       // "top" | "bottom" | "left" | "right" | "hidden"
}
```

All three are optional — absence = current behavior. Codegen reads them when present, ignores otherwise. No migration required.

## Cruft strip — save-time whitelist

`CHART_TYPE_CONFIG` at the top of `ComponentEditor.jsx` (lines 90-222) already declares per-type capability *booleans* (`hasAggregation`, `hasFilters`, `hasYAxis`, `multipleYAxis`, etc.). PR 2 extends it with an explicit `allowedFields` array per type — the positive whitelist of `data_mapping` and `options` keys that survive `handleSave`.

### Whitelist map (full enumeration)

Derived from the field map above. Fields not listed get stripped at save.

| chart_type | `data_mapping.allowedFields` | `options.allowedFields` |
|---|---|---|
| `bar`, `line`, `area` | `connection_id`, `x_axis`, `x_axis_label`, `x_axis_format`, `y_axis`, `y_axis_label` *(legacy)*, `y_axis_labels`, `series`, `aggregation`, `filters`, `sort_by`, `sort_order`, `limit`, `sliding_window`, `axis_config` *(PR 3)*, `tooltip_config` *(PR 3)*, `legend_config` *(PR 3)* | `chart_stacked`, `chart_smooth`, `chart_show_zoom_slider`, `chart_show_data_labels` |
| `pie` | `connection_id`, `x_axis`, `x_axis_format`, `y_axis` *(single)*, `aggregation`, `filters`, `sort_by`, `sort_order`, `limit`, `legend_config` *(PR 3)* | `pie_inner_radius`, `pie_show_labels`, `chart_show_data_labels` |
| `scatter` | `connection_id`, `x_axis`, `x_axis_label`, `y_axis` *(single)*, `y_axis_label`, `aggregation`, `filters`, `sort_by`, `sort_order`, `limit`, `axis_config` *(PR 3)*, `tooltip_config` *(PR 3)* | *(none)* |
| `gauge` | `connection_id`, `y_axis` *(single)*, `time_bucket` | `gauge_min`, `gauge_max`, `gauge_warning_threshold`, `gauge_danger_threshold`, `gauge_unit`, `gauge_line_thickness` |
| `number` | `connection_id`, `y_axis` *(single)*, `time_bucket` | `number_size`, `number_unit` |
| `dataview` | `connection_id`, `aggregation`, `filters`, `sort_by`, `sort_order`, `limit`, `visible_columns`, `column_aliases` | *(none)* |
| `banded_bar` | `connection_id`, `x_axis`, `x_axis_format`, `band_columns` | `banded_bar_style` |
| `custom` | *all of the above are permitted — custom code can read anything* | *(no restrictions)* |

`y_axis_label` is kept on the bar/line/area/scatter whitelist for backward compatibility (legacy single-label field; see ComponentEditor.jsx:283). `y_axis_labels` (plural) is the canonical replacement. Both survive the strip; the migration does not unify them.

### Save-time projection (client)

`handleSave` in `ComponentEditor.jsx` (line 1402) currently sends the full state. After PR 2:

1. Resolve `cfg = CHART_TYPE_CONFIG[chartType]`.
2. Build `payload.data_mapping` from state, then `pick` only the keys in `cfg.allowedFields.data_mapping`.
3. Same projection on `payload.options`.
4. Same projection on the `transforms` argument to `getDataDrivenChartCode` so the generated code matches the persisted record (otherwise codegen could embed values that aren't saved).

### One-shot migration

```
{"strip_chart_type_irrelevant_fields_v1", migrateStripChartTypeIrrelevantFields}
```

Appended to the slice in `server-go/internal/database/migrations.go:23`. Shape mirrors `migrateStripChartThumbnail` (line 300): iterate `components` where `component_type=chart`, `$unset` any key not in the whitelist for that record's `chart_type`. Idempotent (the framework tracks completion). Runs at startup, **before** index creation.

**Safety:** the migration is destructive (drops data). Mitigations:
- Whitelist is conservative — anything stored AND used by codegen for ANY chart type stays in the union. Only stores fields whose chart_type doesn't use them at all.
- Pre-deploy DB backup is captured by the regular homelab backup; no extra step.
- For paranoia: take a one-time mongodump of the `components` collection before the deploy that includes this migration. Add a release-note callout in the v0.X CHANGELOG entry.

No feature flag — the migration is one-shot and the whitelist is data, not behavior. Reversibility is via the mongodump above.

### AI tool surface changes (PR 2)

`server-go/internal/ai/tools.go` currently has `update_data_mapping` (line 84) and `update_chart_options` (line 217) accepting all fields regardless of chart_type. PR 2 adds chart_type-aware validation:

- Tool descriptions get a one-liner: *"Fields outside the whitelist for the active chart_type are rejected with a clear error pointing the agent at the correct tool."*
- Validation runs in the tool handler after fetching the current component (it already does this to resolve `chart_type`). Reject with a structured error: `{"error": "field_not_applicable", "field": "series", "chart_type": "pie", "message": "series column applies only to bar/line/area"}`.
- Same validation runs when the agent passes `chart_type` in `update_component_type` — the API rejects payloads that include fields outside the new type's whitelist (so type-changes get caught at the transition, not silently corrupted on next save).

## ComponentEditor.jsx split

Target structure under `client/src/components/component-editor/`:

```
component-editor/
├── ComponentEditor.jsx              ~700  shell, ~80 useState hooks, handleChartTypeChange, tab routing, save orchestration. State stays inline — see Constraints.
├── editorConstants.js               ~250  CHART_TYPES, FILTER_OPERATORS, AGGREGATION_TYPES, CHART_TYPE_CONFIG (extended with allowedFields in PR 2)
├── tabs/
│   ├── ConnectionTab.jsx            ~400  connection picker, query editor, MQTT, parser
│   ├── DataMappingTab.jsx           ~400  x/y axes, series, filters, aggregation, sliding window
│   ├── ChartOptionsTab.jsx          ~300  per-type options panels (composes the chart-options/ files)
│   ├── PreviewTab.jsx               ~300  preview table + chart
│   └── CodeTab.jsx                  ~250  generated code + custom code editor
├── chart-options/
│   ├── NumberOptions.jsx            ~50
│   ├── GaugeOptions.jsx             ~90
│   ├── PieOptions.jsx               ~50
│   ├── AxisChartOptions.jsx         ~80   bar/line/area — stacked/smooth/zoom/data-labels
│   ├── BandedBarOptions.jsx         ~60
│   ├── AxisRangeOptions.jsx         ~80   NEW — y/x min/max + log scale
│   ├── TooltipOptions.jsx           ~60   NEW
│   └── LegendOptions.jsx            ~40   NEW (optional, last)
├── codegen/
│   ├── getStaticChartCode.js        ~150  current ComponentEditor.jsx:3607-3768
│   └── getDataDrivenChartCode.js    ~900  current ComponentEditor.jsx:3769-4630 — the big one
└── helpers.js                       ~50   getQueryLabelForType, getQueryPlaceholderForType
```

### Constraints to be aware of

- **Codegen exports** (`getStaticChartCode`, `getDataDrivenChartCode`) are imported by `AIBuilderModal.jsx` and re-export sites. Strategy: **keep the old `ComponentEditor.jsx` path as a thin re-export shim** that re-exports from `component-editor/`. Zero blast radius on import sites for PR 1; sites can be migrated to the new path opportunistically later. The shim is a 3-line file:
  ```js
  export { default, getStaticChartCode, getDataDrivenChartCode } from './component-editor';
  ```
- **State extraction decision (locked):** leave the ~80 useState hooks inline in `component-editor/ComponentEditor.jsx` for PR 1. Do **not** extract `useComponentEditorState.js` yet — the cross-dependencies in `handleChartTypeChange` (resets 15+ fields) make this the riskiest extraction in the whole plan and it doesn't unblock anything in PRs 2-3. Defer to a hypothetical PR 4 if it's still worth doing after the other gains. **Remove `useComponentEditorState.js` from the target file tree above.**
- **The stale-codegen cliff** (memory: `component-editor-stale-codegen`) — flip the `!!chart.component_code` polarity in PR 1's `ComponentEditor.jsx` load logic. Tiny diff, lives in the same file we're already touching. Migration to stamp explicit `true` on records with divergent code is **separate work** — not in any of these PRs. Just the polarity flip here.

## Sequencing — three PRs

### PR 1: Structural split + stale-codegen polarity flip

**Scope:**
- Create `client/src/components/component-editor/` per the file tree above.
- Move file contents — no logic changes other than the imports the move forces.
- Old `client/src/components/ComponentEditor.jsx` becomes a 3-line re-export shim.
- Flip the `!!chart.component_code` fallback polarity (single line; see Constraints).
- Codegen functions move to `component-editor/codegen/` and re-export through the new directory's barrel.

**Acceptance criteria:**
- `npm run build` clean.
- `npm test` green (no test changes expected).
- Manual smoke: open the editor for one chart of each `chart_type` (bar, pie, scatter, gauge, number, dataview, banded_bar) — they all open, render, and save without error.
- Save a chart, reload, confirm it loads with the same state. (Polarity flip should not regress this for custom-code records.)
- Open a chart from an older record where `use_custom_code` is `undefined` and verify it now defaults to NOT custom-code mode (the flip).
- `git diff` review: no semantic changes outside the move + the one-line polarity flip.

### PR 2: Cruft strip + whitelist + AI validation

**Scope:**
- Extend `CHART_TYPE_CONFIG` entries with `allowedFields: { data_mapping: [...], options: [...] }` per the whitelist map above.
- Project payload through whitelist in `handleSave` AND in the `getDataDrivenChartCode` transforms argument.
- One-shot migration `strip_chart_type_irrelevant_fields_v1` in `server-go/internal/database/migrations.go`.
- Validation in `update_data_mapping` and `update_chart_options` tool handlers in `server-go/internal/ai/tools.go` — reject out-of-whitelist fields per chart_type with a structured error.

**Acceptance criteria:**
- For each chart_type, save a chart with stale cruft fields populated → record on disk has only whitelisted fields.
- Load an old record with stale fields, open in editor, save with no UI changes → cruft fields gone on disk.
- Migration runs once on a snapshot of prod data, completes without errors, second startup is a no-op.
- AI tool: send `update_data_mapping` with `series: "x"` against a `pie` chart → 4xx response with the structured error shape.
- Manual smoke on each chart_type: editor still functions, saves still round-trip.
- A pre-migration mongodump of `components` is captured and noted in the release CHANGELOG entry.

### PR 3: Gap fillers

Four sub-commits in one PR (or four small PRs — implementer's call based on review load):

**3a. `axis_config` — y-axis min/max + log scale**

- Schema: add `axis_config` to `data_mapping` in `server-go/internal/models/component.go`:
  ```go
  type AxisConfig struct {
      YLeft  *AxisRangeConfig `bson:"y_left,omitempty"  json:"y_left,omitempty"`
      YRight *AxisRangeConfig `bson:"y_right,omitempty" json:"y_right,omitempty"`
      X      *AxisRangeConfig `bson:"x,omitempty"       json:"x,omitempty"`
  }
  type AxisRangeConfig struct {
      Min   *float64 `bson:"min,omitempty"   json:"min,omitempty"`
      Max   *float64 `bson:"max,omitempty"   json:"max,omitempty"`
      Scale string   `bson:"scale,omitempty" json:"scale,omitempty"` // "linear" | "log"
  }
  ```
  All pointers/omitempty — absence = ECharts default.
- Editor panel: `component-editor/chart-options/AxisRangeOptions.jsx` — applies to bar/line/area/scatter. Two range groups when `multipleYAxis` is on (y_left + y_right), one when off.
- Codegen: in `getDataDrivenChartCode`, when building the `yAxis` array (around line 4613), merge `axis_config.y_left.{min,max,scale}` into the first entry and `axis_config.y_right.{...}` into the second. For single-axis mode, only `y_left` applies. `scale: "log"` becomes `type: 'log'` in ECharts.
- AI tool: `update_axis_config` with the same shape as the schema. Add to `tools.go`. Reject if `chart_type` doesn't support axes (gauge/number/pie/dataview/banded_bar).
- Whitelist: add `axis_config` to bar/line/area/scatter `data_mapping.allowedFields`.

**3b. `tooltip_config`**

- Schema: `tooltip_config: { format: "auto"|"custom", decimals: *int, units: string, custom_formatter: string }` on `data_mapping`.
- Editor panel: `TooltipOptions.jsx`. Show `custom_formatter` only when `format=custom`.
- Codegen: when `tooltip_config` is present, replace the hardcoded tooltip block (chartCodeGenerator currently at ComponentEditor.jsx:3909+; locate post-PR-1 in `codegen/getDataDrivenChartCode.js`) with the formatter the config implies. `format=auto` keeps current behavior; `format=custom` injects `custom_formatter` as the body of `tooltip.formatter`.
- AI tool: `update_tooltip_config`.
- Whitelist: add to bar/line/area/scatter.

**3c. N columns on single y-axis + "Series Column" rename**

- **Semantics:**
  - `multipleYAxis: false` (single-axis): `y_axis` may have N entries; each becomes its own series, all on `yAxisIndex: 0`. Each gets its own color from the palette.
  - `multipleYAxis: true` (dual-axis): `y_axis` capped at 2; codegen unchanged from today.
- **Editor:** the Y-axis multiselect drops the 2-cap when `multipleYAxis` is off; UI text updates accordingly (line 2461 area). Validation: if user has 3+ columns and toggles `multipleYAxis` on, prompt to drop down to 2 before accepting.
- **Codegen** (`getDataDrivenChartCode`): when `multipleYAxis` is off and `yAxisCols.length > 2`, emit one series per column with `yAxisIndex: 0`. Drop the existing `length === 2` special-case branch and replace it with a unified path that handles 1, 2, or N.
- **"Series Column" rename:** API field `series` keeps its name (backward compat). Editor `labelText` changes from "Series Column" to "Pivot by column", helper text updates to make the pivot semantics explicit (use the draft in `multiple-yaxis-series-same-range-todo.md`). AI tool description for `update_data_mapping.group_by` / `series` updates to match.
- **Whitelist:** no changes — `series` and `y_axis` are already on bar/line/area whitelists.

**3d. `legend_config`**

- Schema: `legend_config: { show: bool, position: "top"|"bottom"|"left"|"right"|"hidden" }` on `data_mapping`.
- Editor panel: `LegendOptions.jsx`. Applies to multi-series bar/line/area/pie.
- Codegen: merge into the existing legend block (currently hardcoded at chartCodeGenerator.js:216, 232 references — locate post-PR-1).
- AI tool: `update_legend_config`.
- Whitelist: add to bar/line/area/pie.

**Acceptance criteria (PR 3 overall):**
- For each sub-feature: editor renders, AI tool callable, codegen emits the right ECharts options, round-trip save/load preserves values.
- Each sub-feature is independently shippable — none requires the next to function.
- No new fields appear on chart_types where they're not in the whitelist.

## Out of scope (deferred)

- True restructure of `data_mapping` into nested sub-objects (`axis`, `filtering`, `aggregation`). User explicitly preferred to keep it flat.
- Grid padding / margins as structured config — niche, custom code is fine.
- `ReferenceLevels` cleanup on the model — separate dead-code sweep.
