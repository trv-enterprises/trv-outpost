// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { useDataviewLayout } from '../../hooks/useDataviewLayout';
import { formatCellValue } from '../../utils/dataTransforms';
import { formatNumberValue } from '../specs/number-formats';

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
 * @param {object}        props.columnWidths        { col → px } author-set default widths
 * @param {object}        props.columnFormats       { col → value format } — 'compact' (SI, 127G),
 *                                                  'duration', 'duration_clock', 'plain'; missing/'auto' = default
 * @param {string[]|null} props.visibleColumnsConfig ordered whitelist, or null = show all
 * @param {string}        props.xAxisFormat         timestamp format for time columns
 * @param {object}        props.config              saved config (id, title)
 * @param {object}        props.dataCtx             { data, loading, error, isStreaming }
 */
export default function DataViewGrid({
  columnAliases = {},
  columnWidths = {},
  columnFormats = {},
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
  // Stable signature of the author width map so columnDefs re-derive when the
  // editor changes a width (object identity alone wouldn't be a safe dep).
  const columnWidthsKey = Object.entries(columnWidths || {})
    .map(([c, w]) => `${c}:${w}`)
    .sort()
    .join('|');
  // Same stable-signature treatment for the author format map.
  const columnFormatsKey = Object.entries(columnFormats || {})
    .map(([c, f]) => `${c}:${f}`)
    .sort()
    .join('|');
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
      // Width precedence: a viewer's live drag-resize (per-user, via
      // useDataviewLayout) wins; else the author-set config width; else the
      // grid's content autosize. EXCEPT: when the author has since CHANGED the
      // config width for this column, the stale per-user drag is discarded so
      // the new author value shows. We detect that by comparing the author
      // width the user override was captured against (userLayout.widthBase)
      // with the current author width — a mismatch means the author re-pinned.
      const authorWidth = Number(columnWidths?.[col]);
      const userWidthRaw = userLayout?.widths?.[col];
      const userBase = userLayout?.widthBase?.[col];
      const authorChangedSinceDrag =
        (Number.isFinite(authorWidth) && authorWidth > 0) &&
        Number(userBase || 0) !== authorWidth;
      const userWidth = authorChangedSinceDrag ? undefined : userWidthRaw;
      // AG Grid's field prop treats dots as nested-path navigation
      // (data['cpu']['pct']), which silently empties columns whose names
      // literally contain dots (e.g. ts-store flat keys like 'cpu.pct').
      // Use a closure-captured valueGetter keyed on the literal name + an
      // explicit colId so reorder / resize state still persists by name.
      const colKey = col;
      // Resolved explicit width: viewer drag-resize wins, else author config.
      const resolvedWidth = (userWidth && userWidth > 0)
        ? userWidth
        : (Number.isFinite(authorWidth) && authorWidth > 0 ? authorWidth : 0);
      // Default content floor for unsized columns. When a column IS explicitly
      // sized, honor a small value by dropping the floor to it (AG Grid still
      // enforces its own hard ~10px minimum), so "20" doesn't silently snap to
      // the 120 text-column default.
      const defaultFloor = isNumCol ? 100 : (isTimeCol ? 170 : 120);
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
          // Author-set per-column format (compact SI / duration / plain)
          // wins over the default cell formatter. Same vocabulary as the
          // number tile — formatNumberValue handles the non-numeric
          // fallback itself.
          const colFmt = columnFormats[col];
          if (colFmt && colFmt !== 'auto') {
            const f = formatNumberValue(v, col, { numberFormat: colFmt, numberDecimals: 'auto' }, formatCellValue);
            return f == null ? '' : String(f);
          }
          const f = formatCellValue(v, col, { timestampFormat: xAxisFormat, strictTimestampNames: true });
          return f == null ? '' : String(f);
        },
        minWidth: resolvedWidth > 0 ? Math.min(defaultFloor, resolvedWidth) : defaultFloor,
      };
      if (resolvedWidth > 0) {
        def.width = resolvedWidth;
        def.flex = 0;
        def.suppressSizeToFit = true;
      }
      return def;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey, userLayout, columnWidthsKey, columnFormatsKey]);

  // Columns WITHOUT an explicit width — the only ones fitCellContents should
  // auto-size. A column with an author/user width must keep its def.width, but
  // autoSizeStrategy=fitCellContents runs on data render and, unrestricted,
  // re-sizes every column to its content — so after the grid mounts the width
  // field looked like it stopped working (the wide `msg` cell won). Restricting
  // the strategy's colIds to unsized columns lets the explicit widths stick.
  const autoSizeColIds = useMemo(() => {
    return orderedColumns.filter((col) => {
      const uw = userLayout?.widths?.[col];
      const aw = Number(columnWidths?.[col]);
      const hasWidth = (uw && uw > 0) || (Number.isFinite(aw) && aw > 0);
      return !hasWidth;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey, userLayout, columnWidthsKey]);

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
  //
  // ONLY persist a genuine user drag (source 'uiColumnResized'). AG Grid also
  // fires columnResized for programmatic width changes — applying our author
  // `def.width` from columnDefs comes through as source 'api'/'flex'/'autosize'.
  // Without this guard, the author width gets written into the per-user widths
  // store, which is a columnDefs dep, so the grid re-derives → re-applies →
  // fires again: a width-jitter feedback loop in view mode.
  const handleColumnResized = (event) => {
    if (!event.finished || !event.column || !chartId) return;
    if (event.source !== 'uiColumnResized') return;
    const colId = event.column.getColId();
    saveLayout((prev) => {
      const widths = { ...(prev?.widths || {}) };
      widths[colId] = event.column.getActualWidth();
      // Record the author width this drag was made against, so a LATER author
      // change to that column's config width invalidates this override (the
      // author's re-pin wins). 0 = no author width at drag time.
      const widthBase = { ...(prev?.widthBase || {}) };
      widthBase[colId] = Number(columnWidths?.[colId]) || 0;
      return { ...prev, widths, widthBase };
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

  // Title suppressible per-component via options.showTitle (default on)
  // — same uniform guard as ChartShell / ValueView. Off → the grid gets
  // the full panel height.
  const showTitle = config?.options?.showTitle !== false;
  const title = showTitle ? (config?.title || config?.name || '') : '';
  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', backgroundColor: 'transparent', overflow: 'hidden' }}>
      {title ? (
        // Title band — scales by --title-scale (font + height), shared
        // 2.5rem base with ChartShell / ValueView.
        <div style={{
          display: 'block', height: 'calc(2.5rem * var(--title-scale, 1))', lineHeight: 'calc(2.5rem * var(--title-scale, 1))', flexShrink: 0,
          padding: '0 0.75rem', fontSize: 'calc(0.875rem * var(--title-scale, 1))', fontWeight: 600, color: 'var(--cds-text-primary)',
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
          // Only auto-size columns that have NO explicit width, so author/user
          // widths aren't clobbered by fitCellContents on data render. When
          // every column is explicitly sized, omit the strategy entirely.
          autoSizeStrategy={autoSizeColIds.length > 0
            ? { type: 'fitCellContents', colIds: autoSizeColIds }
            : undefined}
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
