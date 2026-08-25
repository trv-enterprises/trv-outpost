// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { describe, it, expect } from 'vitest';
import {
  xyToHex,
  colorFieldToHex,
  hexDistance,
  holdWrittenHex,
  HEX_HOLD_TOLERANCE,
} from './colorXY';

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

  it('returns empty for records with no usable colour', () => {
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
  it('is zero for identical colours and case-insensitive', () => {
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

describe('holdWrittenHex', () => {
  it('holds the written hex while the device agrees', () => {
    // Guards against the swatch visibly shifting the instant a colour is set.
    const deviceHex = xyToHex(0.4995, 0.4697);
    expect(holdWrittenHex('#ffd300', deviceHex)).toBe('#ffd300');
  });

  it('yields to the device when an automation recolours the light', () => {
    // The engine sets colour on EVERY motion trigger, so a user-picked colour
    // gets replaced. Holding it would show a colour the light is not emitting.
    const engineAmber = xyToHex(0.4995, 0.4697);
    expect(holdWrittenHex('#547cff', engineAmber)).toBe(engineAmber);
  });

  it('falls back cleanly when either side is unknown', () => {
    expect(holdWrittenHex('', '#123456')).toBe('#123456');
    expect(holdWrittenHex('#123456', '')).toBe('#123456');
    expect(holdWrittenHex('', '')).toBe('');
  });

  it('honours the tolerance boundary', () => {
    const near = '#ffd300';
    const off = `#${(0xffd300 + 0x000000 + HEX_HOLD_TOLERANCE - 1).toString(16).padStart(6, '0')}`;
    expect(holdWrittenHex(near, off, HEX_HOLD_TOLERANCE)).toBe(near);
    // A clearly different colour is never held.
    expect(holdWrittenHex(near, '#0000ff', HEX_HOLD_TOLERANCE)).toBe('#0000ff');
  });
});
