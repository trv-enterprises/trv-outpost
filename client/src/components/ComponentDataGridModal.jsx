// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useContext, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Modal, Loading, InlineNotification } from '@carbon/react';
import { AgGridReact } from 'ag-grid-react';
import { DataContext } from './DynamicComponentLoader';
import { formatCellValue } from '../utils/dataTransforms';

/**
 * ComponentDataGridModal
 *
 * Shows the chart's underlying data as an AG Grid table. Reads the live
 * data from DataContext provided by DynamicComponentLoader — zero
 * duplicate streams, the modal sees exactly what the chart is rendering
 * because it IS a child of the chart's panel subtree.
 *
 * Must be mounted inside a DynamicComponentLoader's render tree (i.e.
 * inside the chart panel); otherwise DataContext is null and the modal
 * shows an empty-state notice.
 */
export default function ComponentDataGridModal({ open, chart, onClose, data: dataProp, loading: loadingProp, error: errorProp, hasData: hasDataProp }) {
  // Prefer data passed as props (captured by the caller INSIDE the
  // DataContext provider, where it's reliably available). Fall back to
  // reading context directly for any legacy caller. The prop path exists
  // because this modal portals to document.body (and Carbon's <Modal>
  // portals again); under React 19 a doubly-portaled subtree can read a
  // stale/empty DataContext even though the provider is an ancestor in the
  // virtual tree. Capturing in the parent and passing down sidesteps that.
  const ctx = useContext(DataContext);
  const hasCtx = hasDataProp !== undefined ? hasDataProp : ctx !== null;
  const data = dataProp !== undefined ? dataProp : ctx?.data;
  const loading = loadingProp !== undefined ? loadingProp : ctx?.loading;
  const error = errorProp !== undefined ? errorProp : ctx?.error;

  const columnAliases = chart?.data_mapping?.column_aliases || {};
  const visibleColumnsConfig = chart?.data_mapping?.visible_columns || null;
  // Honor the chart's x-axis time format for any timestamp column in
  // the table — without this, formatCellValue defaults to 'short'
  // (no seconds), which mismatches charts saved with chart_time_seconds
  // / chart_datetime_seconds. The data table should display time the
  // same way the chart does.
  const timestampFormat = chart?.data_mapping?.x_axis_format || 'short';

  const allColumns = data?.columns || [];
  // When the chart hasn't explicitly chosen a column order via
  // visible_columns, hoist the time + numeric-value columns to the
  // front — most data tables here are time-series, and the reader
  // wants `timestamp | value | …everything else…`. Especially matters
  // for Prometheus, where the adapter emits timestamp + value first
  // but then a long tail of label columns (instance, pod, namespace,
  // …) that the user may want to keep around for filters / series
  // grouping but shouldn't push the actual numeric value off-screen.
  // Other column order preserved after the two pinned columns.
  const orderedColumns = visibleColumnsConfig
    ? visibleColumnsConfig.filter((c) => allColumns.includes(c))
    : (() => {
        if (allColumns.length === 0) return allColumns;
        const tsExact = allColumns.indexOf('timestamp');
        const tsIdx = tsExact >= 0
          ? tsExact
          : allColumns.findIndex((c) => /^(time|ts)$|^time(stamp)?_?/i.test(c));
        const valExact = allColumns.indexOf('value');
        const valIdx = valExact >= 0
          ? valExact
          : allColumns.findIndex((c) => /^(value|val|y|metric_value|measurement)$/i.test(c));
        const pinned = [];
        if (tsIdx >= 0) pinned.push(allColumns[tsIdx]);
        if (valIdx >= 0 && valIdx !== tsIdx) pinned.push(allColumns[valIdx]);
        if (pinned.length === 0) return allColumns;
        const rest = allColumns.filter((c) => !pinned.includes(c));
        return [...pinned, ...rest];
      })();
  const columnsKey = orderedColumns.join('|');

  const latestRowObjs = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows.map((row, idx) => {
      const o = {};
      allColumns.forEach((c, i) => { o[c] = row[i]; });
      // Content-stable id so AG Grid filter/sort survive streaming updates.
      let h = 0;
      for (let i = 0; i < row.length; i++) {
        const s = row[i] == null ? '' : String(row[i]);
        for (let j = 0; j < s.length; j++) { h = ((h << 5) - h + s.charCodeAt(j)) | 0; }
      }
      o.__id = String(h) + '-' + idx;
      return o;
    });
  }, [data?.rows, columnsKey]);

  // Mirror the inline dataview: snapshot-on-open then imperative
  // applyTransaction so streaming updates don't close the filter menu.
  const gridRef = useRef(null);
  const initialRowDataRef = useRef(null);
  useEffect(() => {
    if (!open) {
      initialRowDataRef.current = null;
    }
  }, [open]);
  if (initialRowDataRef.current === null && latestRowObjs.length > 0) {
    initialRowDataRef.current = latestRowObjs;
  }

  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api || !open || latestRowObjs.length === 0) return;
    const existingIds = new Set();
    api.forEachNode((node) => { if (node.data?.__id) existingIds.add(node.data.__id); });
    const incomingIds = new Set(latestRowObjs.map((r) => r.__id));
    const toAdd = latestRowObjs.filter((r) => !existingIds.has(r.__id));
    const toRemove = [];
    api.forEachNode((node) => {
      if (node.data?.__id && !incomingIds.has(node.data.__id)) toRemove.push(node.data);
    });
    if (toAdd.length || toRemove.length) {
      api.applyTransaction({ add: toAdd, remove: toRemove });
    }
  }, [latestRowObjs, open]);

  const columnDefs = useMemo(() => {
    return orderedColumns.map((col) => {
      const isTimeCol = /time/i.test(col) || col === 'ts';
      const sampleVal = latestRowObjs[0]?.[col];
      const isNumCol = !isTimeCol && typeof sampleVal === 'number';
      // AG Grid's `field` prop treats dots as nested-path navigation
      // (data['cpu']['pct']), which silently empties columns whose
      // names literally contain dots (e.g. ts-store flat keys like
      // 'cpu.pct'). Use a closure-captured valueGetter keyed on the
      // literal name + an explicit colId so reorder / resize state
      // still persists by column name.
      const colKey = col;
      const headerLabel = columnAliases[col] || col;
      return {
        colId: colKey,
        headerName: headerLabel,
        // Wrap long header text onto multiple lines instead of
        // truncating. autoHeaderHeight (set on the grid) grows the
        // header row to match the tallest wrapped header.
        wrapHeaderText: true,
        autoHeaderHeight: true,
        valueGetter: (params) => params.data?.[colKey],
        sortable: true,
        resizable: true,
        filter: isNumCol
          ? 'agNumberColumnFilter'
          : isTimeCol
            ? 'agDateColumnFilter'
            : 'agTextColumnFilter',
        floatingFilter: false,
        valueFormatter: (params) => {
          const v = params.value;
          if (v == null) return '';
          const f = formatCellValue(v, col, { timestampFormat });
          return f == null ? '' : String(f);
        },
        // Cell tooltip — uses the formatted display value so the tooltip
        // matches what the user is looking at.
        tooltipValueGetter: (params) => {
          const v = params.value;
          if (v == null) return '';
          const f = formatCellValue(v, col, { timestampFormat });
          return f == null ? '' : String(f);
        },
        minWidth: isNumCol ? 100 : isTimeCol ? 170 : 120,
      };
    });
    // columnAliases intentionally excluded — it doesn't change during a
    // modal session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey, timestampFormat]);

  const defaultColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    filter: true,
    flex: 1,
  }), []);

  // Portal to document.body to escape the dashboard grid's CSS transform
  // (fit-to-screen `scale(...)` establishes a containing block for fixed
  // descendants, which would otherwise scale and clip the modal). React
  // context still flows through the virtual tree, so DataContext works.
  return createPortal(
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading={chart?.title || chart?.name || 'Chart Data'}
      passiveModal
      size="lg"
      className="chart-data-grid-modal"
    >
      <div style={{ height: '70vh', display: 'flex', flexDirection: 'column' }}>
        {!hasCtx && (
          <InlineNotification
            kind="warning"
            title="No data context"
            subtitle="This modal must be mounted inside a chart panel."
            lowContrast
            hideCloseButton
          />
        )}
        {hasCtx && loading && !data && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Loading description="Loading data..." withOverlay={false} />
          </div>
        )}
        {hasCtx && error && !data && (
          <InlineNotification
            kind="error"
            title="Data error"
            subtitle={error.message || 'Failed to load'}
            lowContrast
            hideCloseButton
          />
        )}
        {hasCtx && data && latestRowObjs.length === 0 && (
          <div style={{ color: '#6f6f6f', padding: '1rem', textAlign: 'center' }}>No data.</div>
        )}
        {hasCtx && data && latestRowObjs.length > 0 && (
          <div className="ag-theme-quartz-dark" style={{ flex: 1, minHeight: 0 }}>
            <AgGridReact
              ref={gridRef}
              theme="legacy"
              rowData={initialRowDataRef.current || []}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              animateRows={false}
              suppressCellFocus={true}
              getRowId={(params) => String(params.data.__id)}
              maintainColumnOrder={true}
              tooltipShowMode="whenTruncated"
            />
          </div>
        )}
      </div>
    </Modal>,
    document.body
  );
}
