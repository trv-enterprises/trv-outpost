// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * ValueView — the non-ECharts render for the `value` chart type.
 *
 * A single large value (numeric or text) + optional inline unit, with an
 * optional centered title. Deliberately plain DOM (not ECharts): crisp
 * text, tabular-nums, ellipsis, CSS-token theming. Supersedes the
 * retired `number` chart type's view.
 *
 * Receives the descriptor `props` from specs/value.js's buildOption,
 * plus the saved `config` (for the title) and `dataCtx` (loading/error/
 * no-data) so it owns its own chrome — the spec-driven shell does NOT
 * wrap non-ECharts views in ChartShell (their needs differ; see
 * docs/design-notes/spec-driven-non-echarts-views.md).
 *
 * @param {object} props
 * @param {string} props.formatted   pre-formatted value string ('' when no data)
 * @param {string} props.unit        optional unit suffix
 * @param {number} props.size        value font size in px
 * @param {string} [props.color]     threshold color; falsy = theme default
 * @param {string} props.title       centered title ('' to hide)
 * @param {object} config            saved config (options.showTitle gate)
 * @param {object} dataCtx           { loading, error } for placeholders
 * @param {boolean} titleBottomOffset  when true AND no internal title is
 *   drawn, pulls the value up by the title band's dead space so a custom
 *   tile (whose band was drawn by the loader above this view) aligns with
 *   a structured value tile. Used by ValueTile.
 */
export default function ValueView({ formatted, unit, size, color, title, config, dataCtx, titleBottomOffset = false }) {
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

  // Title sits absolutely at the top; the value centers in the space
  // between the BOTTOM OF THE TITLE TEXT and the bottom edge when a title
  // is shown, and in the full panel when it isn't.
  //
  // The title band is 2.5rem tall with the 0.875rem text vertically
  // centered in it (lineHeight === band height). So the text glyphs end
  // partway down the band, not at its bottom edge — the value should
  // center below the text, not below the whole band:
  //   textBottom = band/2 + textFontSize/2 = 1.25rem + 0.4375rem = 1.6875rem
  const titleBand = 'calc(2.5rem * var(--title-scale, 1))';
  const titleTextBottom = 'calc(1.6875rem * var(--title-scale, 1))';

  // titleBottomOffset: the caller (ValueTile via DynamicComponentLoader)
  // already rendered a full 2.5rem <ChartTitleBand> above this view and
  // handed us only the body BELOW it. A structured value tile instead
  // centers its value below the title TEXT (1.6875rem). To land the value
  // at the same height as a spec-driven tile beside it, pull the value
  // container UP by the band's dead space (2.5 − 1.6875 = 0.8125rem) so
  // its center matches. Only applies when we draw no internal title.
  const bodyTopPull = titleBottomOffset && !titleText
    ? 'calc(-0.8125rem * var(--title-scale, 1))'
    : 0;
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {titleText ? (
        // 2.5rem title band — matches ChartShell / DataViewGrid exactly so
        // a number tile's title sits at the same height as a chart's, and
        // the dashboard's has-title top-padding reclaim lines up. (Was a
        // 1.5-line-height overlay; bumped to the shared 2.5rem band.)
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          height: titleBand, lineHeight: titleBand,
          fontSize: 'calc(0.875rem * var(--title-scale, 1))', fontWeight: 600,
          color: 'var(--cds-text-primary)', textAlign: 'center',
          padding: '0 0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {titleText}
        </div>
      ) : null}
      <div style={{
        position: 'absolute', top: titleText ? titleTextBottom : bodyTopPull, left: 0, right: 0, bottom: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span
          // Stable hook so a surface without the desktop grid's scale transform
          // (the mobile viewer) can cap this otherwise-fixed px size with a
          // container-relative rule. The inline px below stays the default
          // everywhere else — desktop rendering is unchanged.
          // The legacy `number-view__value` class is kept alongside the new
          // name so any user CSS written against it still matches.
          className="value-view__value number-view__value"
          style={{
            fontSize: `${size}px`,
            fontWeight: 600,
            lineHeight: 1,
            // A threshold color overrides the default only when a rule
            // actually matched; otherwise stay on the theme token so an
            // un-thresholded tile still follows a theme switch.
            color: color || 'var(--cds-text-primary)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {formatted}
          {unit ? <span style={{ marginLeft: '0.25em' }}>{unit}</span> : null}
        </span>
      </div>
    </div>
  );
}
