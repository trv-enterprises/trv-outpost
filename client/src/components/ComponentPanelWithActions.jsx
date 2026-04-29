// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useContext, useCallback, useRef } from 'react';
import html2canvas from 'html2canvas';
import { IconButton, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { DataTable, Download } from '@carbon/icons-react';
import DynamicComponentLoader, { DataContext } from './DynamicComponentLoader';
import ComponentDataGridModal from './ComponentDataGridModal';

/**
 * ComponentPanelWithActions
 *
 * Wraps DynamicComponentLoader with a small floating action row
 * (top-right of the panel) and the chart-data grid modal. The icon row
 * is hover-only so it doesn't clutter the panel in idle view mode, and
 * lives inside the DataContext provider so actions inherit the chart's
 * live data instead of opening a second stream.
 */
// Chart types where "view underlying data as a table" doesn't make sense.
// Gauges/numbers show a single aggregated value; a table of one cell is silly.
// Dataview is already a table — no reason to open a modal of the same thing.
// Doesn't affect the download menu — PNG/CSV/JSON stay available for these.
const SKIP_TABLE_MODAL_CHART_TYPES = new Set(['gauge', 'dataview', 'number']);

// Slugify chart name/title for filenames: "M-WS-Temp Over Time" → "m_ws_temp_over_time"
function filenameSlug(name) {
  return String(name || 'chart')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'chart';
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// RFC 4180 CSV escaping: wrap in quotes if it contains comma, quote, newline,
// or carriage return; double any internal quotes.
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function ChartPanelActions({ chart, onOpenModal, captureRef, showDataModalAction }) {
  const ctx = useContext(DataContext);
  const data = ctx?.data;
  const baseName = chart?.title || chart?.name || 'chart';

  // PNG of the live chart. Resolves ECharts canvas natively when present
  // (higher fidelity + respects devicePixelRatio), and falls back to
  // html2canvas for DOM-rendered charts (number, dataview, gauge-via-ECharts
  // takes the native path automatically).
  const exportPNG = useCallback(async () => {
    const root = captureRef?.current;
    if (!root) return;

    // ECharts renders to an inner <canvas>; when it exists and covers the
    // panel, reading its pixels directly beats rasterizing the DOM.
    const echartsCanvas = root.querySelector('.echarts-for-react canvas');
    if (echartsCanvas) {
      echartsCanvas.toBlob((blob) => {
        if (blob) triggerDownload(blob, `${filenameSlug(baseName)}.png`);
      }, 'image/png');
      return;
    }

    // DOM path: html2canvas. scale=2 for retina-quality output. The onclone
    // hook hides the hover action row (so the PNG doesn't include the
    // download icon itself) and strips CSS gradients that crash the library.
    try {
      const canvas = await html2canvas(root, {
        backgroundColor: '#161616',
        scale: 2,
        useCORS: true,
        allowTaint: true,
        onclone: (clonedDoc) => {
          clonedDoc.querySelectorAll('.chart-panel-actions').forEach((el) => { el.style.display = 'none'; });
          clonedDoc.querySelectorAll('*').forEach((el) => {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg.includes('gradient')) el.style.backgroundImage = 'none';
          });
        }
      });
      canvas.toBlob((blob) => {
        if (blob) triggerDownload(blob, `${filenameSlug(baseName)}.png`);
      }, 'image/png');
    } catch (err) {
      console.error('PNG export failed:', err);
    }
  }, [captureRef, baseName]);

  const exportCSV = useCallback((e) => {
    e.stopPropagation();
    if (!data?.columns || !data?.rows) return;
    const header = data.columns.map(csvEscape).join(',');
    const body = data.rows.map((row) => row.map(csvEscape).join(',')).join('\n');
    const csv = header + '\n' + body + '\n';
    triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${filenameSlug(baseName)}.csv`);
  }, [data, baseName]);

  const exportJSON = useCallback((e) => {
    e.stopPropagation();
    if (!data?.columns || !data?.rows) return;
    const rows = data.rows.map((row) => {
      const o = {};
      data.columns.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
    const json = JSON.stringify(rows, null, 2);
    triggerDownload(new Blob([json], { type: 'application/json' }), `${filenameSlug(baseName)}.json`);
  }, [data, baseName]);

  // CSV/JSON need real data. PNG just needs a rendered panel — the Download
  // menu itself stays enabled so users can always grab a screenshot, and
  // the data-dependent items are disabled individually.
  const canExportData = !!(data?.columns?.length && data?.rows?.length);

  return (
    <div className="chart-panel-actions">
      {showDataModalAction && (
        <IconButton
          kind="ghost"
          size="sm"
          label="View data as table"
          align="bottom-right"
          onClick={(e) => { e.stopPropagation(); onOpenModal(); }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <DataTable size={14} />
        </IconButton>
      )}
      <OverflowMenu
        renderIcon={() => <Download size={14} />}
        iconDescription="Download"
        size="sm"
        flipped
        align="bottom-right"
        onClick={(e) => e.stopPropagation?.()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <OverflowMenuItem itemText="Download as CSV" onClick={exportCSV} disabled={!canExportData} />
        <OverflowMenuItem itemText="Download as JSON" onClick={exportJSON} disabled={!canExportData} />
        <OverflowMenuItem itemText="Download as PNG" onClick={exportPNG} />
      </OverflowMenu>
    </div>
  );
}

export default function ComponentPanelWithActions({ chart, loaderProps }) {
  const [dataModalOpen, setDataModalOpen] = useState(false);
  const captureRef = useRef(null);
  const showDataModalAction = !!chart && !SKIP_TABLE_MODAL_CHART_TYPES.has(chart.chart_type);
  // Any chart gets PNG/export; only hide the whole action row if there's no
  // chart to act on at all.
  const showActions = !!chart;

  return (
    <div ref={captureRef} className="chart-panel-with-actions" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <DynamicComponentLoader {...loaderProps}>
        {showActions && (
          <>
            <ChartPanelActions
              chart={chart}
              onOpenModal={() => setDataModalOpen(true)}
              captureRef={captureRef}
              showDataModalAction={showDataModalAction}
            />
            {dataModalOpen && (
              <ComponentDataGridModal
                open={dataModalOpen}
                chart={chart}
                onClose={() => setDataModalOpen(false)}
              />
            )}
          </>
        )}
      </DynamicComponentLoader>
    </div>
  );
}
