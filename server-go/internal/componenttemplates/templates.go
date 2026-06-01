// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package componenttemplates holds the React component-skeleton template
// for the CUSTOM chart escape hatch.
//
// Canonical chart types (line, bar, area, pie, scatter, gauge, number,
// dataview, banded_bar) are NOT templated here. They render via the
// client's spec-driven path from saved data_mapping / options config —
// the server emits a one-liner that defers to <SpecDrivenChart> (see
// SpecDrivenOneLiner). An agent configures those types with structured
// fields; it must NOT fetch a template for them and hand-write code,
// which is what produced the hardcoded-column "No data" regression.
//
// The only template that remains is "custom" — the starting point an
// agent (or user) uses when a request genuinely can't be expressed
// through config and the component must drop to use_custom_code=true.
//
// The custom template uses a small set of runtime helpers the viewer
// injects: toObjects(data), getValue(data, col), formatTimestamp(ts,
// format), formatCellValue(value, column). It calls those directly —
// they are not imported.
//
// Both internal/ai (the in-process AI Builder) and internal/mcp (the
// external-agent MCP surface) read from this package so there is one
// source of truth for the skeleton.
package componenttemplates

// Get returns the template for the given chart type. Only "custom" is
// registered today; canonical chart types are spec-driven and have no
// template. Returns ok=false for anything else.
func Get(chartType string) (string, bool) {
	t, ok := templates[chartType]
	return t, ok
}

// GetStyled returns the template for a chart type + style variant. With
// only the "custom" template remaining there are no style variants, so
// this just delegates to Get; the signature is kept so the MCP and AI
// tool handlers don't have to change shape. Returns ok=false when the
// chart type has no template.
func GetStyled(chartType, style string) (string, bool) {
	if style != "" {
		if t, ok := templates[chartType+":"+style]; ok {
			return t, true
		}
	}
	return Get(chartType)
}

// List returns the chart types that have templates, in no guaranteed
// order. Only "custom" today.
func List() []string {
	out := make([]string, 0, len(templates))
	for k := range templates {
		out = append(out, k)
	}
	return out
}

// templates is the registry of React component skeletons, keyed by
// chart_type. Only "custom" remains — see the package doc.
var templates = map[string]string{
	"custom": `// Custom Chart Template
// Use this as a starting point for any ECharts visualization

const Component = ({ data }) => {
  const chartData = toObjects(data);

  if (!chartData.length) {
    return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;
  }

  const option = {
    backgroundColor: 'transparent',

    // Tooltip with dark theme. appendToBody:true is REQUIRED so the
    // tooltip overflows the panel's overflow:hidden — without it,
    // tooltips near panel edges get clipped behind neighbouring panels.
    tooltip: {
      trigger: 'axis', // or 'item' for pie/scatter
      appendToBody: true,
      backgroundColor: '#262626',
      borderColor: '#393939',
      textStyle: { color: '#f4f4f4' }
    },

    // Grid positioning
    grid: { left: 55, right: '2%', bottom: '1.5%', top: 40, containLabel: true },

    // Axis styling
    xAxis: {
      type: 'category', // or 'value', 'time'
      axisLine: { lineStyle: { color: '#525252' } },
      axisLabel: { color: '#c6c6c6' }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#c6c6c6' },
      splitLine: { lineStyle: { color: '#393939' } }
    },

    // Your series configuration
    series: [{
      type: 'line', // bar, pie, scatter, gauge, etc.
      data: chartData.map(d => d.value),
      itemStyle: { color: CARBON_COLORS.primary }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};

/*
Colors — use the injected CARBON_COLORS object, not hardcoded hex.
CARBON_COLORS resolves to the active Carbon theme, so custom charts stay
consistent with the spec-driven charts and survive a theme change:
- CARBON_COLORS.primary    primary blue (default series)
- CARBON_COLORS.secondary  purple (second series / right axis)
- CARBON_COLORS.ok         success green
- CARBON_COLORS.warn       warning yellow
- CARBON_COLORS.danger     error red
- CARBON_COLORS.text       primary text
- CARBON_COLORS.textSecondary  secondary / axis-label text
The structural chrome above (#262626 layer, #393939 borders, #525252
axis lines) are Carbon g100 role tokens; leave them as-is for now.

Available utilities:
- toObjects(data) - Convert columnar data to array of objects
- getValue(data, 'column') - Get single value from first row
- formatTimestamp(ts, 'chart_time') - Format timestamps
- formatCellValue(value, columnName) - Auto-format values

For time-based charts with xAxis type 'time', add this tooltip formatter:
formatter: function(params) {
  if (!params || !params.length) return '';
  const axisVal = params[0].axisValue;
  let header = (typeof axisVal === 'number' && axisVal > 1000000000000)
    ? formatTimestamp(axisVal / 1000, 'chart_datetime')
    : (params[0].axisValueLabel || params[0].name || '');
  let result = header;
  params.forEach(function(p) {
    const val = Array.isArray(p.value) ? p.value[1] : p.value;
    result += '<br/>' + p.marker + ' ' + p.seriesName + ': ' + (val != null ? val : '-');
  });
  return result;
}
*/`,
}
