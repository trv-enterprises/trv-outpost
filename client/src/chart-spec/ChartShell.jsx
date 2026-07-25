// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useRef, useState, useCallback } from 'react';
import ReactECharts from 'echarts-for-react';
import ChartTitleBand from './ChartTitleBand';
import { horizontalBarCategoryCount, fitLabelFont } from './label-fit';

/**
 * Generic chart shell — the React/DOM layer shared by every spec-driven
 * chart (line/bar/area/gauge/...) AND, eventually, AI custom-code charts.
 *
 * Owns the cross-chart treatments that are NOT part of the ECharts
 * option literal:
 *   - the HTML title header (rendered outside ECharts so it centers on
 *     the full panel and never collides with option.legend — the
 *     convention legacy line/area/bar codegen established).
 *   - loading / error / no-data placeholders.
 *   - the flex column wrapper that gives ECharts a sized child.
 *   - the carbon-dark theme + onEvents passthrough.
 *
 * Per-chart-type code only produces the `option` literal (via its
 * buildOption) and hands it here. Title rendering is unified by
 * construction — gauge and line get the identical header treatment
 * instead of each drifting (the old gauge string-emitter put the title
 * inside option.title; line put it in an HTML div — ChartShell ends
 * that split).
 *
 * @param {object}   props
 * @param {object}   props.config        Saved component config ({title, name, ...}).
 * @param {object}   props.dataCtx       DataContext value ({data, loading, error}).
 * @param {object}   props.option        The ECharts option literal (null → misconfigured).
 * @param {object}   [props.onEvents]    ECharts event handlers passthrough.
 * @param {string}   [props.misconfiguredMessage]  Shown when option is null.
 */
export default function ChartShell({ config, dataCtx, option, onEvents, misconfiguredMessage }) {
  // Tracks whether the chart canvas has rendered at least once (past the
  // loading/error/no-data early returns). Used to preserve the user's
  // zoom/pan across data updates — see the dataZoom handling at the
  // ReactECharts render below.
  const chartPaintedRef = useRef(false);

  // Measured height of the chart body (the flex child ECharts fills), for
  // fitting horizontal-bar category-label fonts to the real panel height.
  // A CALLBACK ref (not useRef + effect) because the body div mounts only
  // AFTER the loading/no-data early returns clear — a []-dep effect would
  // run once on the FIRST commit (often the "Loading..." branch, where the
  // body div doesn't exist) and never re-attach. The callback ref fires
  // exactly when the real node attaches, whenever that happens.
  const [bodyHeight, setBodyHeight] = useState(0);
  const roRef = useRef(null);
  const bodyRef = useCallback((el) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect?.height;
      if (h) setBodyHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    });
    ro.observe(el);
    roRef.current = ro;
    // Seed immediately so the first paint doesn't wait for the observer.
    const h = el.getBoundingClientRect?.().height;
    if (h) setBodyHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
  }, []);

  if (dataCtx?.loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        Loading...
      </div>
    );
  }
  if (dataCtx?.error) {
    return (
      <div style={{ color: '#da1e28', padding: '1rem' }}>
        Error: {dataCtx.error.message || String(dataCtx.error)}
      </div>
    );
  }
  if (!dataCtx?.data?.rows?.length) {
    return (
      <div style={{ color: '#6f6f6f', padding: '1rem' }}>
        No data
      </div>
    );
  }
  if (!option) {
    return (
      <div style={{ color: '#da1e28', padding: '1rem' }}>
        {misconfiguredMessage || 'Chart misconfigured.'}
      </div>
    );
  }

  // Title is suppressible per-component via options.showTitle (default
  // on). Off → don't render the header band at all, so the chart body
  // gets the full panel height (use a Text panel for a custom/giant
  // title). Uniform across every chart type — see the same guard in
  // NumberView / DataViewGrid.
  const showTitle = config?.options?.showTitle !== false;
  const chartName = showTitle ? (config?.title || config?.name || '') : '';

  // Zoom-preservation: on the FIRST canvas paint, pass the option as-is
  // (its dataZoom carries the full-range start/end default). On every
  // SUBSEQUENT render — e.g. a streaming point arriving — drop
  // start/end from dataZoom so echarts-for-react's merge keeps the
  // user's current zoom window instead of snapping it back. Clone
  // shallowly so we never mutate the caller's option object.
  let renderOption = option;
  if (chartPaintedRef.current && Array.isArray(option.dataZoom)) {
    renderOption = {
      ...option,
      dataZoom: option.dataZoom.map((dz) => {
        const next = { ...dz };
        delete next.start;
        delete next.end;
        return next;
      }),
    };
  }
  chartPaintedRef.current = true;

  // Horizontal-bar category-label fit: size the label font to the measured
  // plot height so every category shows on its own row (centered on its
  // bar) instead of ECharts thinning or packing them. Only touches the
  // y-axis label fontSize, and only for that chart shape. Uses the plot
  // height minus a rough x-axis-label + grid budget (~34px) as the band
  // the category rows occupy. Skipped until the first measurement lands.
  const catCount = horizontalBarCategoryCount(renderOption);
  if (catCount > 0 && bodyHeight > 0) {
    const plotPx = Math.max(0, bodyHeight - 34);
    const fit = fitLabelFont(catCount, plotPx);
    if (fit != null) {
      const yAxis = Array.isArray(renderOption.yAxis) ? renderOption.yAxis[0] : renderOption.yAxis;
      const axisLabel = { ...(yAxis.axisLabel || {}), fontSize: fit.fontSize };
      // Force every label ONLY when they fit at the chosen font — then
      // interval:0 shows them all without overlap. When they don't fit,
      // leave interval unset so ECharts thins (readable subset) rather
      // than packing every label at the top.
      if (fit.fits) axisLabel.interval = 0;
      const nextYAxis = { ...yAxis, axisLabel };
      renderOption = {
        ...renderOption,
        yAxis: Array.isArray(renderOption.yAxis)
          ? [nextYAxis, ...renderOption.yAxis.slice(1)]
          : nextYAxis,
      };
    }
  }

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ChartTitleBand text={chartName} />
      <div ref={bodyRef} style={{ flex: 1, minHeight: 0 }}>
        <ReactECharts
          option={renderOption}
          style={{ height: '100%', width: '100%' }}
          theme="carbon-dark"
          onEvents={onEvents}
        />
      </div>
    </div>
  );
}
