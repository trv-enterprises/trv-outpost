// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package toolops

import "github.com/trv-enterprises/trve-dashboard/internal/registry"

// Shared chart-`options.*` overlay schema + apply, consumed by BOTH AI
// agent surfaces:
//   - the Dashboard Assistant (internal/ai/chat) — via create_component /
//     update_component's `options` property.
//   - the in-editor Component agent (internal/ai) — via update_chart_options.
//
// Why this lives here (the convergence seam): the two agents used to
// hand-maintain SEPARATE schemas for the same overlay, and they drifted.
// The Component agent advertised snake_case params (show_legend,
// smooth_lines, …) that its executor translated to keys like
// `showLegend` / `smoothLines` — keys the spec-driven renderer DOESN'T
// read (the client specs read `legend`, `chartSmooth`, `tooltip`,
// `yThresholds`, …). So several Component-agent "options" were dead
// writes, and it was missing yAxisRange / yThresholds / sampling /
// zoom-slider entirely. One schema + one apply, anchored to the keys the
// client specs actually read, ends the drift. See
// [[two-agents-converge-on-shared-functions]].
//
// AUTHORITATIVE KEY SET: these camelCase keys are the `binds: "options.*"`
// paths from client/src/chart-spec/specs/*.{json,js}. Keep them in sync
// when the specs gain fields. Not every chart type honors every key (a
// gauge ignores yThresholds); unknown keys are harmless — the renderer
// reads what it needs and ignores the rest.

// ChartOptionsSchema returns the inline JSON-schema for the spec-driven
// chart `options` overlay. `options` is stored as a free-form map on the
// component; enumerating the known keys here is what lets either agent
// configure axis ranges, tooltips, thresholds, etc. via config instead
// of falling back to custom code (the configure-first goal).
func ChartOptionsSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":        "object",
		"description": "Spec-driven chart options overlay. Set these to configure an existing chart rather than rewriting it as custom code. Field names are exact (camelCase) and match the editor's Chart Options form. NOTE: there is no color option — series colors are automatic (single = Carbon blue; dual-axis = blue/purple; 3+ = the Carbon categorical palette). A specific-color request needs custom code.",
		"properties": map[string]interface{}{
			"yAxisRange": map[string]interface{}{
				"type":        "object",
				"description": "Manual Y-axis bounds + scale. Shape: {left: {min, max, scale}, right: {min, max, scale}}. min/max are numbers or null (null = auto-scale to data). scale is \"linear\" (default) or \"log\". `right` is only used when data_mapping.multiple_y_axis is true (dual-axis).",
			},
			"tooltip": map[string]interface{}{
				"type":        "object",
				"description": "Tooltip config. Shape: {mode, decimals, units}. mode: \"multi\" (axis-trigger, reads all series at the hovered x — the DEFAULT and the right choice for line/area/bar/time-series), \"single\" (item-trigger, only the directly-hovered point), or \"hidden\". PREFER \"multi\" for line/area/bar: they often have no visible point markers, so \"single\" forces the user to hover an invisible point and feels unresponsive — and area is just line+fill, so it should match line. Reserve \"single\" for scatter/pie or when the user explicitly asks for per-point hover. Best of all: omit mode entirely to get the multi default. decimals: integer 0-10 or null. units: suffix string like \"%\" or \"°C\".",
			},
			"yThresholds": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "object"},
				"description": "Reference lines / color stops at specific Y values. Each: {value: number, color: hex string, label?: string}. Pair with yThresholdRenderMode. This is how you \"change the line color when it exceeds a value\" via config — set a threshold at that value with the color and yThresholdRenderMode=\"color_segments\".",
			},
			"yThresholdRenderMode": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"line", "color_segments", "both"},
				"description": "How yThresholds render: \"line\" (reference line at value, default), \"color_segments\" (color the series by value — the line/area changes color above/below each threshold), or \"both\".",
			},
			"sampling": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"off", "lttb", "average", "max"},
				"description": "Downsampling for dense (≥10k-point) series. \"lttb\" preserves visual shape; average/max preserve statistics. Default \"off\".",
			},
			"legend": map[string]interface{}{
				"type":        "object",
				"description": "Legend config. Shape: {show: bool (default true), position: \"top\"|\"bottom\"|\"left\"|\"right\" (default \"top\")}. Left/right reserve ~135px of plot width.",
			},
			"chartSmooth":         map[string]interface{}{"type": "boolean", "description": "Smooth (curved) line segments. line/area only."},
			"showSymbol":          map[string]interface{}{"type": "boolean", "description": "Show point markers on the line. Turn off for dense time series. line/area only."},
			"chartShowDataLabels": map[string]interface{}{"type": "boolean", "description": "Render the value next to each data point."},
			"chartSiPrefixes":     map[string]interface{}{"type": "boolean", "description": "Abbreviate large numbers with SI prefixes at 3 significant digits (14,340,393,939 → 14.3G) on axis ticks, gauge dial labels, data labels, and tooltip values; all labels on one axis share the same prefix. Default TRUE — only set this key (false) when the user asks for full/unabbreviated numbers."},
			"chartShowZoomSlider": map[string]interface{}{"type": "boolean", "description": "Show the bottom zoom/pan slider. line/area/bar only."},
			"xAxisLabelRotate": map[string]interface{}{
				"type":        "number",
				"enum":        []interface{}{0, 30, 45, 90},
				"description": "Rotation angle (degrees) for x-axis CATEGORY labels. 0 = horizontal (default); with horizontal labels ECharts hides some when long names overlap. Set 30/45/90 when category names are long and the chart has a SMALL, fixed set of categories (e.g. a handful of named bars) so they fit without overlap. ECharts still thins labels when there are many categories, so this does NOT help dense/streaming/timestamp x-axes. line/area/bar only.",
			},
			"chartStacked": map[string]interface{}{"type": "boolean", "description": "Stack series on top of each other (bar/area). Per-column stacking can also be set on each data_mapping.y_axis entry."},
			"barOrientation": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"vertical", "horizontal"},
				"description": "bar chart only: bar direction. \"horizontal\" swaps the axes (categories run down the side axis, bars grow left→right) — best for long category names. Default \"vertical\". Dual-axis bars stay vertical.",
			},
			"barWidthPct": map[string]interface{}{
				"type":        "number",
				"description": "bar chart only: each bar's width as a PERCENT (5–100) of its category slot. Unset = automatic sizing, which can read as thin bars when a wide panel holds few categories. With several side-by-side series, lower values keep them from overlapping.",
			},
			"bandedBarStyle": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"time_series", "column_filled", "column_outlined", "column_box"},
				"description": "Visual style for chart_type='banded_bar'. Ignored for other types. 'time_series' = horizontal time x-axis, line + dots, full-width horizontal reference bands (default). 'column_filled' = single vertical column per timestamp, filled bands. 'column_outlined' = same with band borders. 'column_box' = only inner band, vertical line with tick at value (box-plot style).",
			},
			// value chart (chart_type="value") options. This type supersedes
			// the retired "number" type; the option keys renamed number* →
			// value* with it.
			"valueFormat": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"auto", "plain", "compact", "duration", "duration_clock", "datetime"},
				"description": "value chart format. The format IMPLIES the raw value's unit, so map a raw column and pick the format — do NOT do unit math in the query. \"auto\" (source precision), \"plain\" (1,234.5), \"compact\" (1.2M/3.4K), \"duration\" (value is SECONDS → \"2d 3h 4m\" — e.g. uptime.sec), \"duration_clock\" (seconds → HH:MM:SS), \"datetime\" (value is a timestamp → date/time via valueDateFormat). For a column already in KB/MB/GB, set valueSourceUnit and use \"compact\" — do NOT scale in the query. A TEXT value renders as its own string and ignores this setting — no format or custom code is needed to show a status string.",
			},
			"valueSourceUnit": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"none", "k", "M", "G", "T", "Ki", "Mi", "Gi", "Ti"},
				"description": "value chart: what the STORED number already is, so \"compact\" abbreviates from the right magnitude. Default \"none\" (already base units). A megabytes column holding 123456 with valueSourceUnit=\"M\" renders \"123.5G\"; leaving it \"none\" would report \"123.5k\". Decimal k/M/G/T are powers of 1000 (disk vendors, network figures); binary Ki/Mi/Gi/Ti are powers of 1024 (memory and filesystem stats) — picking the wrong family is a ~2.4% error at G. Set valueUnit to the BASE unit (\"B\", not \"MB\") — the prefix comes from the value. This replaces scaling in the query.",
			},
			"valueDateFormat": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"date", "time", "time_seconds", "datetime", "datetime_seconds"},
				"description": "Date/time style when valueFormat=\"datetime\". Ignored otherwise.",
			},
			"valueDecimals": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"auto", "0", "1", "2", "3", "4"},
				"description": "value chart decimal places. \"auto\" = source precision; \"0\"–\"4\" forces that many. Applies to auto/plain/compact formats; ignored for text values.",
			},
			"valueType": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"auto", "number", "text"},
				"description": "value chart: which family of options applies. Leave unset/\"auto\" — the renderer detects it from the data and is almost always right. Set \"text\" or \"number\" ONLY to override a bad detection (empty sample, mixed column, a stream that hasn't produced a record yet). \"text\" ignores valueFormat/valueDecimals/valueUnit.",
			},
			"valueTextCase": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"none", "upper", "lower", "capitalize", "title"},
				"description": "value chart, TEXT values only: re-case the rendered string. \"none\" (default) leaves it as the source has it — prefer that unless the user asks for a specific case. \"upper\" = ALL CAPS, \"lower\" = lowercase, \"capitalize\" = first letter of the string, \"title\" = First Letter Of Each Word. Display-only; the underlying data is unchanged. Ignored for numeric values.",
			},
			"valueUnit": map[string]interface{}{"type": "string", "description": "value chart: unit suffix rendered after the value (e.g. \"%\", \"°C\", \"GB\"). Numeric values only — a text value renders no unit."},
			"valueThresholds": map[string]interface{}{
				"type":        "array",
				"description": "value chart, NUMERIC values: color the value by magnitude. Array of {value, color, label?}. Each color applies from its value UPWARD, so the highest threshold reached wins — e.g. [{value:0,color:\"#24a148\"},{value:80,color:\"#f1c21b\"},{value:90,color:\"#da1e28\"}] renders green under 80, yellow 80-89, red at 90+. Use the standard alert colors unless the user asks otherwise: #da1e28 danger, #ff832b caution, #f1c21b warning, #24a148 ok, #0f62fe info. Omit for the default text color.",
				"items":       map[string]interface{}{"type": "object"},
			},
			"valueTextThresholds": map[string]interface{}{
				"type":        "array",
				"description": "value chart, TEXT values: color the value by what it says. Array of {operator, match, color} where operator is \"eq\" (whole string) or \"contains\" (substring). Matching is CASE-INSENSITIVE, so match \"online\" catches \"ONLINE\". Rules are evaluated IN ORDER and the FIRST match wins — put specific rules above broad catch-alls. There is no limit on rule count; add one per state that matters. Example: [{operator:\"eq\",match:\"ONLINE\",color:\"#24a148\"},{operator:\"contains\",match:\"fail\",color:\"#da1e28\"}]. Omit for the default text color.",
				"items":       map[string]interface{}{"type": "object"},
			},
			"valueThresholdTarget": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"text", "background", "both"},
				"description": "value chart: where a MATCHED threshold/rule color lands. \"text\" (default) recolors the value only. \"background\" fills the whole tile with the threshold color and derives a readable text color automatically — pick this for status tiles that should read green/red at a glance. \"both\" fills and also colors the text with the threshold color (only legible on a light fill — prefer \"background\"). Applies to valueThresholds and valueTextThresholds alike. When NO threshold matches, the tile falls back to valueBackground regardless of this setting.",
			},
			"valueBackground": map[string]interface{}{
				"type":        "string",
				"description": "value chart: static background fill (hex, e.g. \"#0f62fe\") used when no threshold/rule matches. The value's text color is paired automatically for contrast — do not try to set a text color. Leave unset for a normal transparent tile.",
			},
			"valueSize": map[string]interface{}{
				"type": "integer",
				// Constrain to the same discrete size ladder the editor's
				// dropdown offers (VALUE_CHART_SIZES in the client). The model
				// must pick ONE of these, not an arbitrary integer — off-grid
				// values like 50/105/130 used to leak in from the "≈13px/cell"
				// math below and then mismatch the dropdown in the editor.
				"enum":        []int{12, 14, 16, 20, 24, 32, 40, 48, 56, 64, 80, 96, 120, 160, 200, 240, 300, 400},
				"description": "value chart: value font size in px. **Pick one of the allowed sizes (the enum) — do NOT invent an off-grid value.** Size it to the tile HEIGHT, not the default: estimate ≈ 13px per cell of the panel's height (a 6-cell-tall tile → ~80px; an 8-cell → ~105px; 10-cell → ~130px), then **round to the NEAREST allowed size** (e.g. 105 → 96, 130 → 120). The default of 56 suits a ~4-5-cell tile but under-uses a taller one — always size from the actual height. Also check WIDTH: the value must fit the tile at this size — size for the WIDEST value the tile will show (a percentage ≈ 6 chars \"100.0 %\"; a duration ≈ 11 chars \"000D 00H 00M\"; a text value can be far wider); narrow tiles need a smaller size. **Give every value tile the SAME tile height and ONE shared valueSize across the dashboard** so they read uniformly — uniform heights let a single font size fit them all; pick the size for that height and the narrowest value, then apply it to every value component in the build. Decimals: use engineering judgment — decimals on a value >99 are usually noise (\"100 %\", not \"100.0 %\") and also widen the value; set valueDecimals accordingly.",
			},
			// title is a real spec key (rendered inside the canvas for some
			// chart types). Kept here so the Component agent's old `title`
			// param has a home in the shared schema.
			"title": map[string]interface{}{"type": "string", "description": "Chart title rendered inside the chart canvas. For dashboard panel labels use the component title instead."},
		},
	}
}

// ChartOptionKeys is the set of camelCase keys ChartOptionsSchema
// advertises. ApplyChartOptions uses it to copy only known keys from a
// patch, so a stray/typo'd key can't silently pollute stored options.
var ChartOptionKeys = map[string]struct{}{
	"yAxisRange": {}, "tooltip": {}, "yThresholds": {}, "yThresholdRenderMode": {},
	"sampling": {}, "legend": {}, "chartSmooth": {}, "showSymbol": {},
	"chartShowDataLabels": {}, "chartSiPrefixes": {}, "chartShowZoomSlider": {}, "chartStacked": {},
	"xAxisLabelRotate": {}, "barOrientation": {}, "barWidthPct": {},
	"bandedBarStyle": {}, "valueFormat": {}, "valueDateFormat": {},
	"valueDecimals": {}, "valueUnit": {}, "valueSize": {}, "valueSourceUnit": {},
	"valueType": {}, "valueTextCase": {},
	"valueThresholds": {}, "valueTextThresholds": {}, "title": {},
	"valueThresholdTarget": {}, "valueBackground": {},
}

// Retired option-key spellings translate to their current names via
// registry.RetiredChartOptionKeys — the same mapping the boot migration
// and the import normalizer use. The value chart's keys renamed
// number* → value* when the "number" chart type was retired; a caller
// still sending the old spelling gets it translated rather than silently
// dropped by the known-key guard in ApplyChartOptions. Not advertised in
// the schema — the model is only ever told the current names.

// ApplyChartOptions merges a camelCase options `patch` onto a
// component's existing `dst` options map, in place. Only keys in
// ChartOptionKeys are copied (so a model typo can't write garbage). dst
// must be non-nil. A nil/empty patch is a no-op. Returns the count of
// keys applied, for the caller's result message.
//
// This is the single apply path both agents use, replacing the
// Component agent's old field-by-field translation block (which wrote
// renderer-dead keys like `showLegend`/`smoothLines`). The Dashboard
// Assistant already straight-merges `options`; this formalizes the same
// behavior with the known-key guard.
func ApplyChartOptions(dst map[string]interface{}, patch map[string]interface{}) int {
	if dst == nil || len(patch) == 0 {
		return 0
	}
	applied := 0
	for k, v := range patch {
		// Translate a retired key spelling to its current name first, so
		// an old caller's value lands on the key the renderer reads.
		if current, legacy := registry.RetiredChartOptionKeys[k]; legacy {
			k = current
		}
		if _, ok := ChartOptionKeys[k]; !ok {
			continue
		}
		dst[k] = v
		applied++
	}
	return applied
}
