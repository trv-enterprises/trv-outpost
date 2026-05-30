// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { useDataviewLayout } from '../../hooks/useDataviewLayout';
import { formatCellValue } from '../../utils/dataTransforms';

/**
 * DataViewGrid — the non-ECharts render for the `dataview` chart type.
 *
 * AG Grid Community, Quartz-dark theme. Virtualized; per-column sort /
 * filter / resize / reorder built in. Handles streaming journal data via
 * imperative applyTransaction (so open filter menus survive batches).
 * visible_columns + column_aliases are honored as chart defaults;
 * useDataviewLayout layers per-user resize/reorder overrides on top.
 *
 * Ported near-verbatim from the legacy string-codegen
 * `chartType === 'dataview'` branch in ComponentEditor. The only changes:
 * inputs arrive as props (from specs/dataview.js's buildOption descriptor)
 * + dataCtx + config instead of a generated useData() call and eval-scope
 * injection; AgGridReact / useDataviewLayout / formatCellValue are now
 * direct imports. Owns its own title + loading/error/no-data chrome (not
 * wrapped in ChartShell). See docs/design-notes/spec-driven-non-echarts-views.md.
 *
 * @param {object}        props
 * @param {object}        props.columnAliases       { col → display name }
 * @param {string[]|null} props.visibleColumnsConfig ordered whitelist, or null = show all
 * @param {string}        props.xAxisFormat         timestamp format for time columns
 * @param {object}        props.config              saved config (id, title)
 * @param {object}        props.dataCtx             { data, loading, error, isStreaming }
 */
export default function DataViewGrid({
  columnAliases = {},
  visibleColumnsConfig = null,
  xAxisFormat = 'short',
  config,
  dataCtx,
}) {
  // Per-user layout is keyed on the component id (from config, not the
  // descriptor — the descriptor's buildOption has no access to it).
  const chartId = config?.id || '';
  const data = dataCtx?.data;
  const loading = dataCtx?.loading;
  const error = dataCtx?.error;
  const isStreaming = dataCtx?.isStreaming;

  // Per-user layout override — order + widths layered on top of the
  // chart defaults. Returns the user's stored layout for this chart_id
  // and a saver to push changes back.
  const { layout: userLayout, saveLayout } = useDataviewLayout(chartId);

  const allColumns = (!loading && !error && data?.columns) || [];
  // Effective order: user's saved order if it covers the same columns,
  // else chart's visible_columns config, else all columns.
  const orderedColumns = (() => {
    const baseOrder = visibleColumnsConfig
      ? visibleColumnsConfig.filter((c) => allColumns.includes(c))
      : allColumns;
    if (userLayout?.order && Array.isArray(userLayout.order) && userLayout.order.length > 0) {
      const known = new Set(baseOrder);
      const fromUser = userLayout.order.filter((c) => known.has(c));
      const missing = baseOrder.filter((c) => !userLayout.order.includes(c));
      return [...fromUser, ...missing];
    }
    return baseOrder;
  })();

  const columnsKey = orderedColumns.join('|');
  // Row objects derived from the latest snapshot. Stable __id (content
  // hash + index) so AG Grid's filter, sort, menu state, and scroll
  // position survive streaming buffer slices.
  const latestRowObjs = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows.map((row, idx) => {
      const o = {};
      allColumns.forEach((c, i) => { o[c] = row[i]; });
      let h = 0;
      for (let i = 0; i < row.length; i++) {
        const s = row[i] == null ? '' : String(row[i]);
        for (let j = 0; j < s.length; j++) { h = ((h << 5) - h + s.charCodeAt(j)) | 0; }
      }
      o.__id = String(h) + '-' + idx;
      return o;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.rows, columnsKey]);

  // Grid mount strategy: feed only the first snapshot as rowData, then
  // switch to imperative applyTransaction() so the grid stays mounted
  // and open filter menus don't close on every streaming batch.
  const gridRef = useRef(null);
  const initialRowDataRef = useRef(null);
  if (initialRowDataRef.current === null && latestRowObjs.length > 0) {
    initialRowDataRef.current = latestRowObjs;
  }

  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api || latestRowObjs.length === 0) return;
    const existingIds = new Set();
    api.forEachNode((node) => { if (node.data?.__id) existingIds.add(node.data.__id); });
    const incomingIds = new Set(latestRowObjs.map((r) => r.__id));
    const toAdd = latestRowObjs.filter((r) => !existingIds.has(r.__id));
    const toRemove = [];
    api.forEachNode((node) => {
      if (node.data?.__id && !incomingIds.has(node.data.__id)) {
        toRemove.push(node.data);
      }
    });
    if (toAdd.length || toRemove.length) {
      api.applyTransaction({ add: toAdd, remove: toRemove });
    }
  }, [latestRowObjs]);

  const columnDefs = useMemo(() => {
    return orderedColumns.map((col) => {
      const isTimeCol = /time/i.test(col) || col === 'ts';
      const sampleVal = latestRowObjs[0]?.[col];
      const isNumCol = !isTimeCol && typeof sampleVal === 'number';
      // User-override widths (set by live drag-resize, persisted via
      // useDataviewLayout) take precedence over the grid's autosize.
      const userWidth = userLayout?.widths?.[col];
      // AG Grid's field prop treats dots as nested-path navigation
      // (data['cpu']['pct']), which silently empties columns whose names
      // literally contain dots (e.g. ts-store flat keys like 'cpu.pct').
      // Use a closure-captured valueGetter keyed on the literal name + an
      // explicit colId so reorder / resize state still persists by name.
      const colKey = col;
      const def = {
        colId: colKey,
        headerName: columnAliases[col] || col,
        valueGetter: (params) => params.data?.[colKey],
        sortable: true,
        resizable: true,
        filter: isNumCol ? 'agNumberColumnFilter' : (isTimeCol ? 'agDateColumnFilter' : 'agTextColumnFilter'),
        floatingFilter: false,
        valueFormatter: (params) => {
          const v = params.value;
          if (v == null) return '';
          const f = formatCellValue(v, col, { timestampFormat: xAxisFormat });
          return f == null ? '' : String(f);
        },
        minWidth: isNumCol ? 100 : (isTimeCol ? 170 : 120),
      };
      if (userWidth && userWidth > 0) {
        def.width = userWidth;
        def.flex = 0;
      }
      return def;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey, userLayout]);

  // No default flex — columns size to their content via the grid's
  // autoSizeStrategy=fitCellContents. A default flex=1 would cause AG Grid
  // to redistribute leftover row space evenly across columns, overriding
  // the autosize.
  const defaultColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    filter: true,
  }), []);

  // Persist user layout changes (resize + reorder) to app_config.
  // Debounced via the saver itself in useDataviewLayout.
  const handleColumnResized = (event) => {
    if (!event.finished || !event.column || !chartId) return;
    saveLayout((prev) => {
      const widths = { ...(prev?.widths || {}) };
      widths[event.column.getColId()] = event.column.getActualWidth();
      return { ...prev, widths };
    });
  };
  const handleColumnMoved = () => {
    if (!chartId) return;
    const api = gridRef.current?.api;
    if (!api) return;
    // colId is the canonical column identifier (field is used as a path
    // lookup, not a literal name).
    const ids = api.getColumnDefs().map((c) => c.colId || c.field);
    saveLayout((prev) => ({ ...prev, order: ids }));
  };

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>Loading...</div>;
  }
  if (error) {
    return <div style={{ color: '#da1e28', padding: '1rem' }}>Error: {error.message || String(error)}</div>;
  }
  if (!data?.rows?.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6f6f6f' }}>
        {isStreaming ? 'Waiting for data...' : 'No data'}
      </div>
    );
  }

  const title = config?.title || config?.name || '';
  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', backgroundColor: 'transparent', overflow: 'hidden' }}>
      {title ? (
        <div style={{
          display: 'block', height: '2.5rem', lineHeight: '2.5rem', flexShrink: 0,
          padding: '0 0.75rem', fontSize: '1rem', fontWeight: 600, color: 'var(--cds-text-primary)',
          textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {title}
        </div>
      ) : null}
      <div className="ag-theme-quartz-dark" style={{ flex: 1, minHeight: 0 }}>
        <AgGridReact
          ref={gridRef}
          theme="legacy"
          rowData={initialRowDataRef.current || []}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          autoSizeStrategy={{ type: 'fitCellContents' }}
          animateRows={false}
          suppressCellFocus
          getRowId={(params) => String(params.data.__id)}
          maintainColumnOrder
          onColumnResized={handleColumnResized}
          onColumnMoved={handleColumnMoved}
        />
      </div>
    </div>
  );
}
