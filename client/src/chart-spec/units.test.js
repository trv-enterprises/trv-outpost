// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Pins the per-series unit conversion registry (#265).
//
// The load-bearing property is that conversions go through a per-dimension
// BASE unit via toBase/fromBase FUNCTIONS, not a multiplier table. That's
// what makes temperature (affine, ax + b) work at all — the pre-existing
// `sourceUnitScale` returns a bare scalar and cannot express °C → °F.
// Several tests below exist specifically to fail if someone ever
// "simplifies" this back into a multiply-only model.

import { describe, it, expect } from 'vitest';
import {
  makeConverter,
  applyConversion,
  isValidConversion,
  normalizeConversion,
  conversionSymbol,
  conversionLabel,
  distinctConversionSymbols,
  UNIT_DIMENSIONS,
  CUSTOM_DIMENSION,
} from './units';

const conv = (dimension, from, to) => makeConverter({ dimension, from, to });

describe('temperature (affine)', () => {
  const c2f = conv('temperature', 'c', 'f');

  it('converts the freezing/boiling anchors', () => {
    expect(c2f(0)).toBe(32);
    expect(c2f(100)).toBe(212);
  });

  it('is affine, not multiplicative — the offset is not dropped', () => {
    // The whole reason this can't ride on sourceUnitScale: a pure
    // multiplier would give 0 here, not 32.
    expect(c2f(0)).not.toBe(0);
    // And a 1° rise is 1.8°F, NOT 33.8°F — the offset applies once.
    expect(c2f(1) - c2f(0)).toBeCloseTo(1.8, 10);
  });

  it('round-trips within float tolerance', () => {
    const f2c = conv('temperature', 'f', 'c');
    expect(f2c(c2f(21.5))).toBeCloseTo(21.5, 10);
  });

  it('routes non-base pairs through the base unit', () => {
    // K → F never appears as an explicit pair in the registry; it works
    // only because both units define toBase/fromBase against Celsius.
    expect(conv('temperature', 'k', 'f')(273.15)).toBeCloseTo(32, 10);
    expect(conv('temperature', 'f', 'k')(32)).toBeCloseTo(273.15, 10);
  });
});

describe('scalar dimensions', () => {
  it('converts pressure, distance, mass, and speed', () => {
    expect(conv('pressure', 'psi', 'bar')(14.5038)).toBeCloseTo(1, 5);
    expect(conv('pressure', 'hpa', 'pa')(1013.25)).toBeCloseTo(101325, 6);
    expect(conv('distance', 'mi', 'km')(1)).toBeCloseTo(1.609344, 9);
    expect(conv('distance', 'ft', 'in')(1)).toBeCloseTo(12, 9);
    expect(conv('mass', 'lb', 'kg')(1)).toBeCloseTo(0.45359237, 10);
    expect(conv('speed', 'mph', 'kph')(60)).toBeCloseTo(96.56064, 5);
  });

  it('round-trips every unit against its dimension base', () => {
    for (const [dimName, dim] of Object.entries(UNIT_DIMENSIONS)) {
      for (const unit of Object.keys(dim.units)) {
        if (unit === dim.base) continue;
        const there = conv(dimName, dim.base, unit);
        const back = conv(dimName, unit, dim.base);
        expect(back(there(42))).toBeCloseTo(42, 8);
      }
    }
  });

  it('declares a symbol for every unit', () => {
    for (const dim of Object.values(UNIT_DIMENSIONS)) {
      expect(Object.keys(dim.units)).toContain(dim.base);
      for (const u of Object.values(dim.units)) {
        expect(typeof u.symbol).toBe('string');
        expect(u.symbol.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('custom affine transform', () => {
  it('applies scale then offset', () => {
    expect(makeConverter({ dimension: CUSTOM_DIMENSION, scale: 100, offset: 0 })(0.42)).toBeCloseTo(42, 10);
    expect(makeConverter({ dimension: CUSTOM_DIMENSION, scale: 2, offset: 10 })(5)).toBe(20);
  });

  it('treats a pure-identity transform as unconfigured', () => {
    // ×1 +0 changes nothing; carrying it on the record would badge the
    // series row for a no-op.
    expect(isValidConversion({ dimension: CUSTOM_DIMENSION, scale: 1, offset: 0 })).toBe(false);
    expect(makeConverter({ dimension: CUSTOM_DIMENSION, scale: 1, offset: 0 })).toBeNull();
  });

  it('accepts offset-only and scale-only forms', () => {
    expect(isValidConversion({ dimension: CUSTOM_DIMENSION, scale: 1, offset: -5 })).toBe(true);
    expect(isValidConversion({ dimension: CUSTOM_DIMENSION, scale: 3, offset: 0 })).toBe(true);
  });
});

describe('validation', () => {
  it('rejects an identity unit pair', () => {
    expect(isValidConversion({ dimension: 'temperature', from: 'c', to: 'c' })).toBe(false);
  });

  it('rejects unknown dimensions and units', () => {
    expect(isValidConversion({ dimension: 'nope', from: 'a', to: 'b' })).toBe(false);
    expect(isValidConversion({ dimension: 'temperature', from: 'c', to: 'zz' })).toBe(false);
  });

  it('rejects empty/partial descriptors', () => {
    expect(isValidConversion(null)).toBe(false);
    expect(isValidConversion(undefined)).toBe(false);
    expect(isValidConversion({})).toBe(false);
    expect(isValidConversion({ dimension: 'temperature', from: 'c' })).toBe(false);
  });
});

describe('applyConversion over series data', () => {
  const t = { dimension: 'temperature', from: 'c', to: 'f' };

  it('converts numbers and numeric strings', () => {
    expect(applyConversion([0, 100, '21.5'], t)).toEqual([32, 212, 70.7]);
  });

  it('passes null/undefined gaps and text through untouched', () => {
    // A null gap must stay a gap — turning it into NaN would break the
    // line's gap rendering; text must never become NaN either.
    expect(applyConversion([null, undefined, 'offline'], t)).toEqual([null, undefined, 'offline']);
  });

  it('returns the SAME array reference when there is nothing to convert', () => {
    const a = [1, 2, 3];
    expect(applyConversion(a, null)).toBe(a);
    expect(applyConversion(a, { dimension: 'temperature', from: 'c', to: 'c' })).toBe(a);
  });
});

describe('symbols and labels', () => {
  it('reports the TARGET unit symbol', () => {
    expect(conversionSymbol({ dimension: 'temperature', from: 'c', to: 'f' })).toBe('°F');
    expect(conversionSymbol({ dimension: 'pressure', from: 'pa', to: 'psi' })).toBe('psi');
  });

  it('falls back to a compact transform rendering for custom', () => {
    expect(conversionSymbol({ dimension: CUSTOM_DIMENSION, scale: 100, offset: 0 })).toBe('×100');
    expect(conversionSymbol({ dimension: CUSTOM_DIMENSION, scale: 2, symbol: '%' })).toBe('%');
  });

  it('is empty for an unconfigured conversion', () => {
    expect(conversionSymbol(null)).toBe('');
    expect(conversionSymbol({ dimension: 'temperature', from: 'c', to: 'c' })).toBe('');
  });

  it('describes the conversion for the tooltip', () => {
    expect(conversionLabel({ dimension: 'temperature', from: 'c', to: 'f' })).toBe('Celsius → Fahrenheit');
  });
});

describe('distinctConversionSymbols (auto unit label)', () => {
  it('collapses series that share a target unit', () => {
    expect(distinctConversionSymbols([
      { convert: { dimension: 'temperature', from: 'c', to: 'f' } },
      { convert: { dimension: 'temperature', from: 'k', to: 'f' } },
    ])).toEqual(['°F']);
  });

  it('reports both when a chart genuinely mixes units', () => {
    // More than one symbol means no single honest tooltip label, so the
    // caller must leave the tooltip alone rather than guess.
    expect(distinctConversionSymbols([
      { convert: { dimension: 'temperature', from: 'c', to: 'f' } },
      { convert: { dimension: 'pressure', from: 'pa', to: 'psi' } },
    ])).toEqual(['°F', 'psi']);
  });

  it('ignores unconverted series', () => {
    expect(distinctConversionSymbols([{ column: 'a' }, { convert: null }])).toEqual([]);
    expect(distinctConversionSymbols(null)).toEqual([]);
  });
});

describe('normalizeConversion', () => {
  it('drops partial/identity descriptors to null', () => {
    expect(normalizeConversion(undefined)).toBeNull();
    expect(normalizeConversion({ dimension: 'temperature', from: 'c', to: 'c' })).toBeNull();
    expect(normalizeConversion({ dimension: 'bogus' })).toBeNull();
  });

  it('narrows a unit conversion to the canonical shape', () => {
    expect(normalizeConversion({ dimension: 'temperature', from: 'c', to: 'f', junk: 1 }))
      .toEqual({ dimension: 'temperature', from: 'c', to: 'f' });
  });

  it('coerces custom numerics and keeps a non-empty symbol', () => {
    expect(normalizeConversion({ dimension: CUSTOM_DIMENSION, scale: '100', offset: '5', symbol: ' % ' }))
      .toEqual({ dimension: CUSTOM_DIMENSION, scale: 100, offset: 5, symbol: '%' });
    expect(normalizeConversion({ dimension: CUSTOM_DIMENSION, scale: 100, symbol: '   ' }))
      .toEqual({ dimension: CUSTOM_DIMENSION, scale: 100, offset: 0 });
  });
});
