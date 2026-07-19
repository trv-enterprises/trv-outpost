// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

// Chart type registrations. These must stay in sync with the frontend
// ChartEditor CHART_TYPES and CHART_TYPE_CONFIG arrays in
// client/src/components/ChartEditor.jsx. When adding a new canonical chart
// type:
//
//   1. Add an entry here with its DataRequirements
//   2. Add a matching entry to CHART_TYPES + CHART_TYPE_CONFIG in ChartEditor
//   3. Make sure the frontend can render it (DynamicComponentLoader + ECharts
//      handles most types automatically, but some need library loads)
//
// Anything more exotic than this list can still be built by the AI agent
// via the "custom" type, which maps to the React code path.

func init() {
	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "chart.bar",
		Category:    CategoryChart,
		Subtype:     "bar",
		DisplayName: "Bar Chart",
		Description: "Vertical or horizontal bars for comparing values across categories or time.",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			SupportsStreaming:  true,
			RequiresConnection: true,
		},
		DataRequirements: &DataRequirements{
			RequiresXAxis:   true,
			RequiresYAxis:   true,
			MultipleYAxis:   true,
			HasSeriesColumn: true,
			HasAxisLabels:   true,
			HasXAxisFormat:  true,
			HasTimeBucket:   true,
			HasSortLimit:    true,
			XAxisLabel:      "X-Axis (Categories)",
			YAxisLabel:      "Y-Axis (Values)",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "chart.line",
		Category:    CategoryChart,
		Subtype:     "line",
		DisplayName: "Line Chart",
		Description: "Connected line series over a categorical or time axis. Good for trends.",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			SupportsStreaming:  true,
			RequiresConnection: true,
		},
		DataRequirements: &DataRequirements{
			RequiresXAxis:   true,
			RequiresYAxis:   true,
			MultipleYAxis:   true,
			HasSeriesColumn: true,
			HasAxisLabels:   true,
			HasXAxisFormat:  true,
			HasTimeBucket:   true,
			HasSortLimit:    true,
			XAxisLabel:      "X-Axis (Categories)",
			YAxisLabel:      "Y-Axis (Values)",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "chart.area",
		Category:    CategoryChart,
		Subtype:     "area",
		DisplayName: "Area Chart",
		Description: "Filled line chart — line with the area underneath shaded. Use for cumulative or stacked trends.",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			SupportsStreaming:  true,
			RequiresConnection: true,
		},
		DataRequirements: &DataRequirements{
			RequiresXAxis:   true,
			RequiresYAxis:   true,
			MultipleYAxis:   true,
			HasSeriesColumn: true,
			HasAxisLabels:   true,
			HasXAxisFormat:  true,
			HasTimeBucket:   true,
			HasSortLimit:    true,
			XAxisLabel:      "X-Axis (Categories)",
			YAxisLabel:      "Y-Axis (Values)",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "chart.pie",
		Category:    CategoryChart,
		Subtype:     "pie",
		DisplayName: "Pie Chart",
		Description: "Circular chart showing parts of a whole. One category column, one value column.",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			SupportsStreaming:  true,
			RequiresConnection: true,
		},
		DataRequirements: &DataRequirements{
			RequiresXAxis:  true,
			RequiresYAxis:  true,
			MultipleYAxis:  false,
			HasXAxisFormat: true,
			HasSortLimit:   true,
			XAxisLabel:     "Category Column",
			YAxisLabel:     "Value Column",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "chart.scatter",
		Category:    CategoryChart,
		Subtype:     "scatter",
		DisplayName: "Scatter Plot",
		Description: "Point cloud correlating two numeric columns. Both axes are numeric.",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			SupportsStreaming:  true,
			RequiresConnection: true,
		},
		DataRequirements: &DataRequirements{
			RequiresXAxis: true,
			RequiresYAxis: true,
			MultipleYAxis: false,
			HasAxisLabels: true,
			HasSortLimit:  true,
			XAxisLabel:    "X-Axis (Numeric)",
			YAxisLabel:    "Y-Axis (Numeric)",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "chart.gauge",
		Category:    CategoryChart,
		Subtype:     "gauge",
		DisplayName: "Gauge",
		Description: "Single-value dial. Binds a single numeric value, typically the latest reading.",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			SupportsStreaming:  true,
			RequiresConnection: true,
		},
		DataRequirements: &DataRequirements{
			RequiresYAxis: true,
			MultipleYAxis: false,
			HasTimeBucket: true,
			YAxisLabel:    "Value Column",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "chart.number",
		Category:    CategoryChart,
		Subtype:     "number",
		DisplayName: "Number",
		Description: "Single value rendered as a large number with an optional unit suffix. Binds one numeric column, typically the latest reading.",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			SupportsStreaming:  true,
			RequiresConnection: true,
		},
		DataRequirements: &DataRequirements{
			RequiresYAxis: true,
			MultipleYAxis: false,
			HasTimeBucket: true,
			YAxisLabel:    "Value Column",
		},
		// Options (set via the component's `options` object). The format
		// IMPLIES the raw value's unit — map a RAW column and pick a format
		// rather than doing unit math in the query or writing custom code.
		ConfigSchema: []ConfigField{
			{Name: "numberFormat", Type: "select", Required: false, Default: "auto", Options: []string{"auto", "plain", "compact", "duration", "duration_clock", "datetime"}, Description: "Value format. \"auto\" (source precision), \"plain\" (1,234.5), \"compact\" (1.2M/3.4K — use for large magnitudes), \"duration\" (raw value is SECONDS → \"2d 3h 4m\", e.g. uptime.sec), \"duration_clock\" (seconds → HH:MM:SS), \"datetime\" (raw value is a timestamp → date/time via numberDateFormat). Pick the format instead of dividing in custom code."},
			{Name: "numberDateFormat", Type: "select", Required: false, Default: "datetime", Options: []string{"date", "time", "time_seconds", "datetime", "datetime_seconds"}, Description: "Date/time style when numberFormat=\"datetime\". Ignored otherwise."},
			{Name: "numberDecimals", Type: "select", Required: false, Default: "auto", Options: []string{"auto", "0", "1", "2", "3", "4"}, Description: "Decimal places, or \"auto\"."},
			{Name: "numberUnit", Type: "string", Required: false, Description: "Unit suffix appended after the value (e.g. \"%\", \"°C\", \"GB\"). Cosmetic — does not scale the value."},
			{Name: "numberSize", Type: "string", Required: false, Default: "56", Description: "Value font size in px (12–400). Size it to the panel height so the value doesn't overflow."},
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "chart.dataview",
		Category:    CategoryChart,
		Subtype:     "dataview",
		DisplayName: "Data Table",
		Description: "Carbon DataTable rendering raw query results. Not an ECharts chart — use for tabular views.",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			SupportsStreaming:  true,
			RequiresConnection: true,
		},
		DataRequirements: &DataRequirements{
			HasSortLimit:      true,
			HasVisibleColumns: true,
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "chart.banded_bar",
		Category:    CategoryChart,
		Subtype:     "banded_bar",
		DisplayName: "Banded Bar Chart",
		Description: "Time-series with a center line plus a PER-ROW shaded band whose edges come from the DATA (not fixed thresholds) — control-chart / Levey-Jennings style. Set data_mapping.band_columns to map each row's own columns to band roles; pick a scheme: 'sd' (center=mean + ±1/±2 SD columns), 'minmaxmean' (center=mean + min/max columns — use this for a min↔max envelope around an average), or 'spc' (center=target + lower/upper control + lower/upper limit columns). Each row carries its own band values, so the band tracks the data over time rather than sitting at a constant Y. Use this instead of hand-written custom code whenever the user wants a min/max (or ±SD, or control-limit) band around a series. Four visual styles: time_series (default — line + dots with the shaded band over a time axis), column_filled / column_outlined / column_box (single vertical column per timestamp).",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			SupportsStreaming:  true,
			RequiresConnection: true,
		},
		DataRequirements: &DataRequirements{
			RequiresXAxis:      true,
			RequiresYAxis:      true,
			MultipleYAxis:      false,
			HasSeriesColumn:    true,
			HasAxisLabels:      true,
			HasXAxisFormat:     true,
			HasTimeBucket:      true,
			HasSortLimit:       true,
			HasReferenceLevels: true,
			XAxisLabel:         "X-Axis (Time)",
			YAxisLabel:         "Y-Axis (Value)",
		},
	})

	RegisterComponentType(ComponentTypeInfo{
		TypeID:      "chart.custom",
		Category:    CategoryChart,
		Subtype:     "custom",
		DisplayName: "Custom Component",
		Description: "Escape hatch for anything outside the canonical chart types — user or AI provides React component code that renders ECharts or any other library bundled with the dashboard client.",
		Capabilities: ComponentCapabilities{
			CanRead:            true,
			SupportsStreaming:  true,
			RequiresConnection: true,
		},
		DataRequirements: &DataRequirements{
			RequiresXAxis:   true,
			RequiresYAxis:   true,
			MultipleYAxis:   true,
			HasSeriesColumn: true,
			HasAxisLabels:   true,
			HasXAxisFormat:  true,
			HasTimeBucket:   true,
			HasSortLimit:    true,
			XAxisLabel:      "X-Axis",
			YAxisLabel:      "Y-Axis",
		},
	})
}
