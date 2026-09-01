// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * ChartTitleBand — the shared HTML title header rendered above a chart
 * canvas. Single source of truth for the title-band treatment so every
 * chart path renders an identical header instead of drifting:
 *
 *   - spec-driven charts (line/bar/area/gauge/...) via ChartShell, and
 *   - AI custom-code charts via DynamicComponentLoader.
 *
 * Rendered OUTSIDE ECharts so it centers on the full panel and never
 * collides with option.legend. Font AND spacing scale by --title-scale
 * (admin setting title_font_size, default 1) so the band always fits the
 * text. 0.875rem (14px) font base, shared with ValueView / DataViewGrid.
 *
 * The band is TOP-WEIGHTED: 0.75rem above the text, 0.25rem below. It used
 * to be a fixed 2.5rem with the text centred, which left equal ~12px gaps
 * above and below — and the lower one stacked on whatever the chart reserves
 * at its own top, reading as dead space between the title and the plot. The
 * datatable's `.chart-header` (DashboardGrid.scss) keeps the old 40px; the
 * two are mutually exclusive per panel, so they no longer need to match.
 *
 * Title is suppressible per-component via options.showTitle (default on).
 * Callers resolve the label (title || name) and pass it as `text`; an
 * empty/falsy `text` renders nothing so the chart body gets the full
 * panel height.
 *
 * @param {object} props
 * @param {string} [props.text]  The resolved title text. Falsy → renders null.
 */
export default function ChartTitleBand({ text }) {
  if (!text) return null;
  return (
    <div style={{
      display: 'block',
      flexShrink: 0,
      // Top-weighted, not centred. The band used to be a fixed 2.5rem with
      // `lineHeight === height`, which centres the text and therefore leaves
      // the SAME ~12px above and below it. The gap below then stacks on
      // whatever the chart reserves at its own top (an axis-name band, a
      // legend), reading as a large dead strip between the title and the plot
      // — on a 140px panel the title band alone was 29% of the height.
      //
      // Padding instead of a fixed height: the leading (0.75rem) is what sets
      // the distance from the panel's top edge and is UNCHANGED, while the
      // trailing (0.25rem) is trimmed. Net ~7px back to the chart at scale 1,
      // with the title sitting exactly where it did before.
      //
      // Everything still scales by --title-scale (admin title_font_size), so
      // the band grows and shrinks with the font as it always did.
      padding: 'calc(0.75rem * var(--title-scale, 1)) 0.75rem calc(0.25rem * var(--title-scale, 1))',
      lineHeight: 1.2,
      fontSize: 'calc(0.875rem * var(--title-scale, 1))',
      fontWeight: 600,
      color: 'var(--cds-text-primary)',
      textAlign: 'center',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}>
      {text}
    </div>
  );
}
