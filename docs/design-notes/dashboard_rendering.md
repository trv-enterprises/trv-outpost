# Dashboard Rendering Documentation

This document covers the code involved in dashboard thumbnail rendering and chart preview rendering.

## Table of Contents
1. [Dashboard Thumbnail Rendering](#dashboard-thumbnail-rendering)
2. [Chart Preview Rendering](#chart-preview-rendering)
3. [DynamicComponentLoader](#dynamiccomponentloader)

---

## Dashboard Thumbnail Rendering

Thumbnails are captured when a dashboard is saved. The process involves switching to preview mode, waiting for charts to render, and using html2canvas to capture the grid.

### Capture Function (`DashboardViewerPage.jsx`)

```javascript
// Capture thumbnail of the dashboard grid (switches to preview mode temporarily)
const captureThumbnail = async () => {
  if (!thumbnailCaptureRef.current) return null;
  if (panels.length === 0) return null;

  // Store current mode to restore after capture
  const previousMode = editorMode;

  try {
    // Switch to preview mode so charts are rendered
    setEditorMode(EDITOR_MODES.PREVIEW);

    // Wait for React to render charts and ECharts to initialize
    // ECharts needs time to render, so wait longer than a typical React render
    await new Promise(resolve => setTimeout(resolve, 800));

    // Trigger window resize event to make ECharts recalculate dimensions
    window.dispatchEvent(new Event('resize'));

    // Wait for ECharts to recalculate after resize
    await new Promise(resolve => setTimeout(resolve, 300));

    // Add thumbnail-capture class for styling
    thumbnailCaptureRef.current.classList.add('thumbnail-capture');

    // Store original styles and apply capture-specific styles
    const originalPadding = thumbnailCaptureRef.current.style.padding;
    thumbnailCaptureRef.current.style.padding = '16px';

    // Wait for styles to apply
    await new Promise(resolve => setTimeout(resolve, 50));

    const canvas = await html2canvas(thumbnailCaptureRef.current, {
      scale: 0.5,
      backgroundColor: '#161616',
      logging: false,
      useCORS: true,
      allowTaint: true
    });

    // Restore original styles
    thumbnailCaptureRef.current.style.padding = originalPadding;
    thumbnailCaptureRef.current.classList.remove('thumbnail-capture');

    // Restore previous mode
    setEditorMode(previousMode);

    const dataUrl = canvas.toDataURL('image/png', 0.8);
    return dataUrl;
  } catch (err) {
    console.error('Failed to capture thumbnail:', err);
    // Ensure we clean up even if there's an error
    if (thumbnailCaptureRef.current) {
      thumbnailCaptureRef.current.style.padding = '';
      thumbnailCaptureRef.current.classList.remove('thumbnail-capture');
    }
    // Restore previous mode
    setEditorMode(previousMode);
    return null;
  }
};
```

### Thumbnail Capture CSS (`DashboardViewerPage.scss`)

```scss
// Thumbnail capture mode - hide design elements, show clean preview
&.thumbnail-capture {
  padding: spacing.$spacing-05; // Add padding for capture to prevent edge truncation

  .panel-grid {
    // Hide grid lines pseudo-element
    &::before {
      display: none;
    }

    // Add gap between panels for cleaner thumbnail
    gap: spacing.$spacing-03;

    .panel-item {
      background-color: #262626;
      border: 1px solid #393939;

      .panel-header {
        display: none; // Hide header with drag handle
      }

      .resize-handle {
        display: none; // Hide resize handle
      }

      // Preview mode - match viewer styling for charts
      .panel-body {
        padding: 0;
        position: relative;

        .component-preview {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          padding: spacing.$spacing-03;

          // ECharts needs explicit dimensions
          .echarts-for-react {
            width: 100% !important;
            height: 100% !important;
          }
        }
      }
    }
  }
}
```

### Grid Container Reference

The `thumbnailCaptureRef` is attached to the panel grid container:

```jsx
<div className="panel-grid-container" ref={thumbnailCaptureRef}>
  <div
    ref={gridRef}
    className={`panel-grid mode-${editorMode}`}
    style={{
      width: `${GRID_COLS * CELL_WIDTH}px`,
      height: `${GRID_ROWS * CELL_HEIGHT}px`,
      gridTemplateColumns: `repeat(${GRID_COLS}, ${CELL_WIDTH}px)`,
      gridTemplateRows: `repeat(${GRID_ROWS}, ${CELL_HEIGHT}px)`,
      '--cell-width': `${CELL_WIDTH}px`
    }}
  >
    {/* Panels rendered here */}
  </div>
</div>
```

---

## Chart Preview Rendering

### Dashboard Viewer Page (`DashboardViewerPage.jsx`)

The viewer renders charts using `DynamicComponentLoader`:

```jsx
{dashboard.panels.map((panel) => {
  const chart = panel.chart_id ? chartsMap[panel.chart_id] : null;
  const hasChart = !!chart?.component_code;

  return (
    <div
      key={panel.id}
      className={`panel-container ${hasChart ? 'has-component' : 'empty-panel'}`}
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + 1} / span ${panel.h}`,
        cursor: hasChart ? 'pointer' : 'default'
      }}
      onDoubleClick={() => handlePanelDoubleClick(chart)}
    >
      {hasChart ? (
        <>
          {/* Show header only for datatable type (no built-in title) */}
          {chart.chart_type === 'datatable' && (
            <div className="chart-header">
              <span className="chart-name">{chart.name || 'Untitled Chart'}</span>
            </div>
          )}
          <div className={`component-wrapper ${chart.chart_type === 'datatable' ? 'with-header' : ''}`}>
            <DynamicComponentLoader
              code={chart.component_code}
              props={{}}
              dataMapping={chart.data_mapping}
              datasourceId={chart.connection_id}
            />
          </div>
        </>
      ) : (
        <div className="empty-panel-placeholder">
          <span>No chart</span>
        </div>
      )}
    </div>
  );
})}
```

### Viewer Panel Styling (`DashboardViewerPage.scss`)

```scss
.panel-container {
  background-color: #262626;
  border: 1px solid #393939;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 100%;

  &.has-component {
    // All panels with components have consistent styling
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  }

  .chart-header {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: spacing.$spacing-03 spacing.$spacing-04;
    background-color: #1a1a1a;
    border-bottom: 1px solid #393939;
    flex-shrink: 0;
    height: 40px;

    .chart-name {
      color: #f4f4f4;
      font-size: 0.875rem;
      font-weight: 600;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .component-wrapper {
    flex: 1;
    padding: spacing.$spacing-04;
    overflow: hidden;
    min-height: 0;
    height: 100%;
    position: relative;

    &.with-header {
      height: calc(100% - 40px);
    }

    // Wrapper div from DynamicComponentLoader
    > div {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      padding: spacing.$spacing-04;
    }

    // ECharts needs explicit dimensions
    .echarts-for-react {
      width: 100% !important;
      height: 100% !important;
      min-height: 150px;
    }
  }

  // Empty panels (no chart assigned)
  &.empty-panel {
    border-style: dashed;
    border-color: var(--cds-border-subtle-01);
    background-color: transparent;
    box-shadow: none;
  }
}
```

### Dashboard Viewer Page Preview Mode (`DashboardViewerPage.jsx`)

In the detail/editor page, preview mode renders charts similarly:

```jsx
{panels.map((panel) => {
  const chart = panel.chart_id ? chartsMap[panel.chart_id] : null;
  const hasChart = !!chart;
  const isDesignMode = editorMode === EDITOR_MODES.DESIGN;
  const isPreviewMode = editorMode === EDITOR_MODES.PREVIEW;

  return (
    <div
      key={panel.id}
      className={`panel-item ${isPreviewMode && hasChart ? 'live-preview' : ''} ${isDesignMode ? 'design-mode' : ''}`}
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + 1} / span ${panel.h}`
      }}
    >
      {/* Panel header - draggable in design mode */}
      <div className="panel-header">
        <span className="panel-id">{chart?.name || panel.id}</span>
        <div className="panel-header-right">
          <span className="panel-size">{panel.w}x{panel.h}</span>
          {/* Delete button in design mode */}
        </div>
      </div>

      {/* Panel body */}
      <div className="panel-body">
        {isPreviewMode && hasChart ? (
          <div className="component-preview">
            <DynamicComponentLoader
              code={chart.component_code}
              props={{}}
              dataMapping={chart.data_mapping}
              datasourceId={chart.connection_id}
            />
          </div>
        ) : isDesignMode ? (
          <div className="design-body">
            {/* Design mode UI - chart info or empty panel actions */}
          </div>
        ) : (
          <div className="empty-panel">
            <span>No chart</span>
          </div>
        )}
      </div>
    </div>
  );
})}
```

---

## DynamicComponentLoader

The `DynamicComponentLoader` component (`client/src/components/DynamicComponentLoader.jsx`) is responsible for:
1. Parsing and transpiling JSX code using Babel
2. Providing React hooks and visualization libraries in scope
3. Fetching data from datasources
4. Applying data transforms (filters, aggregations)
5. Rendering the compiled component

### Key Features

```javascript
export default function DynamicComponentLoader({
  code,           // JSX component code string
  props = {},     // Props to pass to component
  dataMapping = null,  // Data mapping config (filters, aggregations)
  datasourceId = null  // Data source ID for fetching data
}) {
  // ...
}
```

### Available in Component Scope

Components loaded via `DynamicComponentLoader` have access to:

| Library/Hook | Description |
|-------------|-------------|
| `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useContext` | React hooks |
| `useData` | Custom hook for fetching data (auto-applies transforms) |
| `transformData` | Apply filters and aggregations to data |
| `toObjects` | Convert columnar data to array of objects |
| `getValue` | Get single value from first row |
| `formatTimestamp` | Format timestamp values |
| `formatCellValue` | Auto-format cell values |
| `echarts` | ECharts core library |
| `ReactECharts` | ECharts React wrapper |
| `carbonTheme`, `carbonDarkTheme` | Carbon ECharts themes |
| `DataTable`, `Table`, etc. | Carbon DataTable components |

### Component Wrapper

The loader wraps components in a flex container:

```jsx
return (
  <TransformsContext.Provider value={transforms}>
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Component {...finalProps} />
    </div>
  </TransformsContext.Provider>
);
```

---

## Grid Configuration

Both pages use the same grid cell dimensions:

```javascript
// Grid configuration - fixed 64x36px cells (16:9 aspect ratio)
const CELL_WIDTH = 64;
const CELL_HEIGHT = 36;
```

Grid dimensions are calculated dynamically based on the selected dimension preset:

```javascript
const GRID_COLS = Math.floor(gridWidth / CELL_WIDTH);
const GRID_ROWS = Math.floor(gridHeight / CELL_HEIGHT);
```

---

## Thumbnail Display (`DashboardTileViewPage.jsx`)

Thumbnails are displayed in the tile view:

```jsx
<div className="tile-thumbnail">
  {dashboard.thumbnail ? (
    <img src={dashboard.thumbnail} alt={dashboard.name} />
  ) : (
    <div className="thumbnail-placeholder">
      <Dashboard size={48} />
    </div>
  )}
</div>
```

---

## Known Issues / Considerations

1. **ECharts Timing**: ECharts needs time to render and calculate dimensions. The capture function waits 1000ms for charts to initialize.

2. **Thumbnail Display**: The tile view uses `object-fit: contain` to display the full thumbnail without cropping. Using `cover` will crop the image and cause clipping.

3. **CSS Specificity**: The `.thumbnail-capture` class overrides panel styling to hide design elements and match viewer appearance.

4. **html2canvas Limitations**: Some CSS properties and canvas elements may not render perfectly in html2canvas.

## Key Fix (Build 266-267)

The original issue with thumbnails being clipped on the left side was caused by `object-fit: cover` in the thumbnail display CSS. This was cropping the image to fill the container.

**Solution**: Changed to `object-fit: contain` with `object-position: top left` to display the full captured image without cropping.
