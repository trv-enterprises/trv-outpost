// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * NumberView — the non-ECharts render for the `number` chart type.
 *
 * A single large numeric value + optional inline unit, with an optional
 * centered title. Deliberately plain DOM (not ECharts): crisp text,
 * tabular-nums, ellipsis, CSS-token theming. Ported from the legacy
 * string-codegen `chartType === 'number'` branch in ComponentEditor.
 *
 * Receives the descriptor `props` from specs/number.js's buildOption,
 * plus the saved `config` (for the title) and `dataCtx` (loading/error/
 * no-data) so it owns its own chrome — the spec-driven shell does NOT
 * wrap non-ECharts views in ChartShell (their needs differ; see
 * docs/design-notes/spec-driven-non-echarts-views.md).
 *
 * @param {object} props
 * @param {string} props.formatted   pre-formatted value string ('' when no data)
 * @param {string} props.unit        optional unit suffix
 * @param {number} props.size        value font size in px
 * @param {string} props.title       centered title ('' to hide)
 * @param {object} config            saved config (options.showTitle gate)
 * @param {object} dataCtx           { loading, error } for placeholders
 */
export default function NumberView({ formatted, unit, size, title, config, dataCtx }) {
  // Title is suppressible per-component via options.showTitle (default
  // on) — same uniform guard as ChartShell / DataViewGrid. Off →
  // reclaim the title's vertical space (the value centers in the full
  // panel regardless, so nothing reflows).
  const showTitle = config?.options?.showTitle !== false;
  const titleText = showTitle ? title : '';
  if (dataCtx?.loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#c6c6c6' }}>
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

  // Title sits absolutely at the top; the value absolute-centers in the
  // full panel so its vertical position is independent of whether a
  // title is shown (swapping titled/untitled doesn't reflow the number).
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {titleText ? (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          fontSize: '1rem', lineHeight: 1.5, fontWeight: 600,
          color: 'var(--cds-text-primary)', textAlign: 'center',
          padding: '0 0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {titleText}
        </div>
      ) : null}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{
          fontSize: `${size}px`,
          fontWeight: 600,
          lineHeight: 1,
          color: 'var(--cds-text-primary)',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}>
          {formatted}
          {unit ? <span style={{ marginLeft: '0.25em' }}>{unit}</span> : null}
        </span>
      </div>
    </div>
  );
}
