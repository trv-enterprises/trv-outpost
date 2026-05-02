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

// List returns the chart types that have templates, in no guaranteed
// order. Useful for agent prompts listing the available skeletons.
func List() []string {
	out := make([]string, 0, len(templates))
	for k := range templates {
		out = append(out, k)
	}
	return out
}

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
