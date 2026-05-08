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
		Description: "Time-series with horizontal reference bands at fixed Y values — Levey-Jennings / control-chart style. Each band is defined by a name + value + kind (line, dashed tick, or paired box edges that form a shaded band). Four visual styles: time_series (default — line + dots over a horizontal time axis with full-width reference bands), column_filled / column_outlined / column_box (single vertical column per timestamp).",
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
