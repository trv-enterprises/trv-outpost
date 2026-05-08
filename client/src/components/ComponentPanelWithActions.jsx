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
// Number tiles show a single aggregated value, dataview is already a
// table — no reason to open a modal of the same thing. Gauges DO benefit
// (gauge value comes from a row, but the underlying stream is a series
// the user often wants to inspect).
// Doesn't affect the download menu — PNG/CSV/JSON stay available for these.
const SKIP_TABLE_MODAL_CHART_TYPES = new Set(['dataview', 'number']);

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

  // PNG of the live chart. Three cases, in order:
  //   1. No ECharts canvas in panel → html2canvas the DOM (e.g. dataview).
  //   2. ECharts canvas covers the whole panel → read its pixels directly.
  //   3. ECharts canvas + a sibling title strip → composite: draw the
  //      title onto a Canvas 2D with native fillText (NOT html2canvas —
  //      its text shaper stretches single-line titles to fill the
  //      container width), then stack the chart canvas underneath.
  const exportPNG = useCallback(async () => {
    const root = captureRef?.current;
    if (!root) return;

    const echartsCanvas = root.querySelector('.echarts-for-react canvas');

    // Find the title element rendered above the ECharts canvas. The
    // generator emits something like:
    //   <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    //     <div style={{ ...title... }}>{name}</div>
    //     <div style={{ flex: 1 }}><ReactECharts /></div>
    //   </div>
    // Live DOM nesting is unpredictable (DynamicComponentLoader, error
    // boundaries, etc.), so don't rely on root.children[0]. Instead,
    // walk the canvas's ancestors and find the previous sibling with
    // text content at any level. That sibling IS the title bar.
    const findTitleEl = () => {
      if (!echartsCanvas) return null;
      let node = echartsCanvas.closest('.echarts-for-react') || echartsCanvas;
      while (node && node !== root) {
        let sib = node.previousElementSibling;
        while (sib) {
          if (sib instanceof HTMLElement && !sib.classList.contains('chart-panel-actions')) {
            const txt = (sib.textContent || '').trim();
            if (txt && !sib.querySelector('canvas')) return sib;
          }
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
      }
      return null;
    };

    if (echartsCanvas) {
      const rootRect = root.getBoundingClientRect();
      const canvasContainer = echartsCanvas.closest('.echarts-for-react') || echartsCanvas.parentElement;
      const containerRect = canvasContainer?.getBoundingClientRect();
      const canvasCoversRoot = containerRect &&
        Math.abs(rootRect.height - containerRect.height) < 6 &&
        Math.abs(rootRect.width  - containerRect.width)  < 6;

      if (canvasCoversRoot) {
        // ECharts is the entire panel — read its pixels directly.
        echartsCanvas.toBlob((blob) => {
          if (blob) triggerDownload(blob, `${filenameSlug(baseName)}.png`);
        }, 'image/png');
        return;
      }

      // Composite path. Read the title text + style off the live DOM,
      // draw it ourselves with Canvas 2D, then stack the chart canvas.
      const titleEl = findTitleEl();
      const titleText = (titleEl?.textContent || chart?.title || chart?.name || '').trim();

      let titleHeight = 0;
      let fontPx = 16;
      let fontWeight = '600';
      let fontFamily = 'sans-serif';
      let titleColor = '#f4f4f4';
      if (titleEl && titleText) {
        const cs = getComputedStyle(titleEl);
        titleHeight = Math.round(titleEl.getBoundingClientRect().height) || 40;
        const parsedPx = parseFloat(cs.fontSize);
        if (parsedPx) fontPx = parsedPx;
        fontWeight = cs.fontWeight || '600';
        fontFamily = cs.fontFamily || 'sans-serif';
        titleColor = cs.color || titleColor;
      }

      const dpr = window.devicePixelRatio || 1;
      const scale = Math.max(2, dpr); // retina output
      const canvasCssWidth = Math.round(containerRect?.width || rootRect.width);
      const canvasCssHeight = Math.round(containerRect?.height || (rootRect.height - titleHeight));

      const outW = Math.round(canvasCssWidth * scale);
      const outH = Math.round((titleHeight + canvasCssHeight) * scale);

      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const ctx2d = out.getContext('2d');
      // Background — match panel background.
      ctx2d.fillStyle = '#161616';
      ctx2d.fillRect(0, 0, outW, outH);

      if (titleText && titleHeight > 0) {
        // Native fillText — single text run, no shaper layout pass.
        ctx2d.fillStyle = titleColor;
        ctx2d.font = `${fontWeight} ${fontPx * scale}px ${fontFamily}`;
        ctx2d.textBaseline = 'middle';
        ctx2d.textAlign = 'center';
        ctx2d.fillText(titleText, outW / 2, (titleHeight * scale) / 2);
      }

      // Stack the ECharts canvas under the title. drawImage scales from
      // the source canvas's actual pixel dimensions to our retina output.
      ctx2d.drawImage(
        echartsCanvas,
        0, titleHeight * scale,
        canvasCssWidth * scale, canvasCssHeight * scale,
      );

      out.toBlob((blob) => {
        if (blob) triggerDownload(blob, `${filenameSlug(baseName)}.png`);
      }, 'image/png');
      return;
    }

    // No canvas at all — html2canvas the DOM (dataview, etc.).
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
  }, [captureRef, baseName, chart]);

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
