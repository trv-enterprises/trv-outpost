// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Per-series unit conversion (#265).
 *
 * A DIMENSION registry, not a from→to pair table. Every unit declares how
 * to get to and from its dimension's base unit, so a conversion is always
 * `fromBase(toBase(v))`. N units cost N entries instead of N².
 *
 * Critically, `toBase`/`fromBase` are arbitrary functions, not multipliers.
 * Temperature is AFFINE (ax + b), which is exactly why this cannot ride on
 * `sourceUnitScale()` in specs/number-formats.js — that returns a bare
 * scalar. Pressure/distance/mass are pure scalars and would fit either
 * model; temperature, the motivating case, does not.
 *
 * WHERE THIS APPLIES: charts convert on the DATA (specs/line.js, at the
 * same seam as the #8 accumulator), NOT at format time. A chart consumes
 * a number in four independent places — plotted geometry, axis min/max,
 * thresholds, and tooltip/labels. Converting at format time would move
 * only the tooltip, leaving a chart that plots Celsius, scales its axis in
 * Celsius, compares thresholds in Celsius, and prints "°F". Converting on
 * the data means everything downstream is correct with no extra plumbing.
 *
 * The value tile / data table (#243) keep their format-time
 * `valueSourceUnit` scaling — those surfaces have exactly one number and
 * formatting IS the render, so the two mechanisms are appropriate to
 * their surfaces rather than inconsistent.
 */

/**
 * Dimensions and their units. `base` names the unit all conversions pass
 * through. Each unit carries its `symbol`, which is the single source for
 * both the editor's inline badge and any auto unit-label — so a symbol is
 * never spelled twice.
 *
 * Adding a dimension is a data edit here; nothing else needs to change.
 */
export const UNIT_DIMENSIONS = {
  temperature: {
    label: 'Temperature',
    base: 'c',
    units: {
      c: { label: 'Celsius', symbol: '°C', toBase: (v) => v, fromBase: (v) => v },
      f: { label: 'Fahrenheit', symbol: '°F', toBase: (v) => (v - 32) * 5 / 9, fromBase: (v) => v * 9 / 5 + 32 },
      k: { label: 'Kelvin', symbol: 'K', toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
    },
  },
  pressure: {
    label: 'Pressure',
    base: 'pa',
    units: {
      pa: { label: 'Pascal', symbol: 'Pa', toBase: (v) => v, fromBase: (v) => v },
      hpa: { label: 'Hectopascal / millibar', symbol: 'hPa', toBase: (v) => v * 100, fromBase: (v) => v / 100 },
      kpa: { label: 'Kilopascal', symbol: 'kPa', toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
      bar: { label: 'Bar', symbol: 'bar', toBase: (v) => v * 100000, fromBase: (v) => v / 100000 },
      psi: { label: 'PSI', symbol: 'psi', toBase: (v) => v * 6894.757293168361, fromBase: (v) => v / 6894.757293168361 },
      inhg: { label: 'Inches of mercury', symbol: 'inHg', toBase: (v) => v * 3386.388640341, fromBase: (v) => v / 3386.388640341 },
    },
  },
  distance: {
    label: 'Distance',
    base: 'm',
    units: {
      mm: { label: 'Millimeter', symbol: 'mm', toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
      cm: { label: 'Centimeter', symbol: 'cm', toBase: (v) => v / 100, fromBase: (v) => v * 100 },
      m: { label: 'Meter', symbol: 'm', toBase: (v) => v, fromBase: (v) => v },
      km: { label: 'Kilometer', symbol: 'km', toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
      in: { label: 'Inch', symbol: 'in', toBase: (v) => v * 0.0254, fromBase: (v) => v / 0.0254 },
      ft: { label: 'Foot', symbol: 'ft', toBase: (v) => v * 0.3048, fromBase: (v) => v / 0.3048 },
      mi: { label: 'Mile', symbol: 'mi', toBase: (v) => v * 1609.344, fromBase: (v) => v / 1609.344 },
    },
  },
  mass: {
    label: 'Mass',
    base: 'kg',
    units: {
      g: { label: 'Gram', symbol: 'g', toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
      kg: { label: 'Kilogram', symbol: 'kg', toBase: (v) => v, fromBase: (v) => v },
      lb: { label: 'Pound', symbol: 'lb', toBase: (v) => v * 0.45359237, fromBase: (v) => v / 0.45359237 },
      oz: { label: 'Ounce', symbol: 'oz', toBase: (v) => v * 0.028349523125, fromBase: (v) => v / 0.028349523125 },
    },
  },
  speed: {
    label: 'Speed',
    base: 'mps',
    units: {
      mps: { label: 'Meters/second', symbol: 'm/s', toBase: (v) => v, fromBase: (v) => v },
      kph: { label: 'Kilometers/hour', symbol: 'km/h', toBase: (v) => v / 3.6, fromBase: (v) => v * 3.6 },
      mph: { label: 'Miles/hour', symbol: 'mph', toBase: (v) => v * 0.44704, fromBase: (v) => v / 0.44704 },
      kn: { label: 'Knots', symbol: 'kn', toBase: (v) => v * 0.514444, fromBase: (v) => v / 0.514444 },
    },
  },
};

/**
 * The `custom` pseudo-dimension: a plain affine transform the author
 * fills in (`value * scale + offset`) rather than picks from a table.
 *
 * This is deliberate scope control. A general derived-column feature
 * (issue #265 approach A) would need synthetic entries in every
 * `availableColumns` consumer, a dependency graph if columns can
 * reference each other, dangling-reference handling, and a two-step
 * stateful AI contract. `custom` covers every SINGLE-column transform
 * (×100 for a percentage, unit math the registry doesn't list) for
 * effectively zero extra machinery — it's the same affine code path the
 * registry already runs.
 *
 * The honest boundary is TWO-column arithmetic (`a - b`, `a / b`), which
 * this cannot express. That's a different feature — a new series, not a
 * per-series setting — and is the trigger for revisiting approach A.
 */
export const CUSTOM_DIMENSION = 'custom';

/** Is this a usable, fully-specified conversion? */
export function isValidConversion(convert) {
  if (!convert || typeof convert !== 'object') return false;
  const { dimension } = convert;
  if (dimension === CUSTOM_DIMENSION) {
    // A custom transform needs at least one of scale/offset to be a real
    // number, else it's an identity and not worth carrying on the record.
    const s = Number(convert.scale);
    const o = Number(convert.offset);
    const hasScale = Number.isFinite(s) && s !== 1;
    const hasOffset = Number.isFinite(o) && o !== 0;
    return hasScale || hasOffset;
  }
  const dim = UNIT_DIMENSIONS[dimension];
  if (!dim) return false;
  // from === to is a no-op; treat it as "not configured" so it doesn't
  // badge the row or get persisted.
  return Boolean(dim.units[convert.from]) && Boolean(dim.units[convert.to])
    && convert.from !== convert.to;
}

/**
 * The symbol shown inline on the series row and used as the auto unit
 * label — the TARGET unit's symbol. For `custom`, the author's optional
 * symbol, falling back to a compact rendering of the transform (e.g.
 * "×100") so the row still carries an answer rather than a generic glyph.
 *
 * Returns '' when there is no valid conversion.
 */
export function conversionSymbol(convert) {
  if (!isValidConversion(convert)) return '';
  if (convert.dimension === CUSTOM_DIMENSION) {
    if (typeof convert.symbol === 'string' && convert.symbol.trim()) return convert.symbol.trim();
    const s = Number(convert.scale);
    const o = Number(convert.offset);
    if (Number.isFinite(s) && s !== 1) return `×${s}`;
    if (Number.isFinite(o) && o !== 0) return o > 0 ? `+${o}` : String(o);
    return '';
  }
  return UNIT_DIMENSIONS[convert.dimension]?.units?.[convert.to]?.symbol || '';
}

/**
 * Human-readable description for tooltips / accessible labels, e.g.
 * "Celsius → Fahrenheit".
 */
export function conversionLabel(convert) {
  if (!isValidConversion(convert)) return '';
  if (convert.dimension === CUSTOM_DIMENSION) {
    const s = Number(convert.scale);
    const o = Number(convert.offset);
    const scale = Number.isFinite(s) ? s : 1;
    const offset = Number.isFinite(o) ? o : 0;
    const parts = [];
    if (scale !== 1) parts.push(`× ${scale}`);
    if (offset !== 0) parts.push(offset > 0 ? `+ ${offset}` : `− ${Math.abs(offset)}`);
    return `value ${parts.join(' ')}`.trim();
  }
  const dim = UNIT_DIMENSIONS[convert.dimension];
  return `${dim.units[convert.from].label} → ${dim.units[convert.to].label}`;
}

/**
 * Build the scalar conversion function for a `convert` descriptor, or
 * null when there's nothing to apply. Returned function is pointwise and
 * total: non-numeric input passes through untouched, so a null gap or a
 * text cell in an otherwise-numeric column is never turned into NaN.
 */
export function makeConverter(convert) {
  if (!isValidConversion(convert)) return null;

  let fn;
  if (convert.dimension === CUSTOM_DIMENSION) {
    const s = Number(convert.scale);
    const o = Number(convert.offset);
    const scale = Number.isFinite(s) ? s : 1;
    const offset = Number.isFinite(o) ? o : 0;
    fn = (n) => n * scale + offset;
  } else {
    const dim = UNIT_DIMENSIONS[convert.dimension];
    const from = dim.units[convert.from];
    const to = dim.units[convert.to];
    fn = (n) => to.fromBase(from.toBase(n));
  }

  return (raw) => {
    if (raw == null) return raw;
    // Numeric strings convert too — a JSON/CSV connection can deliver
    // "21.5" and the chart is expected to plot it. Anything genuinely
    // non-numeric passes through untouched.
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return raw;
    return fn(n);
  };
}

/**
 * Apply a conversion across a series' data array. Returns the input array
 * unchanged (same reference) when there's nothing to convert, so callers
 * pay nothing for the common unconfigured case.
 */
export function applyConversion(data, convert) {
  const convertFn = makeConverter(convert);
  if (!convertFn || !Array.isArray(data)) return data;
  return data.map(convertFn);
}

/**
 * Normalize a stored/loose `convert` value into the canonical shape, or
 * null when it isn't a usable conversion. Used by the read path so an
 * absent, partial, or stale descriptor never reaches the converter.
 */
export function normalizeConversion(convert) {
  if (!isValidConversion(convert)) return null;
  if (convert.dimension === CUSTOM_DIMENSION) {
    const s = Number(convert.scale);
    const o = Number(convert.offset);
    const out = {
      dimension: CUSTOM_DIMENSION,
      scale: Number.isFinite(s) ? s : 1,
      offset: Number.isFinite(o) ? o : 0,
    };
    if (typeof convert.symbol === 'string' && convert.symbol.trim()) out.symbol = convert.symbol.trim();
    return out;
  }
  return { dimension: convert.dimension, from: convert.from, to: convert.to };
}

/**
 * All target symbols in play across a set of y-axis entries, deduped.
 * One entry → that's the chart's unit and can safely default the tooltip
 * unit label. More than one → the chart genuinely mixes units (legitimate
 * on dual-axis, nonsense on single) and nothing should be auto-labelled.
 */
export function distinctConversionSymbols(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const sym = conversionSymbol(e?.convert);
    if (sym && !out.includes(sym)) out.push(sym);
  }
  return out;
}
