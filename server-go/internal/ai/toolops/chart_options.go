// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package toolops

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
			"chartShowZoomSlider": map[string]interface{}{"type": "boolean", "description": "Show the bottom zoom/pan slider. line/area/bar only."},
			"chartStacked":        map[string]interface{}{"type": "boolean", "description": "Stack series on top of each other (bar/area). Per-column stacking can also be set on each data_mapping.y_axis entry."},
			"bandedBarStyle": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"time_series", "column_filled", "column_outlined", "column_box"},
				"description": "Visual style for chart_type='banded_bar'. Ignored for other types. 'time_series' = horizontal time x-axis, line + dots, full-width horizontal reference bands (default). 'column_filled' = single vertical column per timestamp, filled bands. 'column_outlined' = same with band borders. 'column_box' = only inner band, vertical line with tick at value (box-plot style).",
			},
			// number chart (chart_type="number") options.
			"numberFormat": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"auto", "plain", "compact", "duration", "duration_clock", "datetime"},
				"description": "number chart value format. The format IMPLIES the raw value's unit, so map a raw column and pick the format — do NOT do unit math in the query. \"auto\" (source precision), \"plain\" (1,234.5), \"compact\" (1.2M/3.4K), \"duration\" (value is SECONDS → \"2d 3h 4m\" — e.g. uptime.sec), \"duration_clock\" (seconds → HH:MM:SS), \"datetime\" (value is a timestamp → date/time via numberDateFormat). For bytes→GB there's no built-in scale yet; use compact or a custom-code number.",
			},
			"numberDateFormat": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"date", "time", "time_seconds", "datetime", "datetime_seconds"},
				"description": "Date/time style when numberFormat=\"datetime\". Ignored otherwise.",
			},
			"numberDecimals": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"auto", "0", "1", "2", "3", "4"},
				"description": "number chart decimal places. \"auto\" = source precision; \"0\"–\"4\" forces that many. Applies to auto/plain/compact formats.",
			},
			"numberUnit": map[string]interface{}{"type": "string", "description": "number chart: unit suffix rendered after the value (e.g. \"%\", \"°C\", \"GB\")."},
			"numberSize": map[string]interface{}{"type": "integer", "description": "number chart: value font size in px. Size it to the tile HEIGHT, not the default — a good fit is ≈ 13px per cell of the panel's height (a 6-cell-tall tile → ~80px; an 8-cell → ~105px; 10-cell → ~130px). The default of 120 overflows a typical 6-cell tile. Also check WIDTH: the value must fit the tile at this size — size for the WIDEST value the tile will show (a percentage ≈ 6 chars \"100.0 %\"; a duration ≈ 11 chars \"000D 00H 00M\"); narrow tiles need a smaller size. **Give every number tile the SAME tile height and ONE shared numberSize across the dashboard** so they read uniformly — uniform heights let a single font size fit them all; pick the size for that height and the narrowest value, then apply it to every number component in the build. Decimals: use engineering judgment — decimals on a value >99 are usually noise (\"100 %\", not \"100.0 %\") and also widen the value; set numberDecimals accordingly."},
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
	"chartShowDataLabels": {}, "chartShowZoomSlider": {}, "chartStacked": {},
	"bandedBarStyle": {}, "numberFormat": {}, "numberDateFormat": {},
	"numberDecimals": {}, "numberUnit": {}, "numberSize": {}, "title": {},
}

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
		if _, ok := ChartOptionKeys[k]; !ok {
			continue
		}
		dst[k] = v
		applied++
	}
	return applied
}
