// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import ReactECharts from 'echarts-for-react';
// Side-effect import: registers 'carbon-dark'/'carbon-light' with ECharts.
// Without it the theme={carbon-dark} below silently resolves to ECharts'
// built-in LIGHT theme — a light tooltip on a dark dashboard, and no
// tooltip.appendToBody (so tooltips get clipped by the panel and pushed
// off-screen). See theme/registerEchartsThemes.js.
import '../theme/registerEchartsThemes';
import ChartTitleBand from './ChartTitleBand';
import { registerTooltipOwner, claimTooltip, releaseTooltip, hideAllTooltips } from './tooltip-broker';

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
  const echartsRef = useRef(null);

  // Dismiss the tooltip. ECharts alone does not, in three situations that
  // all show up on a multi-panel dashboard:
  //
  //  1. POINTER LEAVES THE CHART. ECharts only calls its internal _hide()
  //     from a mousemove INSIDE the chart that lands on nothing. Move the
  //     cursor clean off — to another panel, or the toolbar — and no such
  //     event fires. Its own `globalout` covers this, but only when zrender
  //     actually sees the canvas mouseout, which is not reliable once the
  //     tooltip div (appendToBody) is sitting over the page.
  //  2. THE POINTER MOVES TO ANOTHER CHART. Each chart owns its OWN tooltip
  //     div appended to <body>, so nothing coordinates them: the first
  //     chart's box can stay up while a second chart shows its own.
  //  3. SCROLL. No mouse event is generated at all, so the tooltip stays
  //     pinned to a screen position while the chart it belongs to scrolls
  //     away underneath it.
  //
  // appendToBody is what makes all three visible (the box floats over the
  // whole page rather than being clipped to its panel) — but we need it, or
  // the tooltip is clipped by the panel's overflow:hidden.
  //
  // So dismiss from the DOM, where every one of these IS observable:
  // pointerleave on our own wrapper for (1) and (2), and a capturing scroll
  // listener for (3). hideTip is a no-op when nothing is showing, so firing
  // it unconditionally is safe.
  const hideTip = useCallback(() => {
    echartsRef.current?.getEchartsInstance?.()?.dispatchAction?.({ type: 'hideTip' });
  }, []);

  // Join the one-tooltip-at-a-time broker. Per-chart pointerleave (below)
  // handles the ordinary case, but it RACES: if the next chart's tooltip
  // renders before this chart's leave handler runs, both are briefly up, and
  // a fast move between panels can skip the leave entirely. The broker makes
  // it explicit — whichever chart shows a tooltip tells every other chart to
  // hide. Unregister on unmount so a hider never outlives its instance.
  useEffect(() => registerTooltipOwner(hideTip), [hideTip]);

  // Scroll listener: unconditional, so it survives the loading/error early
  // returns (this component renders a placeholder before the chart exists).
  // Capture phase because the dashboard grid — not the window — is what
  // scrolls, and scroll events from an inner scroller do NOT bubble.
  // hideAllTooltips (not just ours): one scroll should clear the page.
  useEffect(() => {
    window.addEventListener('scroll', hideAllTooltips, true);
    return () => window.removeEventListener('scroll', hideAllTooltips, true);
  }, []);

  // Claim the tooltip on entry/movement — this is what actually dismisses the
  // PREVIOUS chart's box, and it does not depend on the old chart having seen
  // a leave event.
  const claim = useCallback(() => claimTooltip(hideTip), [hideTip]);
  const leave = useCallback(() => {
    releaseTooltip(hideTip);
    hideTip();
  }, [hideTip]);

  // ECharts' own "pointer left the instance" event, kept as a belt-and-braces
  // partner to the DOM listeners above. Merged with (not replacing) any
  // caller-supplied handlers, and the caller's own globalout still runs.
  const mergedEvents = useMemo(() => ({
    ...(onEvents || {}),
    globalout: (params, instance) => {
      hideTip();
      onEvents?.globalout?.(params, instance);
    },
  }), [onEvents, hideTip]);

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
  // ValueView / DataViewGrid.
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

  return (
    // onPointerLeave (a React prop, not a ref+effect) so it binds to whatever
    // is rendered without depending on ref timing across the early returns.
    <div
      onPointerEnter={claim}
      onPointerMove={claim}
      onPointerLeave={leave}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <ChartTitleBand text={chartName} />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactECharts
          ref={echartsRef}
          option={renderOption}
          style={{ height: '100%', width: '100%' }}
          theme="carbon-dark"
          onEvents={mergedEvents}
        />
      </div>
    </div>
  );
}
