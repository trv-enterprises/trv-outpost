// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { adornmentRect } from './AdornmentLayer';

/**
 * Border edges can land on the 1/3 and 2/3 marks inside a cell, not just on
 * cell boundaries (#309).
 *
 * Two rules make a fractional border look right, and both are easy to get
 * wrong in ways that only show up on screen:
 *
 *  1. A fraction is a fraction of the CELL BODY (32px), not of the stride
 *     (36px). The 4px gutter is dead space between cells, so a third of the
 *     stride lands a third of the way through "cell plus gutter" — visibly
 *     off-centre inside the cell the author is looking at, and the two outer
 *     gaps can then never match.
 *
 *  2. The line grows OUTWARD from the enclosed region, with the mark pixel
 *     belonging to the line — same idea as a boundary edge growing outward
 *     into the gutter. Centring the line ON the mark instead makes the
 *     enclosed area shrink as the line thickens, so the three gaps drift
 *     apart as the author changes width.
 */

const CELL = 32;
const GAP = 4;
const STRIDE = CELL + GAP; // 36
const THIRD = 1 / 3;

/** Which physical pixel columns a rect's two vertical lines occupy. */
function lineColumns(a) {
  const line = a.width || 2;
  const r = adornmentRect(a);
  const leftStart = Math.round(r.left);
  const rightStart = Math.round(r.left + line + r.width);
  return {
    leftStart,
    leftEnd: leftStart + line - 1,
    rightStart,
    rightEnd: rightStart + line - 1,
  };
}

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

describe('adornmentRect — fractions are of the cell body, not the stride', () => {
  it('places the 1/3 and 2/3 marks symmetrically within the cell', () => {
    // 1/3 of the 32px body is 10.67, which mirrors 21.33 about the cell's
    // centre (15.5). A third of the 36px STRIDE would be 12 and 24, which do
    // NOT mirror — the box would sit left of centre and the outer gaps could
    // never match.
    //
    // Measured on the marks themselves (a 1px line whose single pixel IS the
    // mark), not on the rect's outer bounds, so the line-growth rule doesn't
    // muddy what this is asserting.
    const oneThird = adornmentRect({ x: THIRD, y: 0, w: THIRD, h: 1, width: 1 });
    const markLeft = oneThird.left;
    const markRight = oneThird.left + 1 + oneThird.width;

    expect(markLeft).toBeCloseTo(THIRD * CELL, 6);
    // The two marks must be equidistant from the cell's own centre.
    const centre = CELL / 2;
    expect(centre - markLeft).toBeCloseTo(markRight - centre, 0);
  });

  it('offsets a fraction in a later cell by whole strides', () => {
    // Cell 2's 1/3 mark is 2 full strides along, then a third of the body.
    const r = adornmentRect({ x: 2 + THIRD, y: 0, w: THIRD, h: 1, width: 1 });
    expect(r.left).toBeCloseTo(2 * STRIDE + THIRD * CELL, 6);
  });
});

describe('adornmentRect — the frame grows outward, keeping the gaps symmetric', () => {
  // A box spanning the 1/3..2/3 marks of one cell. As the line thickens the
  // two OUTER gaps must stay equal to each other and the INNER gap must not
  // move — that is what reads as a symmetric frame.
  // The lines sit as close to the true thirds as whole pixels allow — that is
  // the priority. A 32px cell does not divide into three equal parts: the
  // true marks are 10.67 and 21.33, which round to pixels 11 and 21, leaving
  // 11px outside on the left and 10px on the right.
  //
  // That 1px difference is arithmetic, not a bug, and it is deliberately NOT
  // "corrected" by nudging a mark off its third — being on the third matters
  // more than the last pixel of outer symmetry. What must hold is that the
  // difference never GROWS as the line thickens.
  [1, 2, 3, 4].forEach((line) => {
    it(`keeps the outer gaps within a pixel of each other at ${line}px`, () => {
      const cols = lineColumns({ x: THIRD, y: 0, w: THIRD, h: 1, width: line });
      const outerLeft = cols.leftStart;
      const outerRight = (CELL - 1) - cols.rightEnd;
      expect(Math.abs(outerLeft - outerRight)).toBeLessThanOrEqual(1);
    });
  });

  it('puts the lines on the rounded thirds themselves', () => {
    // The marks are what the author is aiming at, so pin them explicitly:
    // the leading line's LAST pixel and the trailing line's FIRST pixel.
    const cols = lineColumns({ x: THIRD, y: 0, w: THIRD, h: 1, width: 2 });
    expect(cols.leftEnd).toBe(Math.round(THIRD * CELL));
    expect(cols.rightStart).toBe(Math.round(2 * THIRD * CELL));
  });

  it('pins the inner faces so the enclosed area does not shrink', () => {
    // The whole point of growing outward: thickening the line must not eat
    // into the region the box encloses.
    const inner = [1, 2, 3, 4].map((line) => {
      const c = lineColumns({ x: THIRD, y: 0, w: THIRD, h: 1, width: line });
      return c.rightStart - c.leftEnd - 1;
    });
    expect(new Set(inner).size).toBe(1);
  });
});

describe('adornmentRect — mixed boxes stay closed', () => {
  it('handles a boundary start with a fractional end', () => {
    const line = 2;
    const r = adornmentRect({ x: 1, y: 0, w: THIRD, h: 1, width: line });
    // Starts like a boundary edge: fully outside the content box.
    expect(r.left).toBe(1 * STRIDE - line);
    expect(r.width).toBeGreaterThan(0);
  });

  it('handles a fractional start with a boundary end', () => {
    const line = 2;
    const r = adornmentRect({ x: 2 * THIRD, y: 0, w: 1 - 2 * THIRD, h: 1, width: line });
    // The leading line's last pixel sits on the mark, so it starts line-1 back.
    expect(r.left).toBeCloseTo(2 * THIRD * CELL - (line - 1), 6);
    expect(r.width).toBeGreaterThan(0);
  });

  it('never produces a negative width', () => {
    // A degenerate box should still render as something rather than
    // inverting — an inverted rect paints outside its own bounds.
    for (const w of [THIRD, 2 * THIRD, 1, 2]) {
      const r = adornmentRect({ x: 0, y: 0, w, h: 1, width: 2 });
      expect(r.width).toBeGreaterThan(0);
    }
  });
});
