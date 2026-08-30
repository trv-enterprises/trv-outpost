// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { adornmentRect } from './AdornmentLayer';

/**
 * Border edges can land on the 1/3 and 2/3 marks inside a cell, not just on
 * cell boundaries (#309).
 *
 * The two placements are drawn differently and that difference is the whole
 * subtlety:
 *
 *   - a BOUNDARY edge grows OUTWARD into the 4px gutter, so two adjacent
 *     boxes can each take half of the same gutter without overlapping;
 *   - a FRACTIONAL edge has no gutter — it sits inside a cell, over panel
 *     content — so it CENTRES on the mark, growing equally both ways.
 *
 * Centring is what makes a pair of fractional edges read as parallel lines.
 */

const CELL = 32;
const GAP = 4;
const STRIDE = CELL + GAP; // 36
const THIRD = 1 / 3;

describe('adornmentRect — whole-cell boxes are unchanged', () => {
  // The regression that matters most: existing dashboards must not move by a
  // single pixel, and must not churn on the next save.
  const cases = [
    { a: { x: 0, y: 0, w: 1, h: 1, width: 2 }, left: -2, width: CELL },
    { a: { x: 2, y: 1, w: 3, h: 2, width: 2 }, left: 2 * STRIDE - 2, width: 3 * STRIDE - GAP },
    { a: { x: 5, y: 0, w: 1, h: 1, width: 4 }, left: 5 * STRIDE - 4, width: CELL },
  ];

  cases.forEach(({ a, left, width }) => {
    it(`x=${a.x} w=${a.w} line=${a.width} keeps its pre-#309 geometry`, () => {
      const r = adornmentRect(a);
      expect(r.left).toBe(left);
      expect(r.width).toBe(width);
    });
  });
});

describe('adornmentRect — a fractional edge centres on its mark', () => {
  it('puts the line half each side of the 1/3 mark', () => {
    const line = 2;
    const a = { x: THIRD, y: 0, w: THIRD, h: 1, width: line };
    const r = adornmentRect(a);
    const markPx = THIRD * STRIDE; // 12px
    // Line spans [mark - line/2, mark + line/2].
    expect(r.left).toBeCloseTo(markPx - line / 2, 6);
    expect(r.left + line).toBeCloseTo(markPx + line / 2, 6);
  });

  it('is symmetric on both edges, so the two lines read as parallel', () => {
    const line = 2;
    // A box spanning exactly the middle third of one cell.
    const a = { x: THIRD, y: 0, w: THIRD, h: 1, width: line };
    const r = adornmentRect(a);
    const leftMark = THIRD * STRIDE;
    const rightMark = 2 * THIRD * STRIDE;
    const leftOverhang = leftMark - r.left;
    const rightOverhang = (r.left + r.width + line) - rightMark;
    // Equal overhang each side is what "symmetric parallel lines" means.
    expect(leftOverhang).toBeCloseTo(rightOverhang, 6);
  });

  it('an even line width splits into whole pixels', () => {
    // Why the author should use 2 or 4: an odd width lands on a half-pixel
    // and one side renders a hair thicker than the other.
    for (const line of [2, 4]) {
      const r = adornmentRect({ x: THIRD, y: 0, w: THIRD, h: 1, width: line });
      expect(Number.isInteger(r.left - (THIRD * STRIDE - line / 2))).toBe(true);
    }
  });
});

describe('adornmentRect — mixed boxes stay closed', () => {
  it('handles a boundary start with a fractional end', () => {
    const line = 2;
    const a = { x: 1, y: 0, w: THIRD, h: 1, width: line };
    const r = adornmentRect(a);
    // Starts like a boundary edge (outward into the gutter)…
    expect(r.left).toBe(1 * STRIDE - line);
    // …and ends centred on the 1 1/3 mark.
    const endMark = (1 + THIRD) * STRIDE;
    expect(r.left + r.width + line).toBeCloseTo(endMark + line / 2, 6);
  });

  it('handles a fractional start with a boundary end', () => {
    const line = 2;
    const a = { x: 2 * THIRD, y: 0, w: 1 - 2 * THIRD, h: 1, width: line };
    const r = adornmentRect(a);
    const startMark = 2 * THIRD * STRIDE;
    expect(r.left).toBeCloseTo(startMark - line / 2, 6);
  });

  it('never produces a negative width', () => {
    // A degenerate box should still render as *something* rather than
    // inverting — an inverted rect paints outside its own bounds.
    for (const w of [THIRD, 2 * THIRD, 1, 2]) {
      const r = adornmentRect({ x: 0, y: 0, w, h: 1, width: 2 });
      expect(r.width).toBeGreaterThan(0);
    }
  });
});
