// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * NumberTile — the reuse-me wrapper for custom-code number tiles.
 *
 * Custom component code that needs to show a single big number (a
 * distinct-count, a derived stat, anything the structured `number`
 * chart can't express) should render THIS instead of hand-rolling
 * `<div style={{alignItems:'center'}}>...</div>`. It delegates to the
 * same <NumberView> the structured number chart uses, so the value's
 * alignment, title band, tabular-nums, theming, and value formatting
 * stay identical to a spec-driven number tile — and can never drift
 * out of sync when NumberView changes.
 *
 * It is exposed into the DynamicComponentLoader custom-code scope as
 * `NumberTile`. Minimal usage from custom code:
 *
 *     const Component = ({ data }) => {
 *       const n = new Set(toObjects(data).map(r => r.region)).size;
 *       return <NumberTile value={n} title="Regions" />;
 *     };
 *
 * @param {object} props
 * @param {number|string} props.value   raw value to render (number or string)
 * @param {string} [props.title]        centered title band ('' / omit to hide)
 * @param {string} [props.unit]         unit suffix (e.g. '%', '°C')
 * @param {number} [props.size]         value font size in px (default 64)
 * @param {object} [props.options]      NumberView-style format options
 *                                      (numberFormat / numberDecimals /
 *                                      numberDateFormat) — when set, `value`
 *                                      is formatted the same way a structured
 *                                      number tile would format it.
 * @param {string} [props.valueName]    column-name hint for auto-formatting
 * @param {object} [props.dataCtx]      { loading, error } passthrough
 */
import NumberView from './NumberView';
import { formatNumberValue } from '../specs/number-formats.js';

export default function NumberTile({
  value,
  unit = '',
  size = 64,
  options = null,
  valueName = '',
  dataCtx = null,
}) {
  // The title band is NOT drawn here. For custom-code components the
  // DynamicComponentLoader already renders <ChartTitleBand> above the
  // component body (gated on use_custom_code) — drawing another title
  // inside would double it. So NumberTile draws ONLY the value and lets
  // NumberView center it in the body region the loader hands us.
  //
  // The loader's custom-title body sits BELOW the full 2.5rem band,
  // while a structured number tile centers below the title TEXT
  // (~1.6875rem). NumberView's `titleBottomOffset` reclaims that
  // difference so a custom tile's value lands at the same vertical
  // position as a spec-driven one sitting next to it.
  const formatted = options
    ? formatNumberValue(value, valueName, options, undefined)
    : (value == null ? '' : String(value));

  return (
    <NumberView
      formatted={formatted}
      unit={unit}
      size={size}
      title=""
      config={{ options: { showTitle: true } }}
      dataCtx={dataCtx}
      titleBottomOffset
    />
  );
}
