# Chart configuration cleanup + ComponentEditor split

**Status:** design, not started
**Date:** 2026-05-26
**Owner:** tom
**Related memory:** `chart-options-storage-cleanup-todo`, `multiple-yaxis-series-same-range-todo`, `component-editor-stale-codegen`

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

`CHART_TYPE_CONFIG` at the top of `ComponentEditor.jsx` already declares per-type capabilities (`hasAggregation`, `hasFilters`, etc.). Extend it to a positive whitelist of which `data_mapping` / `options` keys are valid for each chart type. In `handleSave`, project the payload through that whitelist before sending to the API.

Old records get cleaned on their next save. For records that aren't touched, a one-shot entry in `server-go/internal/database/migrations.go` can strip irrelevant fields on the next deploy (the framework is idempotent and runs at startup — see `CLAUDE.md > Database Migrations`).

## ComponentEditor.jsx split

Target structure under `client/src/components/component-editor/`:

```
component-editor/
├── ComponentEditor.jsx              ~400  shell, tab routing, save orchestration
├── editorConstants.js               ~200  CHART_TYPES, FILTER_OPERATORS, AGGREGATION_TYPES, CHART_TYPE_CONFIG (extended with whitelists)
├── useComponentEditorState.js       ~300  the ~80 useState hooks + handleChartTypeChange reset
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

- **Codegen exports** (`getStaticChartCode`, `getDataDrivenChartCode`) are imported by `AIBuilderModal.jsx` and re-export sites. Moving them is a multi-file change; preserve named exports through a barrel at the new location, or update all import sites in the same PR.
- **State extraction is the riskiest piece.** ~80 useState hooks with cross-dependencies — `handleChartTypeChange` alone resets 15+ fields. Extract this last (or leave inline in the shell) so the structural split can land risk-free first.
- **The stale-codegen cliff** (memory: `component-editor-stale-codegen`) is in scope-adjacent territory. Fix the `!!chart.component_code` polarity in the same pass, since we'll be touching the load logic anyway.

## Sequencing — three PRs

### PR 1: Structural split, no behavior change

Move files, update imports, no logic changes. Easiest to review, lowest risk. Leaves state extraction inline if it turns out to be tangled.

### PR 2: Cruft strip + whitelist

- Extend `CHART_TYPE_CONFIG` with per-type field whitelists.
- Project payload through whitelist in `handleSave` (and the `getDataDrivenChartCode` transforms argument, to match what gets persisted with what gets used).
- One-shot migration in `migrations.go` to clean existing records.
- Update the AI agent's `update_data_mapping` / `update_chart_options` tool schemas to reject irrelevant fields per chart type.

### PR 3: Gap fillers

Land in this order, each independently shippable:

1. `axis_config` — y-axis min/max + log scale (highest impact). Two min/max pairs (`y_left`, `y_right`) match the existing dual-axis 2-column cap.
2. `tooltip_config` — value format, decimals, units.
3. **N columns on single y-axis** + "Series Column" rename (per `multiple-yaxis-series-same-range-todo`). Mode split: `multipleYAxis` off lifts the 2-column cap (all on left axis, each its own color); `multipleYAxis` on keeps the cap. Rename "Series Column" → "Pivot by column" or similar with clearer helper text.
4. `legend_config` — last, lowest-impact.

For each: extend `data_mapping` schema in `server-go/internal/models/component.go`, add the panel under `chart-options/`, wire into `getDataDrivenChartCode`, add a corresponding AI tool (e.g., `update_axis_config`).

## Out of scope (deferred)

- True restructure of `data_mapping` into nested sub-objects (`axis`, `filtering`, `aggregation`). User explicitly preferred to keep it flat.
- Grid padding / margins as structured config — niche, custom code is fine.
- `ReferenceLevels` cleanup on the model — separate dead-code sweep.
