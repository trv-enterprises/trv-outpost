// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * ValueTile — the reuse-me wrapper for custom-code single-value tiles.
 *
 * Custom component code that needs to show one big value (a
 * distinct-count, a derived stat, a status string, anything the
 * structured `value` chart can't express) should render THIS instead of
 * hand-rolling `<div style={{alignItems:'center'}}>...</div>`. It
 * delegates to the same <ValueView> the structured value chart uses, so
 * the value's alignment, title band, tabular-nums, theming, and value
 * formatting stay identical to a spec-driven value tile — and can never
 * drift out of sync when ValueView changes.
 *
 * It is exposed into the DynamicComponentLoader custom-code scope as
 * `ValueTile`, and also as `NumberTile` — the pre-rename name, kept as a
 * permanent alias so existing custom-code components keep working.
 * Minimal usage from custom code:
 *
 *     const Component = ({ data }) => {
 *       const n = new Set(toObjects(data).map(r => r.region)).size;
 *       return <ValueTile value={n} title="Regions" />;
 *     };
 *
 * @param {object} props
 * @param {number|string} props.value   raw value to render (number or string)
 * @param {string} [props.title]        centered title band ('' / omit to hide)
 * @param {string} [props.unit]         unit suffix (e.g. '%', '°C')
 * @param {number} [props.size]         value font size in px (default 64)
 * @param {string} [props.background]   tile fill color; the value's text color
 *                                      is paired from it automatically unless
 *                                      an explicit `color` is also given
 * @param {object} [props.options]      format options. Accepts the value
 *                                      chart's keys (valueFormat /
 *                                      valueDecimals / valueDateFormat) and
 *                                      the pre-rename number* names — when
 *                                      set, `value` is formatted the same
 *                                      way a structured value tile would.
 * @param {string} [props.valueName]    column-name hint for auto-formatting
 * @param {object} [props.dataCtx]      { loading, error } passthrough
 */
import ValueView from './ValueView';
import { formatNumberValue } from '../specs/number-formats.js';
import { contrastPartnerFor } from '../option-helpers';

export default function ValueTile({
  value,
  unit = '',
  size = 64,
  color = null,
  background = '',
  options = null,
  valueName = '',
  dataCtx = null,
}) {
  // The title band is NOT drawn here. For custom-code components the
  // DynamicComponentLoader already renders <ChartTitleBand> above the
  // component body (gated on use_custom_code) — drawing another title
  // inside would double it. So ValueTile draws ONLY the value and lets
  // ValueView center it in the body region the loader hands us.
  //
  // The loader's custom-title body sits BELOW the full 2.5rem band,
  // while a structured value tile centers below the title TEXT
  // (~1.6875rem). ValueView's `titleBottomOffset` reclaims that
  // difference so a custom tile's value lands at the same vertical
  // position as a spec-driven one sitting next to it.
  //
  // formatNumberValue keeps its numberX param names (it is the shared
  // cell formatter) — accept BOTH spellings from custom code and map.
  const formatted = options
    ? formatNumberValue(value, valueName, {
        numberFormat: options.valueFormat ?? options.numberFormat,
        numberDecimals: options.valueDecimals ?? options.numberDecimals,
        numberDateFormat: options.valueDateFormat ?? options.numberDateFormat,
      }, undefined)
    : (value == null ? '' : String(value));

  // An explicit `color` from custom code wins over the background's paired
  // text color — same precedence as a matched threshold on the structured
  // chart (see value.js): the pairing is the readable default, not an
  // override of what the author asked for.
  return (
    <ValueView
      formatted={formatted}
      unit={unit}
      size={size}
      color={color || (background ? contrastPartnerFor(background) : null)}
      background={background}
      title=""
      config={{ options: { showTitle: true } }}
      dataCtx={dataCtx}
      titleBottomOffset
    />
  );
}

/**
 * NumberTile — permanent compat alias for ValueTile.
 *
 * `NumberTile` is public API to user-authored custom-code components
 * (it was the injected name before the number → value rename), so it
 * stays exported and injected forever. New code should use ValueTile.
 */
export const NumberTile = ValueTile;
