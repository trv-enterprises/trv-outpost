// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// PanelTextConfig holds configuration for native text panels (no component needed)
// @Description Configuration for native text panels — section headers, date/time, titles
type PanelTextConfig struct {
	Content        string      `json:"content,omitempty" bson:"content,omitempty"`                 // Static text (used when display_content="title")
	DisplayContent string      `json:"display_content,omitempty" bson:"display_content,omitempty"` // "title", "date_short", "time_12", etc.
	Size           interface{} `json:"size,omitempty" bson:"size,omitempty"`                       // Font size in pixels (int) or legacy name (string)
	Align          string      `json:"align,omitempty" bson:"align,omitempty"`                     // "left", "center", "right"
}

// DashboardPanel represents a panel position in the dashboard grid
// @Description Panel position and size in the grid with optional component reference or text config
type DashboardPanel struct {
	ID          string           `json:"id" bson:"id"`
	X           int              `json:"x" bson:"x"`
	Y           int              `json:"y" bson:"y"`
	W           int              `json:"w" bson:"w"`
	H           int              `json:"h" bson:"h"`
	ComponentID string           `json:"component_id,omitempty" bson:"component_id,omitempty"` // Reference to a component (chart, control, or display) — the DEFAULT component for this panel
	TextConfig  *PanelTextConfig `json:"text_config,omitempty" bson:"text_config,omitempty"`   // Native text panel config
	// ComponentOverrides lets a panel render a DIFFERENT component depending on
	// the active dashboard-variable value (component-swap-by-rule). Rules are
	// evaluated top-to-bottom; the first whose predicate matches the active
	// variable wins and its ComponentID renders. No match → the panel's default
	// ComponentID. For a connection_swap variable the swapped component also
	// reads from the selected connection (component + connection swap together);
	// for a filter variable only the component swaps (it keeps its own
	// connection and still receives the filter-value substitution).
	//
	// This REPLACES the former per-panel pin_connection opt-out: a panel that
	// must stay fixed simply has no overrides and points its default at the
	// connection it wants.
	ComponentOverrides []ComponentOverride `json:"component_overrides,omitempty" bson:"component_overrides,omitempty"`
	// ConnectionTags binds this panel to a DIFFERENT connection family when
	// the dashboard's connection_swap variable is in tag_value mode. The
	// panel's connection resolves to the one matching ConnectionTags plus the
	// key tag (`prefix:<selected value>`) — these tags REPLACE the variable's
	// Tags for this panel (they do not union with them; a docker connection
	// does not carry the synology tags). Static: no reference to the variable
	// or any of its values, so one selection re-resolves every family.
	//
	// Lives on the panel (not the component record, which is shared across
	// dashboards, and not a dashboard-level side map, which would need
	// panel-id remapping on duplicate the way panel_border adornments do).
	// Empty/nil = the panel follows the variable's primary family. Ignored
	// entirely outside tag_value mode; retained dormant when the variable is
	// disabled (keep-and-count policy — see multi-connection-swap.md).
	ConnectionTags []string `json:"connection_tags,omitempty" bson:"connection_tags,omitempty"`
}

// ComponentOverride is one component-swap rule on a DashboardPanel.
// @Description A predicate over the active dashboard-variable value that selects an alternate component for the panel.
type ComponentOverride struct {
	// Subject — what the predicate tests:
	//   "variable" — the variable's effective VALUE string. For connection_swap
	//                that's the selected connection's display value (the
	//                configured prefix-tag value, else the connection NAME as
	//                fallback). For a filter variable it's the filter value.
	//   "tag"      — the VALUE part of one of the selected connection's
	//                prefix:value tags (connection_swap variables only).
	Subject string `json:"subject" bson:"subject"`
	// Op — "eq" (exact match) or "contains" (case-insensitive substring).
	Op string `json:"op" bson:"op"`
	// Value — the operand the subject is compared against (e.g. "PI").
	Value string `json:"value" bson:"value"`
	// ComponentID — the component to render when this rule matches.
	ComponentID string `json:"component_id" bson:"component_id"`
}

// Adornment kinds. The Kind field discriminates the adornment sub-type so
// future decorations (labels, dividers, fills) slot in without a schema change.
const (
	// AdornmentKindBorder is a free-drawn box positioned by cell rect, whose
	// line draws centered in the gutter BETWEEN panels.
	AdornmentKindBorder = "border"
	// AdornmentKindPanelBorder is a border bound to one panel by ID, drawn
	// INSIDE that panel's own footprint. It has no rect of its own — it
	// follows the panel as the panel moves and resizes.
	AdornmentKindPanelBorder = "panel_border"
)

// Adornment line styles.
//
// "hidden" is a real style, not an absence: the border still exists, still
// occupies its rect, and still groups the panels it encloses for mobile flow
// order (#180) — it simply isn't painted in either view surface. The editor
// draws it as a faint hairline so it stays findable and selectable; without
// that it would be an object that can never be restyled, moved, or deleted.
// Named "hidden" rather than "none" because CSS's `none` reads as "there is no
// border", which is the opposite of what this means.
const (
	AdornmentLineSolid  = "solid"
	AdornmentLineDashed = "dashed"
	AdornmentLineDotted = "dotted"
	AdornmentLineHidden = "hidden"
)

// AdornmentWidths are the accepted widths for a gutter `border`. The line
// hugs the panel edge and grows OUTWARD into the 4px gutter, so nothing is
// centered and odd widths are fine. At 2px two adjacent boxes each take half
// the gutter and meet exactly without overlapping; wider neighbours overlap
// each other, which is the author's choice rather than a geometry error.
var AdornmentWidths = []int{1, 2, 3, 4}

// PanelBorderWidths are the accepted widths for a `panel_border`. Odd values
// are fine here — unlike a gutter border there is nothing to center: the line
// grows INWARD from the panel's own edge, so no half-pixel arises.
var PanelBorderWidths = []int{1, 2, 3}

// WidthsForAdornmentKind returns the legal width set for a given kind.
func WidthsForAdornmentKind(kind string) []int {
	if kind == AdornmentKindPanelBorder {
		return PanelBorderWidths
	}
	return AdornmentWidths
}

// DashboardAdornment is a purely visual decoration drawn over the panel grid.
//
// Adornments are stored SEPARATELY from panels because they are not panels:
// they reference no component, render no data, and must not appear in panel
// counts, component-usage lookups, export dependency walks, or the AI panel
// schemas. Keeping them in their own array means every existing panel consumer
// stays untouched.
//
// The two kinds are positioned in fundamentally different ways:
//
//   - "border" carries a cell rect in the SAME units as DashboardPanel
//     {x,y,w,h}. The renderer pushes that rect outward so the line draws
//     centered in the gap BETWEEN panels rather than over panel content. A
//     panel moved onto one simply overlaps it — there is no stored
//     relationship to repair.
//   - "panel_border" carries a PanelID and no rect. It renders inside that
//     panel's own footprint and therefore follows the panel automatically as
//     it moves or resizes. Because the line sits within the panel edge, two
//     bordered neighbours show two distinct lines separated by the gutter
//     instead of merging into one.
//
// @Description A visual decoration (a free-drawn box, or a border bound to a panel) drawn over the dashboard grid
type DashboardAdornment struct {
	ID   string `json:"id" bson:"id"`
	Kind string `json:"kind" bson:"kind"` // "border" | "panel_border"
	// X/Y/W/H position a "border". Unused (and omitted) for "panel_border",
	// which derives its geometry from the panel it is bound to.
	//
	// FLOAT, not int, because a border edge can land on a THIRD of a cell as
	// well as a cell boundary (#309) — the author can box a region that
	// doesn't align to the 32x32 grid. Panels remain integer-only; only these
	// free-drawn boxes are fractional.
	//
	// No migration was needed for the int->float64 change: a stored `5`
	// decodes into float64 from both JSON and BSON, and whole-number borders
	// still marshal back as `5`, so existing dashboards round-trip unchanged.
	X float64 `json:"x,omitempty" bson:"x,omitempty"`
	Y float64 `json:"y,omitempty" bson:"y,omitempty"`
	W float64 `json:"w,omitempty" bson:"w,omitempty"`
	H float64 `json:"h,omitempty" bson:"h,omitempty"`
	// PanelID binds a "panel_border" to its panel. Required for that kind;
	// empty for "border". An adornment whose panel no longer exists is
	// dropped on save (see sanitizeAdornments) so deleting a panel cannot
	// leave an orphan behind.
	PanelID string `json:"panel_id,omitempty" bson:"panel_id,omitempty"`
	// Color is a hex string ("#fa4d56") chosen from the same swatch palette the
	// value-chart text rules use. The server assigns no default; the client
	// supplies one (Carbon red50) on create.
	Color string `json:"color,omitempty" bson:"color,omitempty"`
	// Width is the line width in px — must be one of the values returned by
	// WidthsForAdornmentKind for this adornment's Kind.
	Width int `json:"width,omitempty" bson:"width,omitempty"`
	// LineStyle is "solid", "dashed", or "dotted".
	LineStyle string `json:"line_style,omitempty" bson:"line_style,omitempty"`
}

// ChartQueryConfig defines how to query data for a chart
// @Description Query configuration for fetching chart data
type ChartQueryConfig struct {
	Raw    string                 `json:"raw" bson:"raw"`       // SQL query, filter, or API path
	Type   string                 `json:"type" bson:"type"`     // sql, csv_filter, stream_filter, api
	Params map[string]interface{} `json:"params" bson:"params"` // Query parameters
}

// DataFilter defines a single filter condition
// @Description Filter condition for data transformation
type DataFilter struct {
	Field string      `json:"field" bson:"field"` // Column name to filter on
	Op    string      `json:"op" bson:"op"`       // Operator: eq, neq, gt, gte, lt, lte, contains, in, notIn, isNull, isNotNull
	Value interface{} `json:"value" bson:"value"` // Value to compare against (can be array for 'in' operator)
}

// ColumnRule is one conditional-formatting rule on a dataview column.
//
// Rules are stored per column (ChartDataMapping.ColumnRules) and evaluated
// top-down with FIRST MATCH WINS, which is what lets a specific "equals"
// rule sit above a broad "contains" catch-all. The stored order therefore
// carries meaning and must never be sorted on the way in or out.
//
// The server does not evaluate these — the grid does, client-side, per cell
// (see resolveColumnRule in client/src/chart-spec/option-helpers.js). This
// type exists so the config survives the round trip through the strict
// data_mapping struct.
//
// @Description One conditional-formatting rule for a dataview column
type ColumnRule struct {
	Op       string `json:"op" bson:"op"`                                 // Match operator: eq, contains, gt, lt, empty
	Value    string `json:"value,omitempty" bson:"value,omitempty"`       // Operand. Unused by "empty"; a blank operand on any other operator makes the rule inert (a half-typed rule must not match every row).
	Color    string `json:"color" bson:"color"`                           // Hex color applied on match
	Target   string `json:"target,omitempty" bson:"target,omitempty"`     // What to paint: "text" (default) or "both" (text + background, text paired for contrast)
	WholeRow bool   `json:"wholeRow,omitempty" bson:"wholeRow,omitempty"` // When true the whole row is painted, not just this cell. If rules in several columns claim the row, the leftmost column wins.
}

// SlidingWindow defines a time-based window for filtering data
// @Description Time window configuration for limiting data to recent entries
type SlidingWindow struct {
	Duration     int    `json:"duration" bson:"duration"`           // Window duration in seconds (e.g., 300 = last 5 minutes)
	TimestampCol string `json:"timestamp_col" bson:"timestamp_col"` // Column containing timestamps
}

// LatestBy reduces a result set to the newest row per distinct value of a
// key column — "current state per series" (e.g. one row per disk/volume).
//
// This is the CLIENT-SIDE twin of ts-store's server-side `latest_by` query
// param: identical semantics applied at render time instead of at the source.
// A REST ts-store component should prefer the server-side param (less data
// over the wire); a streaming component has no such option, so the reduction
// happens in the browser against the buffered stream.
//
// Applied by the client in dataTransforms.js — the server only stores it.
// @Description Newest-row-per-key reduction for multi-series components
type LatestBy struct {
	KeyCol       string `json:"key_col" bson:"key_col"`                                 // Column whose distinct values define the series
	TimestampCol string `json:"timestamp_col,omitempty" bson:"timestamp_col,omitempty"` // Column deciding which row is newest; empty = last-arrived wins (correct for append-ordered stream buffers)
}

// TimeBucket defines time-bucketed aggregation for streaming data
// @Description Time bucket configuration for aggregating streaming data into intervals
type TimeBucket struct {
	Interval     int      `json:"interval" bson:"interval"`           // Bucket interval in seconds (e.g., 60 = 1 minute, 3600 = 1 hour)
	Function     string   `json:"function" bson:"function"`           // Aggregation function: avg, min, max, sum, count
	ValueCols    []string `json:"value_cols" bson:"value_cols"`       // Columns to aggregate (numeric values)
	TimestampCol string   `json:"timestamp_col" bson:"timestamp_col"` // Column containing timestamps for bucket alignment
}

// DataAggregation defines how to aggregate/reduce data
// @Description Aggregation configuration for data transformation
type DataAggregation struct {
	Type   string `json:"type" bson:"type"`       // first, last, min, max, avg, sum, count, limit
	SortBy string `json:"sort_by" bson:"sort_by"` // Column to sort by (for first/last)
	Field  string `json:"field" bson:"field"`     // Column to aggregate (for min/max/avg/sum)
	Count  int    `json:"count" bson:"count"`     // Row count (for limit)
}

// ChartDataMapping defines how to map query results to chart elements
// @Description Mapping configuration from data columns to chart axes/series
type ChartDataMapping struct {
	XAxis           string                  `json:"x_axis" bson:"x_axis"`                                             // Column for X axis (categories)
	XAxisLabel      string                  `json:"x_axis_label" bson:"x_axis_label"`                                 // Label for X axis (e.g., "Time", "Date"). Empty = render no x-axis name; most charts are time-based and don't need one.
	XAxisFormat     string                  `json:"x_axis_format" bson:"x_axis_format"`                               // Format for X axis values: chart, chart_time, chart_date, chart_datetime, short, long, etc.
	YAxis           []string                `json:"y_axis" bson:"y_axis"`                                             // Columns for Y axis (values/series)
	YAxisLabel      string                  `json:"y_axis_label" bson:"y_axis_label"`                                 // AXIS label for the LEFT y axis, rendered at the top of it. Optional on single- AND dual-axis charts (dual used to suppress axis labels entirely, which left a legend-less dual chart with nothing to identify either side). Series/legend labels live in YAxisLabels. The old save-path mirror (YAxisLabels[0] copied here) was removed; strip_y_axis_label_mirror cleaned stored copies.
	YAxisLabelRight string                  `json:"y_axis_label_right,omitempty" bson:"y_axis_label_right,omitempty"` // AXIS label for the RIGHT y axis of a dual-axis chart. Ignored when the chart is single-axis (there is no right axis to name).
	YAxisLabels     []string                `json:"y_axis_labels,omitempty" bson:"y_axis_labels,omitempty"`           // Per-SERIES labels (legend names), index-aligned to YAxis. Missing entries fall back to the column name. These never label the axes — the axis label is YAxisLabel (single-axis only).
	YAxisColors     []string                `json:"y_axis_colors,omitempty" bson:"y_axis_colors,omitempty"`           // Per-column series color overrides (resolved hex; "" = auto palette). Index-aligned to YAxis, same parallel-array pattern as YAxisLabels (the wire y_axis is a string array). Not applied to pivot charts (Series set). Omitted when no column has an explicit color.
	Series          string                  `json:"series" bson:"series"`                                             // Column that identifies each series (e.g., "location") - used for time bucket partitioning
	GroupBy         string                  `json:"group_by" bson:"group_by"`                                         // Column to group/split series by (client-side grouping)
	LabelCol        string                  `json:"label_col" bson:"label_col"`                                       // Column for labels
	Filters         []DataFilter            `json:"filters" bson:"filters"`                                           // Client-side filters applied after data fetch
	Aggregation     *DataAggregation        `json:"aggregation" bson:"aggregation"`                                   // Aggregation to apply (first, last, avg, etc.)
	SlidingWindow   *SlidingWindow          `json:"sliding_window" bson:"sliding_window"`                             // Time-based sliding window (e.g., last 5 minutes)
	LatestBy        *LatestBy               `json:"latest_by,omitempty" bson:"latest_by,omitempty"`                   // Newest row per distinct key value ("current state per series"). Client-side twin of ts-store's latest_by param; applied in dataTransforms.js. Multi-series views only (dataview/bar/line/area/scatter) — single-value views use a filter + last aggregation instead.
	TimeBucket      *TimeBucket             `json:"time_bucket" bson:"time_bucket"`                                   // Time-bucketed aggregation for streaming data
	SortBy          string                  `json:"sort_by" bson:"sort_by"`                                           // Column to sort by
	SortOrder       string                  `json:"sort_order" bson:"sort_order"`                                     // asc or desc
	Limit           int                     `json:"limit" bson:"limit"`                                               // Max rows to return
	ColumnAliases   map[string]string       `json:"column_aliases" bson:"column_aliases"`                             // Display names for columns (column name -> display name), primarily for dataview
	VisibleColumns  []string                `json:"visible_columns,omitempty" bson:"visible_columns,omitempty"`       // For dataview only: columns to render as table columns. Empty/missing = show all (default). Preserves the order given.
	ColumnWidths    map[string]int          `json:"column_widths,omitempty" bson:"column_widths,omitempty"`           // For dataview only: column name -> pixel width. Default if a per-user override isn't set in app_config.dataview_layouts.
	ColumnFormats   map[string]string       `json:"column_formats,omitempty" bson:"column_formats,omitempty"`         // For dataview only: column name -> value format ("compact" SI 127G, "duration", "duration_clock", "plain"). Missing/"auto" = default cell formatting. Same format vocabulary as the number tile (number-formats.js).
	ColumnRules     map[string][]ColumnRule `json:"column_rules,omitempty" bson:"column_rules,omitempty"`             // For dataview only: column name -> conditional-formatting rules. Evaluated top-down, FIRST MATCH WINS (the order is the author's logic, so it must be preserved as given).
	Parser          *StreamParserConfig     `json:"parser,omitempty" bson:"parser,omitempty"`                         // Per-component data extraction for streaming (MQTT, ts-store MQTT)
	BandColumns     *BandColumns            `json:"band_columns,omitempty" bson:"band_columns,omitempty"`             // Banded-bar column mapping. Each row in the data is expected to carry a Mean column plus paired ±1 SD / ±2 SD columns; the renderer reads each row's own values to draw a per-row envelope. The chart is per-row only — there is no scalar/fixed-band convention.

	// ReferenceLevels was the original scalar (Westgard) reference-marker
	// list. Banded-bar moved to a per-row-only convention (BandColumns
	// above) so this field is read-only/legacy: existing components keep
	// it for backward compat reads but the editor + AI tools no longer
	// write it. Safe to remove once all stored components migrate.
	ReferenceLevels []ReferenceLevel `json:"reference_levels,omitempty" bson:"reference_levels,omitempty"`

	// AccumulatorColumns is the PER-COLUMN pairwise-delta transform (#8): a
	// parallel boolean array index-aligned to YAxis (like YAxisColors/Labels).
	// A true entry makes that line/area series plot value[i]-value[i-1] instead
	// of the raw value — for monotonically-increasing counters (odometers,
	// packet counters, kWh meters) — so a chart can delta one column and leave
	// another raw. AccumulatorResetPolicy (chart-wide) governs counter resets
	// (delta < 0): "drop_negative" (default — break the line), "clamp_zero",
	// "keep_negative". Renderer-side transform; the stored values are untouched.
	//
	// AccumulatorMode is the LEGACY chart-wide flag (the original #8 shape):
	// true = delta ALL y-columns. Kept for back-compat reads of records saved
	// before per-column landed; the renderer treats it as "all columns" only
	// when AccumulatorColumns is absent. New writes use AccumulatorColumns.
	AccumulatorColumns     []bool `json:"accumulator_columns,omitempty" bson:"accumulator_columns,omitempty"`
	AccumulatorMode        bool   `json:"accumulator_mode,omitempty" bson:"accumulator_mode,omitempty"`
	AccumulatorResetPolicy string `json:"accumulator_reset_policy,omitempty" bson:"accumulator_reset_policy,omitempty"`

	// YAxisConversions is the PER-COLUMN unit conversion (#265): a parallel
	// array index-aligned to YAxis (like YAxisColors/AccumulatorColumns). A
	// non-null entry converts that series' values BEFORE they are plotted, so
	// the axis, thresholds and tooltip all read the converted unit — e.g. a
	// column stored in Celsius displayed as Fahrenheit.
	//
	// Each entry is either a registry conversion {dimension, from, to} (e.g.
	// {"dimension":"temperature","from":"c","to":"f"}) or the custom affine
	// form {dimension:"custom", scale, offset, symbol?}. The unit tables and
	// all conversion math live client-side in client/src/chart-spec/units.js;
	// the server stores and round-trips the descriptor without interpreting
	// it, which is why this is a free-form map rather than a typed struct —
	// adding a dimension must not require a server change.
	YAxisConversions []map[string]interface{} `json:"y_axis_conversions,omitempty" bson:"y_axis_conversions,omitempty"`
}

// NormalizeYAxisColumns coerces the several shapes an LLM client commonly sends
// for y_axis into the canonical []string of column names. The wire contract is
// an array of plain strings (e.g. ["temp", "humidity"]), but models frequently
// emit the object shape ["{column: temp}"] (mirroring y_axis_columns elsewhere)
// or a bare "temp" string. Accepting all three keeps a correct-intent call from
// being rejected over a shape nit. Accepted inputs:
//   - ["temp","humidity"]              → ["temp","humidity"]
//   - [{"column":"temp"}, {"col":"x"}] → ["temp","x"]   (column | col | name | value keys)
//   - "temp"                           → ["temp"]
//   - mixed arrays of the above        → flattened to names
//
// Unrecognized entries are skipped. Returns (nil, false) when raw isn't one of
// these shapes, so the caller can fall back to the standard decode/error.
func NormalizeYAxisColumns(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	// Already the canonical array-of-strings (the common case) — fast path.
	var strs []string
	if err := json.Unmarshal(raw, &strs); err == nil {
		return strs, true
	}
	// Bare string → single column.
	var one string
	if err := json.Unmarshal(raw, &one); err == nil {
		return []string{one}, true
	}
	// Array of mixed string/object entries.
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, false
	}
	out := make([]string, 0, len(arr))
	for _, el := range arr {
		var s string
		if err := json.Unmarshal(el, &s); err == nil {
			out = append(out, s)
			continue
		}
		var obj map[string]interface{}
		if err := json.Unmarshal(el, &obj); err == nil {
			for _, key := range []string{"column", "col", "name", "value"} {
				if v, ok := obj[key].(string); ok && v != "" {
					out = append(out, v)
					break
				}
			}
		}
		// Anything else (number, null, unkeyed object) is skipped.
	}
	return out, true
}

// UnmarshalJSON tolerates the common y_axis shape mistakes (object entries or a
// bare string) by normalizing y_axis before the standard decode, then defers to
// the default struct unmarshal for every other field. This makes create/update
// component robust to LLM clients that send y_axis: [{"column":"x"}] instead of
// the canonical ["x"] — they no longer hard-fail with "cannot unmarshal object
// into ... y_axis of type string".
func (m *ChartDataMapping) UnmarshalJSON(data []byte) error {
	type alias ChartDataMapping // avoid recursion
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	// Pre-normalize y_axis so the aliased decode sees canonical []string.
	if yRaw, ok := raw["y_axis"]; ok {
		if cols, normalized := NormalizeYAxisColumns(yRaw); normalized {
			b, err := json.Marshal(cols)
			if err != nil {
				return err
			}
			raw["y_axis"] = b
		}
	}
	patched, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	var a alias
	if err := json.Unmarshal(patched, &a); err != nil {
		return err
	}
	*m = ChartDataMapping(a)
	return nil
}

// BandColumns maps each conceptual band role to a row-column name. The
// data adapter pulls each row's own value from the named column at
// render time; this is the per-row Levey-Jennings envelope contract.
// Columns referenced here must exist in every row of the data stream.
//
// Scheme drives which fields are meaningful (client band-schemes.js):
//   - "sd" (default / legacy): Mean + ±1/±2 SD
//   - "minmaxmean":            Mean + Min/Max
//   - "spc":                   Target + Lower/Upper Control + Lower/Upper Limit
//
// Records written before the scheme selector have no Scheme set; the
// client defaults them to "sd", matching the original fixed structure.
type BandColumns struct {
	Scheme string `json:"scheme,omitempty" bson:"scheme,omitempty"` // "sd" (default) | "minmaxmean" | "spc"

	// sd / minmaxmean center
	Mean string `json:"mean,omitempty" bson:"mean,omitempty"` // Primary value column (e.g. "mean")
	// sd bounds
	Plus1SD  string `json:"plus_1sd,omitempty" bson:"plus_1sd,omitempty"`   // +1 SD bound
	Minus1SD string `json:"minus_1sd,omitempty" bson:"minus_1sd,omitempty"` // -1 SD bound
	Plus2SD  string `json:"plus_2sd,omitempty" bson:"plus_2sd,omitempty"`   // +2 SD bound
	Minus2SD string `json:"minus_2sd,omitempty" bson:"minus_2sd,omitempty"` // -2 SD bound
	// minmaxmean bounds
	Min string `json:"min,omitempty" bson:"min,omitempty"`
	Max string `json:"max,omitempty" bson:"max,omitempty"`
	// spc center + bounds
	Target       string `json:"target,omitempty" bson:"target,omitempty"`
	LowerControl string `json:"lower_control,omitempty" bson:"lower_control,omitempty"`
	UpperControl string `json:"upper_control,omitempty" bson:"upper_control,omitempty"`
	LowerLimit   string `json:"lower_limit,omitempty" bson:"lower_limit,omitempty"`
	UpperLimit   string `json:"upper_limit,omitempty" bson:"upper_limit,omitempty"`
}

// ReferenceLevel is the legacy scalar marker type. Retained only so the
// ReferenceLevels field on ChartDataMapping deserializes cleanly for
// pre-existing components. New banded-bar charts use BandColumns.
type ReferenceLevel struct {
	Value float64 `json:"value" bson:"value"`
	Label string  `json:"label" bson:"label"`
	Kind  string  `json:"kind,omitempty" bson:"kind,omitempty"`
}

// StreamParserConfig configures how to extract data from streaming messages.
// Used when messages arrive in an envelope format (e.g., ts-store MQTT sink publishes
// {"type": "data", "timestamp": nanoseconds, "data": {...actual fields...}}).
type StreamParserConfig struct {
	DataPath       string `json:"data_path,omitempty" bson:"data_path,omitempty"`             // Dot-notation path to data object (e.g., "data", "payload.readings")
	TimestampField string `json:"timestamp_field,omitempty" bson:"timestamp_field,omitempty"` // Field containing timestamp (extracted before data_path)
	TimestampScale string `json:"timestamp_scale,omitempty" bson:"timestamp_scale,omitempty"` // "s", "ms", "ns" — auto-detected if empty
}

// EmbeddedChart represents a chart embedded directly in a dashboard
// @Description Chart stored within a dashboard, keyed by panel_id
type EmbeddedChart struct {
	ID            string                 `json:"id" bson:"id"`
	Name          string                 `json:"name" bson:"name"`
	ChartType     string                 `json:"chart_type" bson:"chart_type"`           // bar, line, pie, etc.
	ConnectionID  string                 `json:"connection_id" bson:"connection_id"`     // Reference to connection (was connection_id)
	QueryConfig   *ChartQueryConfig      `json:"query_config" bson:"query_config"`       // How to query data
	DataMapping   *ChartDataMapping      `json:"data_mapping" bson:"data_mapping"`       // How to map data to chart
	ComponentCode string                 `json:"component_code" bson:"component_code"`   // Custom React component code
	UseCustomCode bool                   `json:"use_custom_code" bson:"use_custom_code"` // Whether custom code mode is enabled
	Options       map[string]interface{} `json:"options" bson:"options"`                 // ECharts options overrides
}

// Dashboard represents a complete dashboard configuration
// @Description Dashboard with panels that reference standalone charts
type Dashboard struct {
	ID          string                 `json:"id" bson:"_id"`
	Namespace   string                 `json:"namespace" bson:"namespace"` // Conflict-domain; uniqueness is (namespace, name). See models.Namespace.
	Name        string                 `json:"name" bson:"name" binding:"required"`
	Description string                 `json:"description" bson:"description"`
	Panels      []DashboardPanel       `json:"panels" bson:"panels"`                             // Panels with component_id references
	Adornments  []DashboardAdornment   `json:"adornments,omitempty" bson:"adornments,omitempty"` // Visual decorations drawn over the grid
	Settings    DashboardSettings      `json:"settings" bson:"settings"`
	Tags        []string               `json:"tags,omitempty" bson:"tags,omitempty"` // User-defined tags for filtering/grouping
	Metadata    map[string]interface{} `json:"metadata,omitempty" bson:"metadata,omitempty"`
	Created     time.Time              `json:"created" bson:"created"`
	Updated     time.Time              `json:"updated" bson:"updated"`
}

// DashboardSettings contains dashboard-level configuration
// @Description Dashboard settings and preferences
type DashboardSettings struct {
	Theme           string `json:"theme" bson:"theme"`
	RefreshInterval int    `json:"refresh_interval" bson:"refresh_interval"`
	TimeZone        string `json:"timezone,omitempty" bson:"timezone,omitempty"`
	DefaultView     string `json:"default_view,omitempty" bson:"default_view,omitempty"`
	IsPublic        bool   `json:"is_public" bson:"is_public"`
	AllowExport     bool   `json:"allow_export" bson:"allow_export"`
	LayoutDimension string `json:"layout_dimension,omitempty" bson:"layout_dimension,omitempty"`
	TitleScale      int    `json:"title_scale,omitempty" bson:"title_scale,omitempty"` // Title font scale % (default 100, range 50-200)
	// PanelBackground overrides the deployment-wide `transparent_panels`
	// appearance setting FOR THIS DASHBOARD ONLY.
	//   ""            — inherit the global setting (the default; omitted from
	//                   storage, so every existing dashboard keeps today's
	//                   behavior with no migration)
	//   "solid"       — force the standard raised panel surface
	//   "transparent" — force floating panels
	// Deliberately a string rather than a *bool: "inherit" is a real third
	// state, and a nullable bool makes that distinction easy to lose through
	// JSON/BSON round-trips and form handling.
	//
	// NOTE the asymmetric tags. `bson` deliberately has NO omitempty: with it,
	// an empty value serialized to nothing, so setting the field back to
	// "Default" was indistinguishable from "don't touch it" and the previous
	// choice survived — once a dashboard was set to solid or transparent it
	// could never be returned to inheriting. Persisting "" is what makes the
	// third state reachable. `json` keeps omitempty so the field stays absent
	// from API responses for dashboards that never opted in.
	PanelBackground string `json:"panel_background,omitempty" bson:"panel_background"`
	// ScalePercent is the "everything bigger" zoom. LayoutDimension is the
	// render TARGET; the dashboard is BUILT on a derived DESIGN canvas of
	// target/(scale/100), so at render the viewer's transform:scale blows
	// it back up to target — uniformly enlarging fonts, lines, and layout
	// while preserving proportions. 100 = build at target (no enlargement);
	// 120 = build on target/1.2 so everything renders 20% bigger. Default
	// 100. Empty/0 is treated as 100 by readers.
	ScalePercent int `json:"scale_percent,omitempty" bson:"scale_percent,omitempty"`

	// VariablesEnabled is the per-dashboard on/off gate for the dashboard-variable
	// feature (the header dropdown that re-scopes panels). When false the viewer
	// ignores Variables entirely and behaves as if the feature did not exist.
	// NO omitempty: turning the feature OFF sends `false`, and a partial-settings
	// update must persist that explicit false — omitempty would drop it from the
	// $set, leaving the old `true` in the DB (the "disable didn't stick" bug).
	VariablesEnabled bool `json:"variables_enabled" bson:"variables_enabled"`
	// Variables holds the dashboard-variable definitions. v1 implements a single
	// connection-swap variable (index 0); the array shape is forward-compatible
	// with multiple/filter-value variables. NO omitempty: clearing the variable
	// sends `[]`, and that empty array must overwrite the stored one — omitempty
	// would drop it so the old variables would survive the update.
	Variables []DashboardVariable `json:"variables" bson:"variables"`
}

// DashboardVariable defines a single dashboard-level variable whose value, set
// by a header dropdown, re-scopes panels at view time. The binding Mode decides
// what the value drives. v1 implements connection_swap only; filter_value is a
// designed-but-unbuilt seam.
type DashboardVariable struct {
	Name           string                `json:"name" bson:"name"`   // stable key (fixed token: "dashboard-variable" for connection_swap/filter, "dashboard-range" for range)
	Label          string                `json:"label" bson:"label"` // UI label, e.g. "Site"
	Mode           string                `json:"mode" bson:"mode"`   // "connection_swap" | "filter" | "range"
	ConnectionSwap *ConnectionSwapConfig `json:"connection_swap,omitempty" bson:"connection_swap,omitempty"`
	FilterValue    *FilterValueConfig    `json:"filter_value,omitempty" bson:"filter_value,omitempty"`
	Range          *RangeConfig          `json:"range,omitempty" bson:"range,omitempty"`
}

// Connection-swap selection modes — what the variable's picker selects.
// A string discriminator rather than a boolean so a third mode never needs
// a schema change. See docs/design-notes/multi-connection-swap.md.
const (
	// SwapSelectionConnection: the picker lists candidate CONNECTIONS and
	// selecting one repoints every panel. The original (and default) mode;
	// an empty Selection field means this.
	SwapSelectionConnection = "connection"
	// SwapSelectionTagValue: the picker lists DISTINCT VALUES of the key tag
	// (LabelTagPrefix, required in this mode — it is simultaneously the
	// display label, the dedupe key, and the join key). Each panel resolves
	// its own connection: (its family tags) ∪ {prefix:<selected value>},
	// where the family tags are the variable's Tags for ordinary panels or
	// the panel's ConnectionTags for panels bound to a different family.
	SwapSelectionTagValue = "tag_value"
)

// ConnectionSwapConfig configures a connection_swap variable: the dropdown lists
// connections discovered by tag match (within the dashboard's namespace) and
// selecting one repoints every variable-driven panel's effective connection_id.
type ConnectionSwapConfig struct {
	Tags         []string `json:"tags" bson:"tags"`                   // AND-matched discovery tags: a candidate must carry ALL of them (the Mongo query is OR/$in, then GetVariableCandidates narrows to AND)
	SchemaStrict string   `json:"schema_strict" bson:"schema_strict"` // "type_only" (default) | "superset" | "exact"
	// Selection is what the picker selects: SwapSelectionConnection (default,
	// also when empty) or SwapSelectionTagValue. In tag_value mode the stored
	// selection (and URL param) is the tag VALUE string, not a connection id,
	// and LabelTagPrefix is required.
	Selection string `json:"selection,omitempty" bson:"selection,omitempty"`
	// SameNamespace restricts candidate discovery to the dashboard's own
	// namespace. Default false (cross-namespace by tag), so a dashboard whose
	// source connections live in a different namespace can still find them.
	SameNamespace bool `json:"same_namespace,omitempty" bson:"same_namespace,omitempty"`
	// LabelTagPrefix selects the dropdown label from a prefixed connection tag.
	// When set (e.g. "host"), each candidate's label is the value of its first
	// tag matching "<prefix>:" (so "host:trv-srv-001" → "trv-srv-001"), falling
	// back to the connection name when no matching tag is present. Empty → the
	// dropdown shows the connection name as before. Prefixed tags act as a
	// lightweight key-value store on the connection (convention: one per prefix).
	LabelTagPrefix string `json:"label_tag_prefix,omitempty" bson:"label_tag_prefix,omitempty"`
}

// FilterValueConfig configures a filter_value variable: a value the user picks
// from a header control that is substituted at view time into a component's
// query (server-side, via the `{{dashboard-variable}}` token bound as a SQL
// parameter / escaped EdgeLake literal) or into a client-side filter predicate.
//
// ValueSource decides how the header control sources options:
//   - "static"     → choose from Options (a Dropdown)
//   - "freetext"   → type an arbitrary value (a TextInput/ComboBox)
//   - "connection" → options are DISCOVERED LIVE at view time: the dashboard
//     queries distinct values of the bound column from the connection used by
//     the variable-driven components (column/table derived from the
//     component's query, same as the editor's value picker), via
//     GET /api/connections/:id/variable-values. Options doubles as the
//     fallback list when discovery fails/empty. If the dashboard's
//     variable-driven components span >1 connection, the client uses the first
//     and warns.
//
// v1 enforces at most one filter_value variable per dashboard (the token is a
// single fixed name).
type FilterValueConfig struct {
	ValueSource  string   `json:"value_source,omitempty" bson:"value_source,omitempty"` // "static" (default) | "freetext" | "connection"
	Options      []string `json:"options,omitempty" bson:"options,omitempty"`           // selectable values when ValueSource == "static"; also the seeded fallback list for "connection"
	DefaultValue string   `json:"default_value,omitempty" bson:"default_value,omitempty"`
	// ValueColumn / ValueTable drive ValueSource == "connection": the column
	// (and source table) whose distinct values populate the picker, discovered
	// live against the variable-driven component's connection at view time.
	// Set by the editor's value-picker. Options doubles as the fallback list
	// when the live discovery query fails or times out.
	ValueColumn string `json:"value_column,omitempty" bson:"value_column,omitempty"`
	ValueTable  string `json:"value_table,omitempty" bson:"value_table,omitempty"`
}

// RangeConfig configures a range variable: a [from, to] absolute time window the
// viewer picks in the header, restricting time-series components. The variable's
// active value is canonical absolute instants (RFC3339); relative presets
// ("last 1h") are UI sugar resolved to concrete from/to before apply. The window
// is connection-agnostic — the ONLY per-connection knowledge is the substitution
// FORMAT, declared per-component on ChartQueryConfig.RangeFormat, not here.
//
// Components opt in explicitly: SQL/EdgeLake authors write {{range_from}} /
// {{range_to}} tokens into the query (substituted server-side); ts-store and
// Prometheus panels pick up the window automatically from structured params.
type RangeConfig struct {
	// Presets offered in the header dropdown — relative windows resolved to
	// absolute instants at apply time. Empty → a sensible default set. Stored as
	// duration-ish tokens the CLIENT understands ("1h","6h","24h","7d","30d").
	Presets []string `json:"presets,omitempty" bson:"presets,omitempty"`
	// DefaultPreset is the preset applied on first load when no URL/saved value.
	// Empty → no default (picker shows unset; token components show the
	// "select a range" empty-state).
	DefaultPreset string `json:"default_preset,omitempty" bson:"default_preset,omitempty"`
	// AllowAbsolute toggles the absolute from/to picker. Nil → treated as true.
	AllowAbsolute *bool `json:"allow_absolute,omitempty" bson:"allow_absolute,omitempty"`
	// MinStep is the manual granularity FLOOR for the step dropdown (#277): a
	// duration token like "1m". Steps FINER than this are not offered, because
	// asking for a resolution the data doesn't have draws interpolated or empty
	// buckets between real points — which reads as missing data rather than as
	// an impossible request.
	//
	// The floor is normally INFERRED: ts-store reports a rollup store's window
	// in its store listing, so a 1m-rollup dashboard floors itself with no
	// author action. This field is the override for sources whose cadence is
	// not discoverable — a Prometheus scrape interval, or a raw ts-store
	// store's collection rate — and it WINS over inference when set, since an
	// author who types one knows something the metadata doesn't.
	//
	// Empty → inference only. The client owns the comparison (see
	// resolveMinStepMs in client/src/utils/rangePresets.js); the server just
	// round-trips the token.
	MinStep string `json:"min_step,omitempty" bson:"min_step,omitempty"`
}

// Variable mode constants — the DashboardVariable.Mode discriminator.
const (
	VariableModeConnectionSwap = "connection_swap"
	VariableModeFilter         = "filter"
	VariableModeRange          = "range" // absolute time-window picker
)

// ValidateVariables enforces the v1 invariant that a dashboard carries at most
// one filter-mode variable. The substitution token (`{{dashboard-variable}}`)
// is a single fixed name, so two filter variables would be ambiguous about
// which value to bind. A connection_swap variable and a filter variable MAY
// coexist — they drive different mechanisms (panel connection repointing vs.
// query/filter value substitution) and never collide on the token. Returns nil
// when the variable set is valid.
func ValidateVariables(variables []DashboardVariable) error {
	filterCount, rangeCount := 0, 0
	for i := range variables {
		switch variables[i].Mode {
		case VariableModeFilter:
			filterCount++
		case VariableModeRange:
			rangeCount++
		case VariableModeConnectionSwap:
			cs := variables[i].ConnectionSwap
			if cs == nil {
				continue
			}
			switch cs.Selection {
			case "", SwapSelectionConnection:
				// default mode — no extra requirements
			case SwapSelectionTagValue:
				// The prefix is the join key: without it there is nothing to
				// dedupe the picker on and nothing to resolve families with.
				// Names can't serve either role, so this is a hard requirement
				// of the mode rather than a preference.
				if strings.TrimSpace(cs.LabelTagPrefix) == "" {
					return fmt.Errorf("connection_swap selection %q requires label_tag_prefix: it is the key the picker dedupes on and the tag families join through", SwapSelectionTagValue)
				}
			default:
				return fmt.Errorf("connection_swap selection must be %q or %q (got %q)", SwapSelectionConnection, SwapSelectionTagValue, cs.Selection)
			}
		}
	}
	if filterCount > 1 {
		return fmt.Errorf("a dashboard may define at most one filter variable (found %d); the {{dashboard-variable}} token is a single fixed name", filterCount)
	}
	if rangeCount > 1 {
		return fmt.Errorf("a dashboard may define at most one range variable (found %d); the {{range_from}}/{{range_to}} tokens are single fixed names", rangeCount)
	}
	return nil
}

// VariableCandidate is one selectable option for a connection_swap variable:
// a connection discovered by tag match, annotated with whether it is
// schema-compatible with the dashboard's reference connection.
type VariableCandidate struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Namespace  string `json:"namespace"`
	TypeID     string `json:"type_id"`
	Compatible bool   `json:"compatible"`          // passes the variable's SchemaStrict check
	Reason     string `json:"reason,omitempty"`    // why incompatible (empty when compatible)
	Reference  bool   `json:"reference,omitempty"` // the connection the panels currently use (the baseline)
	// Tags is the connection's tag set, carried so the client can derive a
	// dropdown label from a prefixed tag (see ConnectionSwapConfig.LabelTagPrefix).
	Tags []string `json:"tags,omitempty"`
}

// VariableCandidatesResponse is the payload for the variable-candidates endpoint.
type VariableCandidatesResponse struct {
	Variable   string              `json:"variable"`
	Candidates []VariableCandidate `json:"candidates"`
	// Tag-value mode additions (Selection == SwapSelectionTagValue). Empty in
	// connection mode. Candidates above still lists the PRIMARY family's
	// connections in both modes, so existing clients keep working.
	Selection string         `json:"selection,omitempty"`
	KeyPrefix string         `json:"key_prefix,omitempty"` // the LabelTagPrefix the values were extracted with
	Values    []SwapTagValue `json:"values,omitempty"`     // distinct selectable key values, sorted
	Families  []SwapFamily   `json:"families,omitempty"`   // primary + each distinct panel connection_tags set, with per-value resolution
}

// SwapTagValue is one selectable key value in tag_value mode, annotated with
// how many families resolve for it so the picker can flag partial coverage
// ("trv-srv-003 — 2 of 3 families") and a partial swap is an informed one.
type SwapTagValue struct {
	Value           string `json:"value"`
	FamiliesTotal   int    `json:"families_total"`
	FamiliesMatched int    `json:"families_matched"`
}

// SwapFamily is one connection family: the variable's own Tags (primary) or
// one distinct panel ConnectionTags set. Resolutions map each selectable key
// value to the connection that family resolves to — this single structure
// powers both the viewer's per-panel resolution and the panel-tags modal's
// resolution preview, so the two can't drift.
type SwapFamily struct {
	Tags     []string `json:"tags"`                // normalized family tags
	Primary  bool     `json:"primary,omitempty"`   // true for the variable's own Tags
	PanelIDs []string `json:"panel_ids,omitempty"` // panels bound to this family (override families only)
	// Resolutions holds one entry per key value the family resolves; a value
	// absent here is a no-match for this family (the panel renders its
	// empty state rather than baseline data).
	Resolutions []SwapResolution `json:"resolutions"`
}

// SwapResolution is one family's resolved connection for one key value.
type SwapResolution struct {
	Value          string `json:"value"`
	ConnectionID   string `json:"connection_id"`
	ConnectionName string `json:"connection_name"`
	// Ambiguous flags >1 connection matching (family tags + key:value); the
	// first by name was chosen deterministically. Authoring-time warning
	// material — the config should be fixed, not silently tolerated.
	Ambiguous bool `json:"ambiguous,omitempty"`
}

// PanelSwapIssue reports one variable-driven panel whose (effective) component
// needs columns the target connection doesn't provide — so a connection_swap
// to that connection would render it degraded (e.g. a data table collapsing to
// whatever columns happen to overlap). Detection only; never blocks a swap.
type PanelSwapIssue struct {
	PanelID        string   `json:"panel_id"`
	ComponentID    string   `json:"component_id"`
	ComponentName  string   `json:"component_name"`
	MissingColumns []string `json:"missing_columns"` // required-but-absent, in declaration order
}

// SwapCompatibilityResponse is the payload for the swap-compatibility endpoint:
// per-panel column issues for a specific candidate connection. Empty Issues =
// every panel's required columns are present on that connection.
type SwapCompatibilityResponse struct {
	Variable     string `json:"variable"`
	ConnectionID string `json:"connection_id"`
	// SchemaUnavailable is true when the target connection's schema couldn't be
	// read (idle store, unreachable) — the client should treat issues as
	// "unknown", not "clean", and avoid a false all-clear.
	SchemaUnavailable bool             `json:"schema_unavailable"`
	Issues            []PanelSwapIssue `json:"issues"`
}

// CreateDashboardRequest represents a request to create a dashboard
// @Description Request body for creating a new dashboard
type CreateDashboardRequest struct {
	Namespace   string                 `json:"namespace,omitempty"` // Empty defaults to "default" in the handler.
	Name        string                 `json:"name" binding:"required"`
	Description string                 `json:"description"`
	Panels      []DashboardPanel       `json:"panels"`               // Panels with optional component_id
	Adornments  []DashboardAdornment   `json:"adornments,omitempty"` // Visual decorations drawn over the grid
	Settings    DashboardSettings      `json:"settings"`
	Tags        []string               `json:"tags,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}

// UpdateDashboardRequest represents a request to update a dashboard
// @Description Request body for updating an existing dashboard
type UpdateDashboardRequest struct {
	Namespace   *string                 `json:"namespace,omitempty"` // Omitted = leave current namespace unchanged.
	Name        *string                 `json:"name,omitempty"`
	Description *string                 `json:"description,omitempty"`
	Panels      *[]DashboardPanel       `json:"panels,omitempty"`     // Panels with optional component_id
	Adornments  *[]DashboardAdornment   `json:"adornments,omitempty"` // Nil = leave adornments unchanged
	Settings    *DashboardSettings      `json:"settings,omitempty"`
	Tags        *[]string               `json:"tags,omitempty"`
	Metadata    *map[string]interface{} `json:"metadata,omitempty"`

	// SettingsFields, when non-nil, holds the RAW settings keys the caller
	// actually sent. It drives a PARTIAL settings merge: the repo writes a
	// dotted `settings.<key>` $set for each present key and leaves every
	// omitted field untouched. This is what makes a partial settings update
	// (e.g. just `refresh_interval`) safe — without it, the whole `settings`
	// subdocument is replaced and omitted fields (notably `layout_dimension`)
	// revert to their zero value (#135). Callers that send the full settings
	// object can leave this nil to keep the legacy whole-object replace.
	// Not bound from JSON — populated by the MCP/handler boundary that has
	// the raw request map.
	SettingsFields map[string]interface{} `json:"-"`
}

// DashboardListResponse represents a paginated list of dashboards
// @Description Response containing a list of dashboards with pagination
type DashboardListResponse struct {
	Dashboards []Dashboard `json:"dashboards"`
	Total      int64       `json:"total"`
	Page       int         `json:"page"`
	PageSize   int         `json:"page_size"`
	HasMore    bool        `json:"has_more"` // True when records exist beyond this page
}

// DashboardQueryParams defines query parameters for listing dashboards
// @Description Query parameters for filtering and pagination
type DashboardQueryParams struct {
	Namespace          string   `form:"namespace"` // Empty = all namespaces; non-empty = exact match
	Name               string   `form:"name"`
	IsPublic           *bool    `form:"is_public"`
	ComponentID        string   `form:"component_id"`        // Filter dashboards using a specific component
	ConnectionID       string   `form:"connection_id"`       // Filter dashboards using any component bound to this connection (resolved server-side into ComponentIDs)
	ComponentIDs       []string `form:"-"`                   // Internal: the component-id set a ConnectionID resolved to. Not a query param; populated by the service.
	Tags               []string `form:"tags"`                // Filter dashboards with any of the given tags (OR)
	IncludeConnections bool     `form:"include_connections"` // Include connection names from referenced components
	IDsOnly            bool     `form:"ids_only"`            // Return the full matching set as lightweight nav refs (id + sort fields), ignoring pagination (capped at PageSizeAllCap). For viewer prev/next ordering (#114).
	Sort               string   `form:"sort"`                // Sort field (allowlisted; see DashboardSortFields). Empty = default.
	Direction          string   `form:"direction"`           // "asc" | "desc". Empty = entity default.
	Page               int      `form:"page"`
	PageSize           int      `form:"page_size"` // 0 = all (capped at PageSizeAllCap)
	// Internal (issue #4): the caller's namespace grants, stamped by the
	// service from the authz context — never a query param.
	NamespacesRestricted bool     `form:"-"`
	AllowedNamespaces    []string `form:"-"`
}

// DashboardNavRef is the minimal dashboard shape for viewer navigation
// (#114): just the id plus the fields orderDashboardsForViewer sorts by.
// Returned by GET /api/dashboards?ids_only=true so the viewer's
// prev/next/home can walk the full ordered set without loading full docs.
type DashboardNavRef struct {
	ID        string    `json:"id" bson:"_id"`
	Name      string    `json:"name" bson:"name"`
	Namespace string    `json:"namespace" bson:"namespace"`
	Created   time.Time `json:"created" bson:"created"`
	Updated   time.Time `json:"updated" bson:"updated"`
}

// DashboardNavListResponse is the ids_only=true response shape. Not
// paginated: it always carries the full matching set (capped at
// PageSizeAllCap), in the requested sort order.
type DashboardNavListResponse struct {
	Dashboards []DashboardNavRef `json:"dashboards"`
	Total      int64             `json:"total"`
}

// DashboardSummary is a lightweight dashboard representation for tile listings
// @Description Dashboard info with optional data source names for display in tiles
// NOTE: bson tags are REQUIRED here. This struct is decoded from an
// aggregation that projects snake_case keys (panel_count, connection_names,
// component_usage). Without bson tags the driver maps by lowercased field
// name (panelcount, connectionnames) which silently never matches — the
// fields decode to zero. (That mismatch, combined with the charts→components
// lookup drift, is why panel_count/connection_names were empty pre-#21.)
type DashboardSummary struct {
	ID              string            `json:"id" bson:"id"`
	Namespace       string            `json:"namespace" bson:"namespace"`
	Name            string            `json:"name" bson:"name"`
	Description     string            `json:"description" bson:"description"`
	Settings        DashboardSettings `json:"settings" bson:"settings"`
	Tags            []string          `json:"tags,omitempty" bson:"tags,omitempty"`
	PanelCount      int               `json:"panel_count" bson:"panel_count"`
	ConnectionNames []string          `json:"connection_names,omitempty" bson:"connection_names,omitempty"` // DEPRECATED: names only. Use ConnectionUsage for navigable links. Kept for back-compat.
	// ComponentUsage / ConnectionUsage carry the {id,name} of each distinct
	// component / connection the dashboard's panels reference, so the list
	// page can render navigable popovers + links without a per-tile fetch
	// (#21).
	ComponentUsage  []EntityRef `json:"component_usage,omitempty" bson:"component_usage,omitempty"`
	ConnectionUsage []EntityRef `json:"connection_usage,omitempty" bson:"connection_usage,omitempty"`
	// HasUnauthorizedDeps is set by the service (#4) when at least one
	// referenced component or connection is in a namespace the caller
	// can't see — drives the "unauthorized dependency" warning badge on
	// the list/tile. Computed AFTER redaction; never stored.
	HasUnauthorizedDeps bool      `json:"has_unauthorized_deps,omitempty" bson:"-"`
	Created             time.Time `json:"created" bson:"created"`
	Updated             time.Time `json:"updated" bson:"updated"`
}

// UnauthorizedRef marks a dashboard-referenced component the caller may
// not see (#4). Reason distinguishes the component itself being in an
// ungranted namespace ("component") from a visible component whose
// connection is ungranted ("connection"). Only the id is carried so
// the viewer can map the panel and render an "unauthorized" error
// panel — no name or namespace leaks.
type UnauthorizedRef struct {
	ID     string `json:"id"`
	Reason string `json:"reason"` // "component" | "connection"
}

// DashboardSummaryListResponse represents a paginated list of dashboard summaries
// @Description Response containing dashboard summaries with optional data source info
type DashboardSummaryListResponse struct {
	Dashboards []DashboardSummary `json:"dashboards"`
	Total      int64              `json:"total"`
	Page       int                `json:"page"`
	PageSize   int                `json:"page_size"`
	HasMore    bool               `json:"has_more"` // True when records exist beyond this page
}

// DashboardWithComponents represents a dashboard with expanded component data
// @Description Dashboard with full component objects for rendering
type DashboardWithComponents struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Panels      []DashboardPanel       `json:"panels"`
	Adornments  []DashboardAdornment   `json:"adornments,omitempty"`
	Components  map[string]*Component  `json:"components"` // panel_id -> Component mapping
	Settings    DashboardSettings      `json:"settings"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}
