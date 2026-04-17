# Component Specification Summary

**Purpose**: Design constraints and templates for creating React dashboard components in TRVE Dashboards.

## Quick Reference

### Available in Component Scope

Components receive data via props and have access to:

**React Hooks:**
- `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useContext`

**ECharts:**
- `echarts` - Core ECharts library
- `ReactECharts` - React wrapper component
- `carbonTheme`, `carbonDarkTheme` - Pre-configured themes

**Carbon Design System (for DataTable/DataView):**
- `DataTable`, `Table`, `TableHead`, `TableRow`, `TableHeader`, `TableBody`, `TableCell`

**Data Utilities:**
- `toObjects(data)` - Convert columnar `{ columns, rows }` to array of objects
- `getValue(data, 'column')` - Get single value from first row
- `formatTimestamp(ts, format)` - Format timestamps ('chart_time', 'chart_datetime', etc.)
- `formatCellValue(value, columnName)` - Auto-format cell values based on type
- `transformData(data, options)` - Transform data with filters, aggregation, sort, limit

### Component Requirements

✅ Must export `Component` (receives `{ data }` prop)
✅ Return valid JSX
✅ Handle empty data state
✅ Use Carbon Design System colors (dark theme)
✅ Use `style={{ height: '100%', width: '100%' }}` for ReactECharts

### Component Structure

```javascript
const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) {
    return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;
  }

  const option = {
    backgroundColor: 'transparent',
    // ... ECharts options
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};
```

### Carbon Colors (g100 Dark Theme)

```javascript
{
  primary: '#0f62fe',      // blue60 - primary actions, links
  success: '#24a148',      // green50 - success states
  warning: '#f1c21b',      // yellow30 - warnings
  error: '#da1e28',        // red60 - errors, danger
  info: '#1192e8',         // cyan50 - informational
  accent: '#8a3ffc',       // purple60 - accent color

  text: '#f4f4f4',         // gray10 - primary text
  textSecondary: '#c6c6c6', // gray30 - secondary text
  textPlaceholder: '#6f6f6f', // gray60 - placeholders

  background: '#161616',   // gray100 - page background
  layer01: '#262626',      // gray90 - card/panel background
  layer02: '#393939',      // gray80 - elevated surfaces
  border: '#393939',       // gray80 - borders
  borderSubtle: '#525252'  // gray70 - subtle borders
}
```

---

## Chart Types

### Line Chart (Time-Series)

```javascript
const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
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
      itemStyle: { color: '#0f62fe' }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};
```

### Bar Chart (Categorical)

```javascript
const Component = ({ data }) => {
  const chartData = toObjects(data);
  if (!chartData.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' } },
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
};
```

### Area Chart

```javascript
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
```

### Pie Chart (Proportional)

```javascript
const option = {
  backgroundColor: 'transparent',
  tooltip: { trigger: 'item', backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' } },
  legend: { top: '5%', left: 'center', textStyle: { color: '#c6c6c6' } },
  series: [{
    type: 'pie',
    radius: '60%',
    center: ['50%', '55%'],
    data: chartData.map(d => ({ name: d.name || d.category, value: d.value })),
    label: { color: '#c6c6c6' },
    itemStyle: { borderColor: '#161616', borderWidth: 2 }
  }]
};
```

### Gauge Chart (Single Metric)

```javascript
const option = {
  backgroundColor: 'transparent',
  series: [{
    type: 'gauge',
    startAngle: 200,
    endAngle: -20,
    min: 0,
    max: 100,
    radius: '90%',
    center: ['50%', '55%'],
    pointer: { show: true, itemStyle: { color: '#0f62fe' } },
    axisLine: {
      lineStyle: {
        width: 20,
        color: [[0.3, '#24a148'], [0.7, '#f1c21b'], [1, '#da1e28']]
      }
    },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { color: '#c6c6c6', distance: 25, fontSize: 12 },
    detail: { valueAnimation: true, formatter: '{value}%', color: '#f4f4f4', fontSize: 24, offsetCenter: [0, '60%'] },
    data: [{ value: chartData[0]?.value || 0, name: 'Usage' }]
  }]
};
```

### Number Display (KPI)

```javascript
const Component = ({ data }) => {
  const value = getValue(data, 'value');
  const title = getValue(data, 'title') || 'Metric';
  const unit = getValue(data, 'unit') || '';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: '#f4f4f4', backgroundColor: 'transparent'
    }}>
      <div style={{ fontSize: '0.875rem', color: '#c6c6c6', marginBottom: '8px' }}>{title}</div>
      <div style={{ fontSize: '3rem', fontWeight: 600 }}>{value}{unit}</div>
    </div>
  );
};
```

### DataView (Data Table)

```javascript
const Component = ({ data }) => {
  const rows = toObjects(data);
  if (!rows.length) return <div style={{color: '#f4f4f4', padding: '20px'}}>No data available</div>;

  const columns = data.columns || Object.keys(rows[0]);
  const headers = columns.map(col => ({ key: col, header: col }));
  const tableRows = rows.map((row, i) => ({ id: String(i), ...row }));

  return (
    <DataTable rows={tableRows} headers={headers}>
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
  );
};
```

---

## Connection Types

Components can receive data from various connection types:

| Type | Description | Use Case |
|------|-------------|----------|
| `sql` | PostgreSQL, MySQL, SQLite, MSSQL, Oracle | Relational databases |
| `api` | REST APIs with JSON responses | External services |
| `csv` | CSV file parsing | Static data files |
| `socket` (WebSocket) | Bi-/uni-directional WebSocket | Real-time streaming, controls |
| `socket` (TCP) | Raw TCP connections | IoT sensors, line-delimited streams |
| `mqtt` | MQTT broker (Eclipse Paho) | Topic-multiplexed device telemetry |
| `prometheus` | Prometheus metrics | Infrastructure monitoring |
| `edgelake` | EdgeLake distributed DB | Edge/IoT computing |
| `tsstore` | Time-series store | Time-series data |
| `frigate` | Frigate NVR proxy (integration) | Camera viewers, alerts |

---

## Control Components

In addition to display components (charts), the system supports control components for user interaction:

| Control Type | Description |
|--------------|-------------|
| `button` | Trigger actions/commands |
| `toggle` | On/off switches |
| `slider` | Numeric value selection |
| `text_input` | Text entry for commands |

Controls can send commands to bidirectional connections (MQTT, WebSocket-bidirectional) via the `/api/controls/:id/execute` endpoint. WebSocket connections must have the **Bidirectional** flag set in the connection editor for write operations to be permitted.

---

## Common Mistakes to Avoid

❌ Not handling empty data → Always check `if (!chartData.length)`
❌ Wrong background color → Use `backgroundColor: 'transparent'`
❌ Hard-coded dimensions → Use `style={{ height: '100%', width: '100%' }}`
❌ Wrong text colors → Use `#f4f4f4` for primary, `#c6c6c6` for secondary
❌ Missing tooltip styling → Always style tooltips with dark theme colors
❌ Filtering in component code → Use `update_filters` tool instead
❌ Assuming column names → Use `get_schema` to discover actual columns

---

## AI Chart Builder Workflow

When using the AI chart builder, components are created through this workflow:

1. `list_datasources` - See available connections
2. `update_chart_config` - Set chart type
3. `get_schema` - Discover columns and data types
4. `get_chart_template` - Get the appropriate template
5. `update_data_mapping` - Map columns to axes
6. `update_filters` - Add data filters (optional)
7. `set_custom_code` - Set the final component code

The AI uses internal tools (not MCP) to configure charts. The resulting component code follows the patterns documented above.

---

## Full Documentation

- **AI System Prompt**: `server-go/internal/ai/system_prompt.go`
- **Chart Templates**: `server-go/internal/ai/chart_templates.go`
- **ECharts Examples**: https://echarts.apache.org/examples/en/index.html
- **Carbon Design System**: https://carbondesignsystem.com

---

**Last Updated**: 2026-02-14
