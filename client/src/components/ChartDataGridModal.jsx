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
 * ChartDataGridModal
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
export default function ChartDataGridModal({ open, chart, onClose }) {
  const ctx = useContext(DataContext);
  const data = ctx?.data;
  const loading = ctx?.loading;
  const error = ctx?.error;

  const columnAliases = chart?.data_mapping?.column_aliases || {};
  const visibleColumnsConfig = chart?.data_mapping?.visible_columns || null;

  const allColumns = data?.columns || [];
  const orderedColumns = visibleColumnsConfig
    ? visibleColumnsConfig.filter((c) => allColumns.includes(c))
    : allColumns;
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
      return {
        field: col,
        headerName: columnAliases[col] || col,
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
          const f = formatCellValue(v, col);
          return f == null ? '' : String(f);
        },
        minWidth: isNumCol ? 100 : isTimeCol ? 170 : 120,
      };
    });
    // columnAliases intentionally excluded — it doesn't change during a
    // modal session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey]);

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
        {!ctx && (
          <InlineNotification
            kind="warning"
            title="No data context"
            subtitle="This modal must be mounted inside a chart panel."
            lowContrast
            hideCloseButton
          />
        )}
        {ctx && loading && !data && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Loading description="Loading data..." withOverlay={false} />
          </div>
        )}
        {ctx && error && !data && (
          <InlineNotification
            kind="error"
            title="Data error"
            subtitle={error.message || 'Failed to load'}
            lowContrast
            hideCloseButton
          />
        )}
        {ctx && data && latestRowObjs.length === 0 && (
          <div style={{ color: '#6f6f6f', padding: '1rem', textAlign: 'center' }}>No data.</div>
        )}
        {ctx && data && latestRowObjs.length > 0 && (
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
            />
          </div>
        )}
      </div>
    </Modal>,
    document.body
  );
}
