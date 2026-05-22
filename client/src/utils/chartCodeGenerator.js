// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Chart Code Generator
 *
 * Generates executable React component code from chart configuration.
 * Supports ANY ECharts configuration - not limited to predefined chart types.
 *
 * Used by:
 * - AIBuilderModal (preview panel)
 * - ComponentEditor (preview tab)
 * - DashboardViewerPage (rendering charts)
 */

/**
 * Generate chart component code from chart configuration
 *
 * @param {Object} chart - Chart configuration object
 * @param {string} chart.chart_type - Chart type (bar, line, pie, custom, etc.)
 * @param {string} chart.connection_id - Data source ID for data fetching
 * @param {Object} chart.query_config - Query configuration {raw, type, params}
 * @param {Object} chart.data_mapping - Data mapping {x_axis, y_axis, filters, etc.}
 * @param {Object} chart.options - ECharts options (can be ANY valid ECharts config)
 * @param {string} chart.component_code - Custom component code (if use_custom_code)
 * @param {boolean} chart.use_custom_code - Whether to use custom code
 * @returns {string|null} - Generated component code or null
 */
export function generateChartCode(chart) {
  if (!chart) return null;

  // If using custom component code, return it directly
  if (chart.use_custom_code && chart.component_code) {
    return chart.component_code;
  }

  // If there's component_code (legacy), use it
  if (chart.component_code) {
    return chart.component_code;
  }

  // PRIORITY: If there's data mapping with a datasource, generate data-driven code
  // This takes precedence over raw options since AI typically sets both
  if (chart.connection_id && chart.data_mapping) {
    return generateDataDrivenCode(chart);
  }

  // If there are ECharts options (without datasource), generate wrapper code
  if (chart.options && Object.keys(chart.options).length > 0) {
    return generateFromOptions(chart);
  }

  // If just chart_type is set, generate static preview
  if (chart.chart_type) {
    return generateStaticCode(chart.chart_type);
  }

  return null;
}

/**
 * Generate code from ECharts options object
 * This supports ANY ECharts configuration the AI creates
 */
function generateFromOptions(chart) {
  const { options, connection_id: datasource_id, query_config, data_mapping } = chart;

  // If no datasource, render static options
  if (!datasource_id) {
    return `const Component = () => {
  const option = ${JSON.stringify(options, null, 2)};

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`;
  }

  // With datasource - fetch data and merge with options
  const queryRaw = query_config?.raw || '';
  const queryType = query_config?.type || 'sql';
  const xAxis = data_mapping?.x_axis || '';
  const yAxis = data_mapping?.y_axis || [];
  const transforms = buildTransformsConfig(data_mapping);

  return `const Component = () => {
  const { data, loading, error } = useData({
    connectionId: '${datasource_id}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: {}
    }
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--cds-text-secondary)' }}>Loading...</div>;
  if (error) return <div style={{ color: 'var(--cds-text-error)', padding: '1rem' }}>Error: {error.message}</div>;
  if (!data?.rows?.length) return <div style={{ color: 'var(--cds-text-secondary)', padding: '1rem' }}>No data available</div>;

  ${transforms ? `// Apply client-side transforms
  const transforms = ${JSON.stringify(transforms)};
  const transformed = transformData(data, transforms);
  const rows = transformed.rows;
  const columns = transformed.columns;` : `const rows = data.rows;
  const columns = data.columns;`}

  // Extract data for chart
  ${xAxis ? `const xIdx = columns.indexOf('${xAxis}');
  const xData = rows.map(r => formatCellValue(r[xIdx], '${xAxis}'));` : ''}
  ${yAxis.length > 0 ? `const yColumns = ${JSON.stringify(yAxis)};
  const seriesData = yColumns.map(col => ({
    name: col,
    data: rows.map(r => r[columns.indexOf(col)])
  }));` : ''}

  // Base options from AI configuration
  const baseOption = ${JSON.stringify(options, null, 2)};

  // Merge with data if available
  const option = {
    ...baseOption,
    ${xAxis ? `xAxis: { ...baseOption.xAxis, data: xData },` : ''}
    ${yAxis.length > 0 ? `series: seriesData.map((s, i) => ({
      ...(baseOption.series?.[i] || baseOption.series?.[0] || {}),
      name: s.name,
      data: s.data
    }))` : ''}
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`;
}

/**
 * Generate data-driven chart code from data mapping
 */
function generateDataDrivenCode(chart) {
  const { chart_type, connection_id: datasource_id, query_config, data_mapping } = chart;
  const queryRaw = query_config?.raw || '';
  const queryType = query_config?.type || 'sql';
  const queryParams = query_config?.params || {};
  const xAxis = data_mapping?.x_axis || '';
  const yAxis = data_mapping?.y_axis || [];
  const xAxisLabel = data_mapping?.x_axis_label || '';
  const yAxisLabel = data_mapping?.y_axis_label || '';
  const xAxisFormat = data_mapping?.x_axis_format || 'chart';
  const seriesCol = data_mapping?.series || ''; // Column to split series by (e.g., location)

  const transforms = buildTransformsConfig(data_mapping);
  const hasTransforms = !!transforms;

  const yAxisStr = yAxis.length > 0 ? yAxis.map(c => `'${c}'`).join(', ') : "'value'";

  // Handle pie charts
  if (chart_type === 'pie') {
    return generatePieCode(datasource_id, queryRaw, queryType, xAxis, yAxis[0], transforms, xAxisFormat, queryParams);
  }

  // Handle gauge charts
  if (chart_type === 'gauge') {
    return generateGaugeCode(datasource_id, queryRaw, queryType, yAxis[0], transforms, chart.options, queryParams);
  }

  // Handle scatter charts
  if (chart_type === 'scatter') {
    return generateScatterCode(datasource_id, queryRaw, queryType, xAxis, yAxis[0], transforms, xAxisLabel, yAxisLabel, queryParams);
  }

  // Handle dataview (table) charts
  if (chart_type === 'dataview') {
    return generateDataViewCode(datasource_id, queryRaw, queryType, data_mapping, transforms, queryParams);
  }

  // Standard axis-based charts (bar, line, area)
  const chartTypeForSeries = chart_type === 'area' ? 'line' : (chart_type || 'bar');
  const areaStyle = chart_type === 'area' ? 'areaStyle: {},' : '';
  const smooth = (chart_type === 'line' || chart_type === 'area') ? 'smooth: true,' : '';

  // Generate series code based on whether we have a series column for splitting
  let seriesCode;
  let legendCode = '';

  if (seriesCol) {
    // Split data into multiple series by a column (e.g., location)
    seriesCode = `// Group data by series column: ${seriesCol}
  const cols = ${hasTransforms ? 'transformed' : 'data'}.columns;
  const seriesColIdx = cols.indexOf('${seriesCol}');
  const xColIdx = cols.indexOf('${xAxis}');
  const yColIdx = cols.indexOf('${yAxis[0] || 'value'}');

  // Get unique series values
  const seriesValues = [...new Set(rows.map(r => r[seriesColIdx]))].filter(v => v != null);

  // Get unique x-axis values (timestamps) and sort them
  const uniqueX = [...new Set(rows.map(r => r[xColIdx]))].sort((a, b) => a - b);

  // Build series for each unique value in series column
  const series = seriesValues.map(seriesVal => {
    // Filter rows for this series and create a map of x -> y
    const seriesRows = rows.filter(r => r[seriesColIdx] === seriesVal);
    const dataMap = new Map(seriesRows.map(r => [r[xColIdx], r[yColIdx]]));

    // Map to unique x values to maintain alignment
    const data = uniqueX.map(x => dataMap.get(x) ?? null);

    return {
      name: String(seriesVal),
      data: data,
      type: '${chartTypeForSeries}',
      ${areaStyle}
      ${smooth}
    };
  });

  // Format categories from unique x values
  const categories = uniqueX.map(x => formatCellValue(x, '${xAxis}', { timestampFormat: '${xAxisFormat}' }));`;
    legendCode = `legend: { data: seriesValues.map(String), bottom: 0 },`;
  } else if (yAxis.length > 1) {
    // Multiple y columns as separate series
    seriesCode = `const yColumns = [${yAxisStr}];
    const series = yColumns.map((col) => ({
      name: col,
      data: rows.map(r => r[${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(col)]),
      type: '${chartTypeForSeries}',
      ${areaStyle}
      ${smooth}
    }));

  // Format x-axis values
  const xAxisCol = '${xAxis}';
  const xIdx = ${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(xAxisCol);
  const categories = rows.map(r => formatCellValue(r[xIdx], xAxisCol, { timestampFormat: '${xAxisFormat}' }));`;
    legendCode = `legend: { data: [${yAxisStr}], bottom: 0 },`;
  } else {
    // Single series
    seriesCode = `const series = [{
      data: rows.map(r => r[${hasTransforms ? 'transformed' : 'data'}.columns.indexOf('${yAxis[0] || 'value'}')]),
      type: '${chartTypeForSeries}',
      ${areaStyle}
      ${smooth}
      itemStyle: { color: '#0f62fe' }
    }];

  // Format x-axis values
  const xAxisCol = '${xAxis}';
  const xIdx = ${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(xAxisCol);
  const categories = rows.map(r => formatCellValue(r[xIdx], xAxisCol, { timestampFormat: '${xAxisFormat}' }));`;
  }

  return `const Component = () => {
  const { data, loading, error } = useData({
    connectionId: '${datasource_id}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--cds-text-secondary)' }}>Loading...</div>;
  if (error) return <div style={{ color: 'var(--cds-text-error)', padding: '1rem' }}>Error: {error.message}</div>;
  if (!data?.rows?.length) return <div style={{ color: 'var(--cds-text-secondary)', padding: '1rem' }}>No data available</div>;

  ${hasTransforms ? `// Apply client-side transforms
  const transforms = ${JSON.stringify(transforms)};
  const transformed = transformData(data, transforms);
  const rows = transformed.rows;` : `const rows = data.rows;`}

  ${seriesCode}

  const option = {
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      formatter: function(params) {
        if (!params || !params.length) return '';
        // Header: format the axis value (timestamp in milliseconds)
        // axisValue is raw milliseconds, divide by 1000 for formatTimestamp
        const axisVal = params[0].axisValue;
        let header = params[0].axisValueLabel || params[0].name || '';
        // If axisValue is a large number (timestamp in ms), format it
        if (typeof axisVal === 'number' && axisVal > 1000000000000) {
          header = formatTimestamp(axisVal / 1000, 'chart_datetime');
        }
        let result = header;
        params.forEach(function(p) {
          // Extract value - handle multiple formats:
          // 1. Single numeric value
          // 2. [timestamp, value] array
          // 3. "timestamp,value" string (from some data sources)
          let val = p.value;
          if (Array.isArray(val)) {
            val = val[1]; // Get second element from [timestamp, value]
          } else if (typeof val === 'string' && val.includes(',')) {
            val = val.split(',').pop(); // Get last part after comma
          }
          result += '<br/>' + p.marker + ' ' + p.seriesName + ': ' + (val != null ? val : '-');
        });
        return result;
      }
    },
    ${legendCode}
    xAxis: { type: 'category', data: categories${chart_type === 'area' ? ', boundaryGap: false' : ''}${xAxisLabel ? `, name: '${xAxisLabel}'` : ''} },
    yAxis: { type: 'value'${yAxisLabel ? `, name: '${yAxisLabel}'` : ''} },
    series: series
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`;
}

/**
 * Generate static chart code (no data source)
 */
function generateStaticCode(chartType) {
  const templates = {
    bar: `const Component = () => {
  const option = {
    tooltip: { trigger: 'axis', appendToBody: true },
    xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar', 'Apr', 'May'] },
    yAxis: { type: 'value' },
    series: [{ data: [400, 300, 500, 280, 590], type: 'bar', itemStyle: { color: '#0f62fe' } }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    line: `const Component = () => {
  const option = {
    tooltip: { trigger: 'axis', appendToBody: true },
    xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar', 'Apr', 'May'] },
    yAxis: { type: 'value' },
    series: [{ data: [400, 300, 500, 280, 590], type: 'line', smooth: true, itemStyle: { color: '#0f62fe' } }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    area: `const Component = () => {
  const option = {
    tooltip: { trigger: 'axis', appendToBody: true },
    xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar', 'Apr', 'May'], boundaryGap: false },
    yAxis: { type: 'value' },
    series: [{ data: [400, 300, 500, 280, 590], type: 'line', areaStyle: {}, smooth: true, itemStyle: { color: '#0f62fe' } }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    pie: `const Component = () => {
  const option = {
    tooltip: { trigger: 'item', appendToBody: true, formatter: '{b}: {c} ({d}%)' },
    series: [{
      type: 'pie',
      radius: '70%',
      data: [
        { name: 'Category A', value: 400 },
        { name: 'Category B', value: 300 },
        { name: 'Category C', value: 200 },
        { name: 'Category D', value: 100 }
      ],
      emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' } }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    scatter: `const Component = () => {
  const option = {
    tooltip: { trigger: 'item', appendToBody: true },
    xAxis: { type: 'value' },
    yAxis: { type: 'value' },
    series: [{ data: [[10, 20], [20, 30], [30, 25], [40, 45], [50, 35]], type: 'scatter', symbolSize: 15, itemStyle: { color: '#0f62fe' } }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    gauge: `const Component = () => {
  const option = {
    backgroundColor: 'transparent',
    series: [{
      type: 'gauge',
      progress: { show: false },
      axisLine: { lineStyle: { width: 18 } },
      axisTick: { show: false },
      splitLine: { length: 15, lineStyle: { width: 2, color: '#999' } },
      axisLabel: { distance: 25, color: '#999', fontSize: 14 },
      anchor: { show: true, showAbove: true, size: 25, itemStyle: { borderWidth: 10 } },
      title: { show: false },
      detail: { valueAnimation: true, fontSize: 40, offsetCenter: [0, '70%'] },
      data: [{ value: 72, name: 'Score' }]
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    custom: `const Component = () => {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--cds-text-secondary)' }}>
      <p>Custom chart - configure options or data source</p>
    </div>
  );
};`,
    dataview: `const Component = () => {
  const headers = [
    { key: 'name', header: 'Name' },
    { key: 'value', header: 'Value' },
    { key: 'status', header: 'Status' }
  ];

  const rows = [
    { id: '1', name: 'Server 1', value: '98.5%', status: 'Active' },
    { id: '2', name: 'Server 2', value: '95.2%', status: 'Active' },
    { id: '3', name: 'Database', value: '99.1%', status: 'Active' },
    { id: '4', name: 'Cache', value: '87.3%', status: 'Warning' }
  ];

  return (
    <DataTable rows={rows} headers={headers} isSortable>
      {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
        <TableContainer style={{ height: '100%', overflow: 'auto' }}>
          <Table {...getTableProps()} size="lg">
            <TableHead>
              <TableRow>
                {headers.map((header) => (
                  <TableHeader {...getHeaderProps({ header })} key={header.key}>
                    {header.header}
                  </TableHeader>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow {...getRowProps({ row })} key={row.id}>
                  {row.cells.map((cell) => (
                    <TableCell key={cell.id}>{cell.value}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </DataTable>
  );
};`
  };

  return templates[chartType] || templates.bar;
}

// Helper functions for specific chart types
function generatePieCode(connectionId, queryRaw, queryType, xAxis, yAxis, transforms, xAxisFormat, queryParams = {}) {
  const hasTransforms = !!transforms;
  return `const Component = () => {
  const { data, loading, error } = useData({
    connectionId: '${connectionId}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--cds-text-secondary)' }}>Loading...</div>;
  if (error) return <div style={{ color: 'var(--cds-text-error)', padding: '1rem' }}>Error: {error.message}</div>;
  if (!data?.rows?.length) return <div style={{ color: 'var(--cds-text-secondary)', padding: '1rem' }}>No data available</div>;

  ${hasTransforms ? `const transforms = ${JSON.stringify(transforms)};
  const transformed = transformData(data, transforms);
  const rows = transformed.rows;
  const columns = transformed.columns;` : `const rows = data.rows;
  const columns = data.columns;`}

  const xIdx = columns.indexOf('${xAxis}');
  const yIdx = columns.indexOf('${yAxis || 'value'}');
  const pieData = rows.map(r => ({
    name: formatCellValue(r[xIdx], '${xAxis}', { timestampFormat: '${xAxisFormat}' }),
    value: Number(r[yIdx])
  }));

  const option = {
    tooltip: { trigger: 'item', appendToBody: true, formatter: '{b}: {c} ({d}%)' },
    series: [{
      type: 'pie',
      radius: '70%',
      data: pieData,
      emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' } }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`;
}

function generateGaugeCode(connectionId, queryRaw, queryType, yAxis, transforms, chartOptions = {}, queryParams = {}) {
  const hasTransforms = !!transforms;

  // Extract gauge options with defaults
  const gaugeMin = chartOptions?.gaugeMin ?? 0;
  const gaugeMax = chartOptions?.gaugeMax ?? 100;
  const warningThreshold = (chartOptions?.gaugeWarningThreshold ?? 70) / 100; // Convert to 0-1 range
  const dangerThreshold = (chartOptions?.gaugeDangerThreshold ?? 90) / 100;   // Convert to 0-1 range
  const unit = chartOptions?.gaugeUnit || '';
  const lineThickness = (chartOptions?.gaugeLineThickness ?? 8) / 100; // Convert to decimal (1-16% -> 0.01-0.16)

  // Format detail formatter based on unit
  const detailFormatter = unit ? `'{value}${unit}'` : "'{value}'";

  return `const Component = () => {
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 200, height: 200 });

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      // Only update if size changed by more than 1px to prevent resize loops
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

  const { data, loading, error } = useData({
    connectionId: '${connectionId}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--cds-text-secondary)' }}>Loading...</div>;
  if (error) return <div style={{ color: 'var(--cds-text-error)', padding: '1rem' }}>Error: {error.message}</div>;
  if (!data?.rows?.length) return <div style={{ color: 'var(--cds-text-secondary)', padding: '1rem' }}>No data available</div>;

  ${hasTransforms ? `const transforms = ${JSON.stringify(transforms)};
  const transformed = transformData(data, transforms);
  const rows = transformed.rows;
  const columns = transformed.columns;` : `const rows = data.rows;
  const columns = data.columns;`}

  const yIdx = columns.indexOf('${yAxis || 'value'}');
  const value = rows.length > 0 ? Number(rows[0][yIdx]) : 0;

  // Calculate responsive sizes based on container - all proportional, no minimums
  const minDim = Math.min(containerSize.width, containerSize.height);
  const baseFontSize = Math.floor(minDim * 0.12);
  const labelFontSize = Math.floor(minDim * 0.06);
  const axisLineWidth = Math.floor(minDim * ${lineThickness});
  const splitLineLength = Math.floor(minDim * 0.05);
  const anchorSize = Math.floor(minDim * 0.08);

  const option = {
    backgroundColor: 'transparent',
    series: [{
      type: 'gauge',
      min: ${gaugeMin},
      max: ${gaugeMax},
      progress: { show: false },
      axisLine: {
        lineStyle: {
          width: axisLineWidth,
          color: [
            [${warningThreshold}, '#24a148'],  // Green: 0 to warning
            [${dangerThreshold}, '#f1c21b'],   // Yellow: warning to danger
            [1, '#da1e28']                      // Red: danger to 100%
          ]
        }
      },
      axisTick: { show: false },
      splitLine: { length: splitLineLength, lineStyle: { width: 2, color: '#999' } },
      axisLabel: { distance: Math.floor(minDim * 0.08), color: '#999', fontSize: labelFontSize },
      anchor: { show: true, showAbove: true, size: anchorSize, itemStyle: { borderWidth: Math.floor(anchorSize * 0.4) } },
      title: { show: false },
      detail: { valueAnimation: true, fontSize: baseFontSize, offsetCenter: [0, '70%'], formatter: ${detailFormatter} },
      data: [{ value: value, name: '${yAxis || 'Value'}' }]
    }]
  };

  return (
    <div ref={containerRef} style={{ height: '100%', width: '100%' }}>
      <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />
    </div>
  );
};`;
}

function generateScatterCode(connectionId, queryRaw, queryType, xAxis, yAxis, transforms, xAxisLabel, yAxisLabel, queryParams = {}) {
  const hasTransforms = !!transforms;
  return `const Component = () => {
  const { data, loading, error } = useData({
    connectionId: '${connectionId}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--cds-text-secondary)' }}>Loading...</div>;
  if (error) return <div style={{ color: 'var(--cds-text-error)', padding: '1rem' }}>Error: {error.message}</div>;
  if (!data?.rows?.length) return <div style={{ color: 'var(--cds-text-secondary)', padding: '1rem' }}>No data available</div>;

  ${hasTransforms ? `const transforms = ${JSON.stringify(transforms)};
  const transformed = transformData(data, transforms);
  const rows = transformed.rows;
  const columns = transformed.columns;` : `const rows = data.rows;
  const columns = data.columns;`}

  const xIdx = columns.indexOf('${xAxis}');
  const yIdx = columns.indexOf('${yAxis || 'value'}');
  const scatterData = rows.map(r => [Number(r[xIdx]), Number(r[yIdx])]);

  const option = {
    tooltip: { trigger: 'item', appendToBody: true },
    xAxis: { type: 'value'${xAxisLabel ? `, name: '${xAxisLabel}'` : ''} },
    yAxis: { type: 'value'${yAxisLabel ? `, name: '${yAxisLabel}'` : ''} },
    series: [{ data: scatterData, type: 'scatter', symbolSize: 15, itemStyle: { color: '#0f62fe' } }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`;
}

function generateDataViewCode(connectionId, queryRaw, queryType, dataMapping, transforms, queryParams = {}) {
  const hasTransforms = !!transforms;
  const visibleColumns = dataMapping?.visible_columns || [];
  const hasVisibleColumns = visibleColumns.length > 0;

  return `const Component = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const { data, loading, error } = useData({
    connectionId: '${connectionId}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--cds-text-secondary)' }}>Loading...</div>;
  if (error) return <div style={{ color: 'var(--cds-text-error)', padding: '1rem' }}>Error: {error.message}</div>;
  if (!data?.rows?.length) return <div style={{ color: 'var(--cds-text-secondary)', padding: '1rem' }}>No data available</div>;

  ${hasTransforms ? `// Apply client-side transforms
  const transforms = ${JSON.stringify(transforms)};
  const transformed = transformData(data, transforms);
  const sourceRows = transformed.rows;
  const sourceColumns = transformed.columns;` : `const sourceRows = data.rows;
  const sourceColumns = data.columns;`}

  // Determine which columns to display
  ${hasVisibleColumns ? `const displayColumns = ${JSON.stringify(visibleColumns)}.filter(c => sourceColumns.includes(c));` : `const displayColumns = sourceColumns;`}

  // Convert columnar data to row objects for DataTable. Connections
  // return rows in chronological-ascending order (oldest first);
  // dataview-on-a-dashboard users almost always want newest at the
  // top (most recent reading or event sits in the visible viewport
  // without scrolling). Reverse before mapping so the default render
  // is newest-first. Carbon's column-sort still works on top of this.
  const headers = displayColumns.map(col => ({ key: col, header: col }));
  const rows = sourceRows.slice().reverse().map((row, idx) => {
    const rowObj = { id: String(idx) };
    displayColumns.forEach((col) => {
      const colIdx = sourceColumns.indexOf(col);
      rowObj[col] = formatCellValue(row[colIdx], col);
    });
    return rowObj;
  });

  // Filter rows by search term
  const filteredRows = searchTerm
    ? rows.filter(row =>
        Object.values(row).some(val =>
          String(val).toLowerCase().includes(searchTerm.toLowerCase())
        )
      )
    : rows;

  return (
    <DataTable rows={filteredRows} headers={headers} isSortable>
      {({ rows, headers, getTableProps, getHeaderProps, getRowProps, onInputChange }) => (
        <TableContainer style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <TableToolbar>
            <TableToolbarContent>
              <TableToolbarSearch
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  onInputChange(e);
                }}
                placeholder="Search..."
                persistent
              />
            </TableToolbarContent>
          </TableToolbar>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <Table {...getTableProps()} size="lg">
              <TableHead>
                <TableRow>
                  {headers.map((header) => (
                    <TableHeader {...getHeaderProps({ header })} key={header.key}>
                      {header.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow {...getRowProps({ row })} key={row.id}>
                    {row.cells.map((cell) => (
                      <TableCell key={cell.id}>{cell.value}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TableContainer>
      )}
    </DataTable>
  );
};`;
}

/**
 * Build transforms configuration from data_mapping
 */
function buildTransformsConfig(dataMapping) {
  if (!dataMapping) return null;

  const { filters, aggregation, sort_by, sort_order, limit } = dataMapping;
  const hasTransforms = (filters?.length > 0) || aggregation?.type || sort_by || (limit > 0);

  if (!hasTransforms) return null;

  return {
    filters: (filters || []).map(f => ({
      field: f.field,
      op: f.op,
      value: (f.op === 'in' || f.op === 'notIn') && typeof f.value === 'string'
        ? f.value.split(',').map(v => v.trim())
        : f.value
    })),
    aggregation: aggregation?.type ? aggregation : null,
    sortBy: sort_by || null,
    sortOrder: sort_order || 'desc',
    limit: limit || 0
  };
}

export default generateChartCode;
