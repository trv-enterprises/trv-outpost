// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { describe, it, expect } from 'vitest';
import {
  xyToHex,
  colorFieldToHex,
  hexDistance,
  textColorOn,
  relativeLuminance,
  TEXT_ON_LIGHT,
  TEXT_ON_DARK,
} from './colorXY';
import { LIGHT_COLOR_PALETTE } from '../components/controls/lightPalette';

// The xy values below are not invented — they are what the real device
// reported back after each hex was written to it (recorded on issue #292),
// so these assertions pin the conversion to observed hardware behaviour.

describe('xyToHex', () => {
  it('recovers the amber the automation engine writes', () => {
    // The homelab nightlight rule publishes #ffd300; the lamp clamps it to
    // its gamut and reports xy 0.4995/0.4697.
    expect(xyToHex(0.4995, 0.4697)).toBe('#ffd300');
  });

  it('recovers a saturated blue', () => {
    // Regression guard: normalising by Y alone (rather than by the peak
    // channel) washed this out to a pale cyan, #affcff — right hue, no
    // saturation. Hue alone looks plausible, which is what made it easy to miss.
    expect(xyToHex(0.1726, 0.1422)).toBe('#547cff');
  });

  it('keeps a mid-blue saturated rather than washing it toward white', () => {
    const hex = xyToHex(0.1729, 0.2181);
    // Blue dominant, red clearly the weakest channel.
    const r = parseInt(hex.slice(1, 3), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    expect(b).toBeGreaterThan(r);
    expect(b - r).toBeGreaterThan(60);
  });

  it('reads the idle white point as near-neutral', () => {
    const hex = xyToHex(0.3257, 0.3249);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    for (const c of [r, g, b]) expect(c).toBeGreaterThan(230);
  });

  it('returns empty string for unusable input rather than NaN hex', () => {
    expect(xyToHex(0.3, 0)).toBe('');      // divide-by-zero guard
    expect(xyToHex(0.3, -0.1)).toBe('');
    expect(xyToHex(NaN, 0.3)).toBe('');
    expect(xyToHex(0.3, undefined)).toBe('');
  });

  it('always produces 7-digit hex', () => {
    for (const [x, y] of [[0.4995, 0.4697], [0.1726, 0.1422], [0.7, 0.29], [0.01, 0.01]]) {
      expect(xyToHex(x, y)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('colorFieldToHex', () => {
  it('reads the color field of a state publish', () => {
    expect(colorFieldToHex({ x: 0.4995, y: 0.4697 })).toBe('#ffd300');
  });

  it('returns empty for records with no usable color', () => {
    expect(colorFieldToHex(null)).toBe('');
    expect(colorFieldToHex(undefined)).toBe('');
    expect(colorFieldToHex({})).toBe('');
    expect(colorFieldToHex({ x: 0.5 })).toBe('');
    expect(colorFieldToHex('#ffd300')).toBe('');
  });

  it('tolerates string coordinates', () => {
    expect(colorFieldToHex({ x: '0.4995', y: '0.4697' })).toBe('#ffd300');
  });
});

describe('hexDistance', () => {
  it('is zero for identical colors and case-insensitive', () => {
    expect(hexDistance('#ffd300', '#FFD300')).toBe(0);
  });

  it('reports the largest per-channel gap', () => {
    expect(hexDistance('#000000', '#0a0000')).toBe(10);
    expect(hexDistance('#000000', '#ffffff')).toBe(255);
  });

  it('treats unparseable input as maximally distant', () => {
    expect(hexDistance('', '#ffd300')).toBe(Infinity);
    expect(hexDistance('nonsense', '#ffd300')).toBe(Infinity);
  });
});

describe('textColorOn', () => {
  // The regression this exists for: the tile hardcoded white text, so the
  // pale end of the light palette (Candle, Warm white, Cool white) rendered
  // the light's name and level as white-on-near-white.
  it('picks dark text on the pale end of the light palette', () => {
    for (const hex of ['#FFF6E5', '#FFE8C4', '#FFFFFF', '#7CFF6B', '#00E5B0']) {
      expect(textColorOn(hex), hex).toBe(TEXT_ON_LIGHT);
    }
  });

  it('still picks dark text on the deepest colors a bulb can show', () => {
    // Counterintuitive but measured: bulb colors are emissive and skew
    // bright, so even the deep end of the palette out-contrasts dark text.
    // Blue is the closest call at 4.9:1 dark vs 3.4:1 light.
    for (const hex of ['#FF3B30', '#547CFF', '#B388FF', '#FF6B35']) {
      expect(textColorOn(hex), hex).toBe(TEXT_ON_LIGHT);
    }
  });

  it('picks light text on a genuinely dark fill', () => {
    // Not reachable from LIGHT_COLOR_PALETTE, but the OS color wheel
    // (allowCustom) can produce one.
    for (const hex of ['#000000', '#1a1a2e', '#4a0072']) {
      expect(textColorOn(hex), hex).toBe(TEXT_ON_DARK);
    }
  });

  it('gives every color in the light palette a readable partner', () => {
    // Contrast ratio per WCAG 2.x. 4.5:1 is the AA threshold for body text;
    // these are short bold labels, so AA-large (3:1) is the honest bar, but
    // assert the stricter one where the palette clears it.
    const ratio = (a, b) => {
      const la = relativeLuminance(a);
      const lb = relativeLuminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    for (const { hex, name } of LIGHT_COLOR_PALETTE) {
      expect(ratio(hex, textColorOn(hex)), `${name} ${hex}`).toBeGreaterThan(4.5);
    }
  });

  it('returns null for an unusable color so callers keep their default', () => {
    expect(textColorOn('')).toBeNull();
    expect(textColorOn(undefined)).toBeNull();
    expect(textColorOn('nonsense')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  it('anchors at the sRGB endpoints', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('ranks the palette the way the eye does', () => {
    // Candle is the palest, Blue among the deepest.
    expect(relativeLuminance('#FFF6E5')).toBeGreaterThan(relativeLuminance('#547CFF'));
  });
});
