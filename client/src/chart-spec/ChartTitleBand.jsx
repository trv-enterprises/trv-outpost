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
 * collides with option.legend. Font AND height scale by --title-scale
 * (admin setting title_font_size, default 1) so the band always fits the
 * text. 2.5rem band base + 0.875rem (14px) font base, shared with
 * ValueView / DataViewGrid.
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
      height: 'calc(2.5rem * var(--title-scale, 1))',
      lineHeight: 'calc(2.5rem * var(--title-scale, 1))',
      flexShrink: 0,
      padding: '0 0.75rem',
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
