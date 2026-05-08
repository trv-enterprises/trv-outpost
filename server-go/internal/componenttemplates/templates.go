// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package componenttemplates holds the React component-skeleton
// templates for each chart type. Templates are the scaffolding the
// AI-assisted authoring flow starts from: an agent fetches the raw
// template, fills in real column names based on the discovered data
// schema, and writes the result as the component's source code.
//
// Templates use a small set of runtime helpers the viewer injects:
// toObjects(data), getValue(data, col), formatTimestamp(ts, format),
// formatCellValue(value, column). Templates call those directly —
// they are not imported.
//
// Both internal/ai (the in-process AI Builder) and internal/mcp (the
// external-agent MCP surface) read from this package so there is
// one source of truth for the skeletons.
package componenttemplates

// Get returns the template for the given chart type. Returns ok=false
// if the chart type has no registered template.
func Get(chartType string) (string, bool) {
	t, ok := templates[chartType]
	return t, ok
}

// GetStyled returns the template for a chart type + style variant. Today
// only banded_bar has style variants — the four ECharts visual treatments
// of a Levey-Jennings reference-band chart (time_series default,
// column_filled, column_outlined, column_box). The style key is looked up
// as "<chartType>:<style>"; if missing or empty the base chartType key
// applies. Returns ok=false when neither key resolves.
func GetStyled(chartType, style string) (string, bool) {
	if style != "" {
		if t, ok := templates[chartType+":"+style]; ok {
			return t, true
		}
	}
	return Get(chartType)
}

// List returns the chart types that have templates, in no guaranteed
// order. Useful for agent prompts listing the available skeletons.
func List() []string {
	out := make([]string, 0, len(templates))
	for k := range templates {
		out = append(out, k)
	}
	return out
}

// Banded-bar templates broken out as package-level vars so the
// templates map can reference them without violating the "map literals
// can't call functions" Go rule. All four share the per-row data
// contract documented at the bandedBarTimeSeriesTpl declaration.

var bandedBarTimeSeriesTpl = `// Banded Bar Chart — time_series style (per-row envelope)
// Horizontal time x-axis with line + dots; the reference bands move
// with the data — each row carries its own mean + ±1 SD + ±2 SD
// columns, and the bands are rendered as a shaded envelope behind
// the line via ECharts' stacked areaStyle technique.
//
// DATA CONTRACT (every row must carry these columns):
//   day / timestamp — the x-axis value (rename via xCol below)
//   mean            — the primary value (rename via meanCol below)
//   minus_2sd, minus_1sd, plus_1sd, plus_2sd — that row's bounds
// Substitute the actual column names from get_schema before saving.

const Component = ({ data, config }) => {
  if (!data?.rows?.length) return <div style={{color: '#c6c6c6', padding: 16}}>Waiting for data…</div>;

  // Substitute these with the columns from your schema.
  const xCol     = 'day';
  const meanCol  = 'mean';
  const m2Col    = 'minus_2sd';
  const m1Col    = 'minus_1sd';
  const p1Col    = 'plus_1sd';
  const p2Col    = 'plus_2sd';

  const rows     = toObjects(data);
  const xLabels  = rows.map(r => formatTimestamp(r[xCol], 'chart_time'));
  const meanVals = rows.map(r => +parseFloat(r[meanCol]));
  const m2sd     = rows.map(r => +parseFloat(r[m2Col]));
  const m1sd     = rows.map(r => +parseFloat(r[m1Col]));
  const p1sd     = rows.map(r => +parseFloat(r[p1Col]));
  const p2sd     = rows.map(r => +parseFloat(r[p2Col]));

  // Stacked-band trick: a transparent base series at m2sd plus three
  // width-of-band stacks. Each stack is m1-m2 / p1-m1 / p2-p1 wide,
  // colored to fill the gap between the bounds. ECharts paints them
  // bottom-up so the fills shade the right region.
  const wOuterLo = rows.map((_, i) => +(m1sd[i] - m2sd[i]).toFixed(4));
  const wInner   = rows.map((_, i) => +(p1sd[i] - m1sd[i]).toFixed(4));
  const wOuterHi = rows.map((_, i) => +(p2sd[i] - p1sd[i]).toFixed(4));

  const option = {
    backgroundColor: 'transparent',
    title: { text: config?.title || '', left: 'center', top: 5, textStyle: { color: '#f4f4f4' } },
    tooltip: {
      trigger: 'axis', appendToBody: true,
      backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' },
      formatter: params => {
        const i = params[0]?.dataIndex;
        if (i == null) return '';
        return [
          '<b>' + xLabels[i] + '</b>',
          'Mean: ' + meanVals[i].toFixed(3),
          '±1 SD: ' + m1sd[i].toFixed(3) + ' / ' + p1sd[i].toFixed(3),
          '±2 SD: ' + m2sd[i].toFixed(3) + ' / ' + p2sd[i].toFixed(3),
        ].join('<br/>');
      },
    },
    legend: { bottom: 6, textStyle: { color: '#c6c6c6' }, data: ['Mean', '±1 SD', '±2 SD'] },
    grid: { left: 50, right: 20, top: 50, bottom: 40, containLabel: true },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } } },
    yAxis: { type: 'value', axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } }, splitLine: { lineStyle: { color: '#262626' } } },
    series: [
      // Transparent base — starts the stack at m2sd
      { name: '_base', type: 'line', stack: 'band', data: m2sd, symbol: 'none',
        lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true, tooltip: { show: false }, showInLegend: false },
      // Outer-low band: m2 → m1
      { name: '±2 SD', type: 'line', stack: 'band', data: wOuterLo, symbol: 'none',
        lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(190, 149, 255, 0.18)' } },
      // Inner band: m1 → p1
      { name: '±1 SD', type: 'line', stack: 'band', data: wInner, symbol: 'none',
        lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(8, 189, 186, 0.22)' } },
      // Outer-high band: p1 → p2 (re-uses the ±2 SD legend entry)
      { name: '±2 SD', type: 'line', stack: 'band', data: wOuterHi, symbol: 'none',
        lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(190, 149, 255, 0.18)' }, showInLegend: false },
      // Mean line + dots — rendered on top, NOT stacked
      { name: 'Mean', type: 'line', data: meanVals, symbol: 'circle', symbolSize: 6,
        lineStyle: { color: '#0f62fe', width: 2 }, itemStyle: { color: '#0f62fe' } },
    ],
  };
  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`

var bandedBarColumnFilledTpl = `// Banded Bar Chart — column_filled style (per-row)
// One vertical column per row. Each column shows that row's bands
// as filled rectangles (no borders): outer ±2 SD shaded, inner
// ±1 SD shaded a different tone, dot at the row's mean.
//
// Snapshot-style display where each timestamp reads independently —
// the columns are visually separate, not connected by a trend line.
// For multi-day trend rendering use time_series instead.
//
// Same per-row data contract as the time_series template — every
// row needs mean + minus_2sd + minus_1sd + plus_1sd + plus_2sd.

const Component = ({ data, config }) => {
  if (!data?.rows?.length) return <div style={{color: '#c6c6c6', padding: 16}}>Waiting for data…</div>;

  const xCol = 'day', meanCol = 'mean';
  const m2Col = 'minus_2sd', m1Col = 'minus_1sd', p1Col = 'plus_1sd', p2Col = 'plus_2sd';

  const rows     = toObjects(data);
  const xLabels  = rows.map(r => formatTimestamp(r[xCol], 'chart_time'));
  const meanVals = rows.map(r => +parseFloat(r[meanCol]));
  const m2sd     = rows.map(r => +parseFloat(r[m2Col]));
  const m1sd     = rows.map(r => +parseFloat(r[m1Col]));
  const p1sd     = rows.map(r => +parseFloat(r[p1Col]));
  const p2sd     = rows.map(r => +parseFloat(r[p2Col]));

  // Per-row rectangles drawn via a custom series. Each rectangle is
  // half a category wide centered on the timestamp's index.
  const COL_HALF = 0.35;

  const drawRect = (api, i, lo, hi, fill, stroke, strokeW) => {
    const xLeft  = api.coord([i - COL_HALF, lo])[0];
    const xRight = api.coord([i + COL_HALF, lo])[0];
    const yLo    = api.coord([i, lo])[1];
    const yHi    = api.coord([i, hi])[1];
    return { type: 'rect',
      shape: { x: xLeft, y: yHi, width: xRight - xLeft, height: yLo - yHi },
      style: { fill, stroke, lineWidth: strokeW || 0 } };
  };

  const option = {
    backgroundColor: 'transparent',
    title: { text: config?.title || '', left: 'center', top: 5, textStyle: { color: '#f4f4f4' } },
    tooltip: {
      trigger: 'axis', appendToBody: true,
      backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' },
      formatter: params => {
        const i = params[0]?.dataIndex;
        if (i == null) return '';
        return [
          '<b>' + xLabels[i] + '</b>',
          'Mean: ' + meanVals[i].toFixed(3),
          '±1 SD: ' + m1sd[i].toFixed(3) + ' / ' + p1sd[i].toFixed(3),
          '±2 SD: ' + m2sd[i].toFixed(3) + ' / ' + p2sd[i].toFixed(3),
        ].join('<br/>');
      },
    },
    grid: { left: 50, right: 20, top: 50, bottom: 30, containLabel: true },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } } },
    yAxis: { type: 'value', axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } }, splitLine: { lineStyle: { color: '#262626' } } },
    series: [
      // Outer ±2 SD rectangles
      { type: 'custom', renderItem: (params, api) => {
        const i = api.value(0);
        return drawRect(api, i, m2sd[i], p2sd[i], 'rgba(190, 149, 255, 0.18)', null, 0);
      }, encode: { x: 0, y: [1, 2] }, data: rows.map((_, i) => [i, m2sd[i], p2sd[i]]) },
      // Inner ±1 SD rectangles (drawn over the outer)
      { type: 'custom', renderItem: (params, api) => {
        const i = api.value(0);
        return drawRect(api, i, m1sd[i], p1sd[i], 'rgba(8, 189, 186, 0.30)', null, 0);
      }, encode: { x: 0, y: [1, 2] }, data: rows.map((_, i) => [i, m1sd[i], p1sd[i]]) },
      // Mean dot per row (used by axis tooltip)
      { type: 'scatter', data: meanVals, symbolSize: 12, itemStyle: { color: '#0f62fe' } },
    ],
  };
  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`

var bandedBarColumnOutlinedTpl = `// Banded Bar Chart — column_outlined style (per-row)
// Same as column_filled but each per-row rectangle has a visible
// stroke. Reads as discrete band regions rather than smooth fills.
// Same per-row data contract.

const Component = ({ data, config }) => {
  if (!data?.rows?.length) return <div style={{color: '#c6c6c6', padding: 16}}>Waiting for data…</div>;

  const xCol = 'day', meanCol = 'mean';
  const m2Col = 'minus_2sd', m1Col = 'minus_1sd', p1Col = 'plus_1sd', p2Col = 'plus_2sd';

  const rows     = toObjects(data);
  const xLabels  = rows.map(r => formatTimestamp(r[xCol], 'chart_time'));
  const meanVals = rows.map(r => +parseFloat(r[meanCol]));
  const m2sd     = rows.map(r => +parseFloat(r[m2Col]));
  const m1sd     = rows.map(r => +parseFloat(r[m1Col]));
  const p1sd     = rows.map(r => +parseFloat(r[p1Col]));
  const p2sd     = rows.map(r => +parseFloat(r[p2Col]));

  const COL_HALF = 0.35;
  const drawRect = (api, i, lo, hi, fill, stroke, strokeW) => {
    const xLeft  = api.coord([i - COL_HALF, lo])[0];
    const xRight = api.coord([i + COL_HALF, lo])[0];
    const yLo    = api.coord([i, lo])[1];
    const yHi    = api.coord([i, hi])[1];
    return { type: 'rect',
      shape: { x: xLeft, y: yHi, width: xRight - xLeft, height: yLo - yHi },
      style: { fill, stroke, lineWidth: strokeW || 0 } };
  };

  const option = {
    backgroundColor: 'transparent',
    title: { text: config?.title || '', left: 'center', top: 5, textStyle: { color: '#f4f4f4' } },
    tooltip: {
      trigger: 'axis', appendToBody: true,
      backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' },
      formatter: params => {
        const i = params[0]?.dataIndex;
        if (i == null) return '';
        return [
          '<b>' + xLabels[i] + '</b>',
          'Mean: ' + meanVals[i].toFixed(3),
          '±1 SD: ' + m1sd[i].toFixed(3) + ' / ' + p1sd[i].toFixed(3),
          '±2 SD: ' + m2sd[i].toFixed(3) + ' / ' + p2sd[i].toFixed(3),
        ].join('<br/>');
      },
    },
    grid: { left: 50, right: 20, top: 50, bottom: 30, containLabel: true },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } } },
    yAxis: { type: 'value', axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } }, splitLine: { lineStyle: { color: '#262626' } } },
    series: [
      { type: 'custom', renderItem: (params, api) => {
        const i = api.value(0);
        return drawRect(api, i, m2sd[i], p2sd[i], 'rgba(190, 149, 255, 0.12)', '#be95ff', 1);
      }, encode: { x: 0, y: [1, 2] }, data: rows.map((_, i) => [i, m2sd[i], p2sd[i]]) },
      { type: 'custom', renderItem: (params, api) => {
        const i = api.value(0);
        return drawRect(api, i, m1sd[i], p1sd[i], 'rgba(8, 189, 186, 0.20)', '#08bdba', 1);
      }, encode: { x: 0, y: [1, 2] }, data: rows.map((_, i) => [i, m1sd[i], p1sd[i]]) },
      { type: 'scatter', data: meanVals, symbolSize: 12, itemStyle: { color: '#0f62fe' } },
    ],
  };
  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`

var bandedBarColumnBoxTpl = `// Banded Bar Chart — column_box style (per-row)
// Only the inner ±1 SD band drawn (with border); the ±2 SD band is
// suppressed. Each row's data point shows as a vertical line spanning
// the chart height with a horizontal tick mark at the mean — a
// box-plot-ish glyph that reads "is this reading inside the inner
// control band?"
// Same per-row data contract.

const Component = ({ data, config }) => {
  if (!data?.rows?.length) return <div style={{color: '#c6c6c6', padding: 16}}>Waiting for data…</div>;

  const xCol = 'day', meanCol = 'mean';
  const m1Col = 'minus_1sd', p1Col = 'plus_1sd';

  const rows     = toObjects(data);
  const xLabels  = rows.map(r => formatTimestamp(r[xCol], 'chart_time'));
  const meanVals = rows.map(r => +parseFloat(r[meanCol]));
  const m1sd     = rows.map(r => +parseFloat(r[m1Col]));
  const p1sd     = rows.map(r => +parseFloat(r[p1Col]));

  const COL_HALF = 0.35;

  const option = {
    backgroundColor: 'transparent',
    title: { text: config?.title || '', left: 'center', top: 5, textStyle: { color: '#f4f4f4' } },
    tooltip: {
      trigger: 'axis', appendToBody: true,
      backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' },
      formatter: params => {
        const i = params[0]?.dataIndex;
        if (i == null) return '';
        return [
          '<b>' + xLabels[i] + '</b>',
          'Mean: ' + meanVals[i].toFixed(3),
          '±1 SD: ' + m1sd[i].toFixed(3) + ' / ' + p1sd[i].toFixed(3),
        ].join('<br/>');
      },
    },
    grid: { left: 50, right: 20, top: 50, bottom: 30, containLabel: true },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } } },
    yAxis: { type: 'value', axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } }, splitLine: { lineStyle: { color: '#262626' } } },
    series: [
      // Inner ±1 SD rectangle, with border
      { type: 'custom', renderItem: (params, api) => {
        const i = api.value(0);
        const xLeft  = api.coord([i - COL_HALF, m1sd[i]])[0];
        const xRight = api.coord([i + COL_HALF, m1sd[i]])[0];
        const yLo    = api.coord([i, m1sd[i]])[1];
        const yHi    = api.coord([i, p1sd[i]])[1];
        return { type: 'rect',
          shape: { x: xLeft, y: yHi, width: xRight - xLeft, height: yLo - yHi },
          style: { fill: 'rgba(8, 189, 186, 0.18)', stroke: '#08bdba', lineWidth: 1 } };
      }, encode: { x: 0, y: [1, 2] }, data: rows.map((_, i) => [i, m1sd[i], p1sd[i]]) },
      // Vertical line spanning the column + tick at mean
      { type: 'custom', renderItem: (params, api) => {
        const i = api.value(0);
        const x = api.coord([i, 0])[0];
        const yMean = api.coord([i, meanVals[i]])[1];
        const yTop = params.coordSys.y;
        const yBot = params.coordSys.y + params.coordSys.height;
        return { type: 'group', children: [
          { type: 'line', shape: { x1: x, y1: yTop, x2: x, y2: yBot }, style: { stroke: '#f4f4f4', lineWidth: 1 } },
          { type: 'line', shape: { x1: x - 8, y1: yMean, x2: x + 8, y2: yMean }, style: { stroke: '#f4f4f4', lineWidth: 2 } },
        ] };
      }, encode: { x: 0, y: 1 }, data: rows.map((_, i) => [i, meanVals[i]]) },
    ],
  };
  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`

// templates is the registry of React component skeletons, keyed by chart_type.
var templates = map[string]string{
	"line": `const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      backgroundColor: '#262626',
      borderColor: '#393939',
      textStyle: { color: '#f4f4f4' },
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
    },
    grid: { left: 55, right: '2%', bottom: '1.5%', top: 40, containLabel: true },
    xAxis: {
      type: 'category',
      data: chartData.map(d => formatTimestamp(d.timestamp, 'chart_time')),
      axisLine: { lineStyle: { color: '#525252' } },
      axisLabel: { color: '#c6c6c6' }
    },
    yAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: '#525252' } },
      axisLabel: { color: '#c6c6c6' },
      splitLine: { lineStyle: { color: '#393939' } }
    },
    series: [{
      data: chartData.map(d => d.value),
      type: 'line',
      smooth: true,
      itemStyle: { color: '#0f62fe' }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`,

	"bar": `const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', appendToBody: true, backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' } },
    grid: { left: 55, right: '2%', bottom: '1.5%', top: 40, containLabel: true },
    xAxis: {
      type: 'category',
      data: chartData.map(d => d.category || d.name || d.label),
      axisLabel: { color: '#c6c6c6' }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#c6c6c6' },
      splitLine: { lineStyle: { color: '#393939' } }
    },
    series: [{
      data: chartData.map(d => d.value),
      type: 'bar',
      itemStyle: { color: '#0f62fe' }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`,

	"area": `const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      backgroundColor: '#262626',
      borderColor: '#393939',
      textStyle: { color: '#f4f4f4' }
    },
    grid: { left: 55, right: '2%', bottom: '1.5%', top: 40, containLabel: true },
    xAxis: {
      type: 'category',
      data: chartData.map(d => formatTimestamp(d.timestamp, 'chart_time')),
      axisLine: { lineStyle: { color: '#525252' } },
      axisLabel: { color: '#c6c6c6' }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#c6c6c6' },
      splitLine: { lineStyle: { color: '#393939' } }
    },
    series: [{
      data: chartData.map(d => d.value),
      type: 'line',
      smooth: true,
      itemStyle: { color: '#0f62fe' },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(15, 98, 254, 0.3)' },
            { offset: 1, color: 'rgba(15, 98, 254, 0)' }
          ]
        }
      }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`,

	"pie": `const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', appendToBody: true, backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' } },
    legend: { top: '5%', left: 'center', textStyle: { color: '#c6c6c6' } },
    series: [{
      type: 'pie',
      radius: '60%',
      center: ['50%', '55%'],
      data: chartData.map(d => ({ name: d.name || d.category || d.label, value: d.value })),
      label: { color: '#c6c6c6' },
      itemStyle: { borderColor: '#161616', borderWidth: 2 }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`,

	"scatter": `const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', appendToBody: true, backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' } },
    grid: { left: 55, right: '2%', bottom: '1.5%', top: 40, containLabel: true },
    xAxis: {
      type: 'value',
      axisLabel: { color: '#c6c6c6' },
      splitLine: { lineStyle: { color: '#393939' } }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#c6c6c6' },
      splitLine: { lineStyle: { color: '#393939' } }
    },
    series: [{
      type: 'scatter',
      data: chartData.map(d => [d.x, d.y]),
      itemStyle: { color: '#0f62fe' }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`,

	"number": `const Component = ({ data, config }) => {
  // Title comes from the saved component record (config.title) so renames
  // in the editor flow through automatically. Don't hard-code it here.
  const title = config?.title || '';
  // Configuration - customize these values
  const units = 'units';           // Replace with your units (e.g., 'ms', '°F', 'req/s')
  const valueColumn = null;        // Set to column name, or null to auto-detect first numeric column

  // Auto-detect value column if not specified
  const getValueColumn = () => {
    if (valueColumn) return valueColumn;
    if (!data || !data.columns || !data.rows || !data.rows.length) return null;
    
    // Find first column with a numeric value
    for (let i = 0; i < data.columns.length; i++) {
      const val = data.rows[0][i];
      if (typeof val === 'number') {
        return data.columns[i];
      }
    }
    // Fall back to first column
    return data.columns[0];
  };

  const effectiveColumn = getValueColumn();
  const rawValue = effectiveColumn ? getValue(data, effectiveColumn) : 0;

  // Format the number for display
  const formatNumber = (num) => {
    if (num == null) return '--';
    if (typeof num !== 'number') return String(num);

    // Format large numbers with abbreviations to fit 6 chars
    if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(1) + 'B';
    if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(1) + 'K';

    // Format decimal numbers
    if (num % 1 !== 0) return num.toFixed(2);

    return num.toLocaleString();
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      height: '100%',
      width: '100%',
      padding: '16px',
      paddingTop: '8px',
      backgroundColor: 'transparent',
      color: '#f4f4f4'
    }}>
      {/* Title - at top, primary text color */}
      <div style={{
        fontSize: '0.875rem',
        fontWeight: '600',
        color: '#f4f4f4',
        textAlign: 'center',
        marginBottom: 'auto'
      }}>
        {title}
      </div>

      {/* Value - centered, sized for 6 characters */}
      <div style={{
        fontSize: 'clamp(2.5rem, 10vw, 5rem)',
        fontWeight: '300',
        lineHeight: 1,
        color: '#0f62fe',
        textAlign: 'center',
        fontFamily: 'IBM Plex Mono, monospace'
      }}>
        {formatNumber(rawValue)}
      </div>

      {/* Units - at bottom, larger text */}
      <div style={{
        fontSize: '1.125rem',
        fontWeight: '400',
        color: '#f4f4f4',
        textAlign: 'center',
        marginTop: 'auto',
        marginBottom: '8px'
      }}>
        {units}
      </div>
    </div>
  );
};`,

	"gauge": `const Component = ({ data }) => {
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 200, height: 200 });

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setContainerSize(prev => {
        if (Math.abs(prev.width - width) > 1 || Math.abs(prev.height - height) > 1) {
          return { width, height };
        }
        return prev;
      });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const value = getValue(data, 'value') || 0;
  const minDim = Math.min(containerSize.width, containerSize.height);
  const baseFontSize = Math.floor(minDim * 0.12);
  const labelFontSize = Math.floor(minDim * 0.06);
  const axisLineWidth = Math.floor(minDim * 0.08);

  const option = {
    backgroundColor: 'transparent',
    series: [{
      type: 'gauge',
      min: 0,
      max: 100,
      center: ['50%', '55%'],
      radius: '85%',
      progress: { show: false },
      detail: { formatter: '{value}%', color: '#f4f4f4', fontSize: baseFontSize, offsetCenter: [0, '70%'] },
      data: [{ value: Number(value).toFixed(1) }],
      title: { show: false },
      axisLine: {
        lineStyle: {
          width: axisLineWidth,
          color: [[0.7, '#24a148'], [0.9, '#f1c21b'], [1, '#da1e28']]
        }
      },
      axisLabel: { color: '#999', fontSize: labelFontSize },
      axisTick: { show: false },
      pointer: { itemStyle: { color: '#f4f4f4' } }
    }]
  };

  return (
    <div ref={containerRef} style={{ height: '100%', width: '100%' }}>
      <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />
    </div>
  );
};`,

	"heatmap": `const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  // Extract unique x and y values
  const xLabels = [...new Set(chartData.map(d => d.x))];
  const yLabels = [...new Set(chartData.map(d => d.y))];
  const heatmapData = chartData.map(d => [xLabels.indexOf(d.x), yLabels.indexOf(d.y), d.value]);

  const option = {
    backgroundColor: 'transparent',
    tooltip: { appendToBody: true, backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' } },
    grid: { left: 80, right: 80, bottom: 40, top: 40 },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: '#c6c6c6' } },
    yAxis: { type: 'category', data: yLabels, axisLabel: { color: '#c6c6c6' } },
    visualMap: {
      min: Math.min(...chartData.map(d => d.value)),
      max: Math.max(...chartData.map(d => d.value)),
      calculable: true,
      orient: 'vertical',
      right: 10,
      top: 'center',
      textStyle: { color: '#c6c6c6' },
      inRange: { color: ['#161616', '#0f62fe'] }
    },
    series: [{
      type: 'heatmap',
      data: heatmapData,
      label: { show: true, color: '#f4f4f4' }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`,

	"radar": `const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  // Expect data with 'indicator' and 'value' columns, or multiple value columns
  const indicators = chartData.map(d => ({ name: d.name || d.indicator, max: 100 }));
  const values = chartData.map(d => d.value);

  const option = {
    backgroundColor: 'transparent',
    tooltip: { appendToBody: true, backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' } },
    radar: {
      indicator: indicators,
      axisName: { color: '#c6c6c6' },
      splitLine: { lineStyle: { color: '#393939' } },
      splitArea: { areaStyle: { color: ['transparent', 'rgba(57, 57, 57, 0.2)'] } }
    },
    series: [{
      type: 'radar',
      data: [{ value: values, name: 'Values' }],
      itemStyle: { color: '#0f62fe' },
      areaStyle: { color: 'rgba(15, 98, 254, 0.3)' }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`,

	"funnel": `const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', appendToBody: true, backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' } },
    legend: { top: '5%', left: 'center', textStyle: { color: '#c6c6c6' } },
    series: [{
      type: 'funnel',
      left: '10%',
      width: '80%',
      top: 60,
      bottom: 20,
      data: chartData.map(d => ({ name: d.name || d.stage, value: d.value })),
      label: { color: '#f4f4f4' },
      itemStyle: { borderColor: '#161616', borderWidth: 2 }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`,

	"dataview": `const Component = ({ data }) => {
  const chartData = toObjects(data);

  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  const columns = Object.keys(chartData[0] || {});

  const headers = columns.map(col => ({
    key: col,
    header: col.charAt(0).toUpperCase() + col.slice(1).replace(/_/g, ' ')
  }));

  const rows = chartData.map((row, idx) => ({ id: String(idx), ...row }));

  return (
    <div style={{ height: '100%', width: '100%', overflow: 'auto' }}>
      <DataTable rows={rows} headers={headers} size="sm">
        {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
          <Table {...getTableProps()}>
            <TableHead>
              <TableRow>
                {headers.map(header => (
                  <TableHeader {...getHeaderProps({ header })} key={header.key}>
                    {header.header}
                  </TableHeader>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(row => (
                <TableRow {...getRowProps({ row })} key={row.id}>
                  {row.cells.map(cell => (
                    <TableCell key={cell.id}>{formatCellValue(cell.value, cell.info.header)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataTable>
    </div>
  );
};`,

	// Banded-bar templates — Levey-Jennings / control chart variants.
	//
	// **Universal data assumption (per-row).** Every row in the data
	// stream carries all the columns needed to draw that row's bands:
	//   - mean   — the primary value (often the daily mean)
	//   - minus_2sd, minus_1sd, plus_1sd, plus_2sd — that row's bounds
	// The bands move with the data: each row's bounds rise/fall with
	// its own mean and widen/narrow with its own SD. Fixed-scalar
	// reference levels are NOT supported by these templates — drop
	// them from the source query if you have them.
	//
	// Four visual styles share the same per-row contract:
	//   - time_series  — line + dots over a horizontal time x-axis,
	//                    bands rendered as a shaded envelope behind
	//                    the line via stacked areaStyle
	//   - column_filled — single vertical column per timestamp,
	//                     filled bands (no borders), dot at value
	//   - column_outlined — same but with band borders
	//   - column_box   — only the ±1 SD band drawn (with border),
	//                    vertical line + tick at value (boxplot-ish)
	//
	// Each style key returns a working component scoped to that
	// variant — fetch via get_component_template({chart_type:
	// "banded_bar", style:"<one of above>"}).

	"banded_bar":                bandedBarTimeSeriesTpl,
	"banded_bar:time_series":    bandedBarTimeSeriesTpl,
	"banded_bar:column_filled":  bandedBarColumnFilledTpl,
	"banded_bar:column_outlined": bandedBarColumnOutlinedTpl,
	"banded_bar:column_box":     bandedBarColumnBoxTpl,

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
      itemStyle: { color: '#0f62fe' }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};

/*
Carbon g100 Color Reference:
- Background: transparent (container provides #161616)
- Layer 01: #262626 (tooltips, cards)
- Layer 02: #393939 (borders, grid lines)
- Text primary: #f4f4f4
- Text secondary: #c6c6c6
- Primary blue: #0f62fe
- Success green: #24a148
- Warning yellow: #f1c21b
- Error red: #da1e28
- Info cyan: #1192e8

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
